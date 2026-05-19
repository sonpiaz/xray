import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeDb } from '../cache/db.ts';
import { XRayError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { closeBrowser } from '../fetcher/browser.ts';
import { research } from '../intelligence/analyze-thread.ts';
import { type ArticleAnalyzeOptions, analyzeArticle } from '../intelligence/article.ts';
import { type VideoAnalyzeOptions, analyzeVideo } from '../intelligence/video.ts';
import { renderArticleMarkdown } from '../render/article-markdown.ts';
import { renderReportMarkdown } from '../render/markdown.ts';
import { renderVideoMarkdown } from '../render/video-markdown.ts';
// P3.3 — schemas live in `./schemas.ts` so they're importable in unit
// tests without dragging in `bun:sqlite` from the cache layer. The
// server re-exports them so existing importers keep working.
import { ArticleInput, ThreadInput, VideoInput } from './schemas.ts';

export { ArticleInput, ThreadInput, VideoInput } from './schemas.ts';

const VERSION = '0.4.0';

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
        if (args.video) opts.video = true;
        if (args.articles) opts.articles = true;

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

  server.registerTool(
    'xray_video',
    {
      title: 'Analyze a video URL',
      description:
        'Download a video (X-native, YouTube, TikTok, Vimeo, LinkedIn), transcribe its audio, run vision on scene-detect frames, and synthesize a structured VideoReport. Cost surfaced via `estimatedCostUsd`.',
      inputSchema: VideoInput,
    },
    async (args) => {
      try {
        const opts: VideoAnalyzeOptions = {};
        if (args.noCache) opts.noCache = true;
        // MCP default: skip synthesis (agent caller has its own summarisation).
        // Caller opts in via synthesize=true if they want our Kyma synthesis.
        if (!args.synthesize) opts.raw = true;
        if (args.model) opts.synthesisModel = args.model;

        const report = await analyzeVideo(args.url, opts);
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
              { type: 'text', text: renderVideoMarkdown(report, { mode: 'standalone' }) },
              { type: 'text', text: JSON.stringify(report, null, 2) },
            ],
            structuredContent: report as unknown as Record<string, unknown>,
          };
        }
        return {
          content: [{ type: 'text', text: renderVideoMarkdown(report, { mode: 'standalone' }) }],
          structuredContent: report as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof XRayError ? `${err.code}: ${err.message}` : String(err);
        logger.error(`xray_video failed: ${msg}`);
        return {
          isError: true,
          content: [{ type: 'text', text: msg }],
        };
      }
    },
  );

  server.registerTool(
    'xray_article',
    {
      title: 'Analyze an article (X Article or external HTML)',
      description:
        'Fetch + parse + summarize an article, with optional tweet-context cross-reference attribution. Returns a structured ArticleSummary with body, summary, keyPoints, and optional crossReferences[]. Handles X Articles (native long-form), external HTML (Substack, Medium, dev.to, GitHub, generic blogs) via 3-tier fetch escalation. Default synthesize=true (opposite of xray_video) — agents can opt out for raw body + cross-references only.',
      inputSchema: ArticleInput,
    },
    async (args) => {
      try {
        const opts: ArticleAnalyzeOptions = { url: args.url };
        if (args.noCache) opts.noCache = true;
        // Default synthesize=true for articles (see ArticleInput.synthesize
        // for rationale). Caller sets synthesize=false to get the raw body
        // + cross-references and skip the LLM summary step.
        if (args.synthesize === false) opts.raw = true;
        if (args.model) opts.synthesisModel = args.model;
        if (args.tweetContext) {
          opts.tweetContext = {
            text: args.tweetContext,
            ...(args.tweetPostId ? { postId: args.tweetPostId } : {}),
          };
        }

        const summary = await analyzeArticle(opts);
        const format = args.format ?? 'markdown';

        if (format === 'json') {
          return {
            content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }],
            structuredContent: summary as unknown as Record<string, unknown>,
          };
        }
        if (format === 'both') {
          return {
            content: [
              { type: 'text', text: renderArticleMarkdown(summary, { mode: 'standalone' }) },
              { type: 'text', text: JSON.stringify(summary, null, 2) },
            ],
            structuredContent: summary as unknown as Record<string, unknown>,
          };
        }
        return {
          content: [{ type: 'text', text: renderArticleMarkdown(summary, { mode: 'standalone' }) }],
          structuredContent: summary as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof XRayError ? `${err.code}: ${err.message}` : String(err);
        logger.error(`xray_article failed: ${msg}`);
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
