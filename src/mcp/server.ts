import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { closeDb } from '../cache/db.ts';
import { XRayError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { closeBrowser } from '../fetcher/browser.ts';
import { research } from '../intelligence/analyze-thread.ts';
import { renderReportMarkdown } from '../render/markdown.ts';

const VERSION = '0.2.1';

const ThreadInput = {
  url: z.string().url().describe('Tweet URL (x.com/<user>/status/<id>)'),
  mode: z
    .enum(['auto', 'ssr', 'cookie', 'auth'])
    .optional()
    .describe(
      'Fetch mode. Default: auto (3-tier escalation: Chromium cookies → SSR fallback → saved auth). `ssr` forces no-auth HTML scrape, `cookie` forces cookie-injected Playwright with no fallback, `auth` uses saved storageState.',
    ),
  noCache: z.boolean().optional().describe('Skip cache for the fetch step.'),
  raw: z.boolean().optional().describe('Skip LLM analysis; return raw thread only.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe('Max reply nesting depth to walk. Default: 3.'),
  maxReplies: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe('Max top-level replies to fetch. Default: 50.'),
  deep: z
    .boolean()
    .optional()
    .describe('Run deep analysis: per-subtree Kyma calls + synthesis. ~10x cost.'),
  format: z
    .enum(['markdown', 'json', 'both'])
    .optional()
    .describe('Output format. Default: markdown (recommended for agent consumption).'),
};

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'xray', version: VERSION });

  server.registerTool(
    'xray_thread',
    {
      title: 'Research an X thread',
      description:
        'Fetch and analyze an X (Twitter) thread end-to-end. Returns a structured ResearchReport with TL;DR, summary, key insights, notable replies, and the raw thread. Uses local SQLite cache + Kyma API.',
      inputSchema: ThreadInput,
    },
    async (args) => {
      try {
        const opts: Parameters<typeof research>[1] = {};
        if (args.mode) opts.mode = args.mode;
        if (args.noCache) opts.noCache = true;
        if (args.raw) opts.skipAnalysis = true;
        if (args.depth !== undefined) opts.depth = args.depth;
        if (args.maxReplies !== undefined) opts.maxReplies = args.maxReplies;
        if (args.deep) opts.deep = true;

        const report = await research(args.url, opts);
        const format = args.format ?? 'markdown';

        if (format === 'json') {
          return {
            content: [{ type: 'text', text: JSON.stringify(report, null, 2) }],
            structuredContent: report as unknown as Record<string, unknown>,
          };
        }
        if (format === 'both') {
          return {
            content: [
              { type: 'text', text: renderReportMarkdown(report) },
              { type: 'text', text: JSON.stringify(report, null, 2) },
            ],
            structuredContent: report as unknown as Record<string, unknown>,
          };
        }
        return {
          content: [{ type: 'text', text: renderReportMarkdown(report) }],
          structuredContent: report as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof XRayError ? `${err.code}: ${err.message}` : String(err);
        logger.error(`xray_thread failed: ${msg}`);
        return {
          isError: true,
          content: [{ type: 'text', text: msg }],
        };
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('xray mcp server ready (stdio)');

  const shutdown = async () => {
    logger.info('xray mcp shutting down');
    await server.close().catch(() => undefined);
    await closeBrowser().catch(() => undefined);
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
