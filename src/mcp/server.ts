import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeDb } from '../cache/db.ts';
import { XRayError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { closeBrowser } from '../fetcher/browser.ts';
import { research } from '../intelligence/analyze-thread.ts';
import { type ArticleAnalyzeOptions, analyzeArticle } from '../intelligence/article.ts';
import { type ProfileAnalyzeOptions, analyzeProfile } from '../intelligence/profile.ts';
import { type VideoAnalyzeOptions, analyzeVideo } from '../intelligence/video.ts';
import { renderArticleMarkdown } from '../render/article-markdown.ts';
import { renderReportMarkdown } from '../render/markdown.ts';
import { renderProfileMarkdown } from '../render/profile-markdown.ts';
import { renderSearchMarkdown } from '../render/search-markdown.ts';
import { renderVideoMarkdown } from '../render/video-markdown.ts';
import { type SearchOptions, search } from '../search/search.ts';
// P3.3 — schemas live in `./schemas.ts` so they're importable in unit
// tests without dragging in `bun:sqlite` from the cache layer. The
// server re-exports them so existing importers keep working.
import { ArticleInput, ProfileInput, SearchInput, ThreadInput, VideoInput } from './schemas.ts';

export { ArticleInput, ProfileInput, SearchInput, ThreadInput, VideoInput } from './schemas.ts';

export const VERSION = '1.0.0';

/**
 * P5.1 — Per-tool semantic version surfaced via the MCP `_meta` passthrough
 * channel. Stamped on every `registerTool()` config so a `tools/list` JSON-
 * RPC response exposes `_meta.version` to MCP clients. Independent of the
 * top-level server `VERSION` so a single tool can ship a breaking change
 * (e.g. `xray_search` v2) without rev'ing the whole server. v1.0 marks the
 * tool contracts as stable per CONTRIBUTING.md breaking-change protocol.
 *
 * Kept as the string '1.0' (not '1.0.0') because tool versions track schema
 * compatibility (major.minor), independent of the package's MAJOR.MINOR.PATCH.
 */
export const TOOL_VERSION = '1.0';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'xray', version: VERSION });

  server.registerTool(
    'xray_thread',
    {
      title: 'Research an X thread',
      description:
        'Fetch and analyze an X (Twitter) thread end-to-end. Returns a structured ResearchReport with TL;DR, summary, key insights, notable replies, and the raw thread. Uses local SQLite cache + Kyma API.',
      inputSchema: ThreadInput,
      _meta: { version: TOOL_VERSION },
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
      _meta: { version: TOOL_VERSION },
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
      _meta: { version: TOOL_VERSION },
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

  server.registerTool(
    'xray_search',
    {
      title: 'Semantic search across cached XRay content',
      description:
        'Embeds the query locally with MiniLM-L6-v2 and finds the most similar cached items (comments, posts, article passages) by cosine similarity. Searches your local XRay cache only — run `xray cache embed` after `xray thread` to populate the embedding index. Optional `rerank=true` adds a Kyma chat pass to reorder the top candidates (~$0.005). Without rerank: $0.',
      inputSchema: SearchInput,
      _meta: { version: TOOL_VERSION },
    },
    async (args) => {
      try {
        const opts: SearchOptions = { query: args.query };
        if (args.limit !== undefined) opts.limit = args.limit;
        if (args.threshold !== undefined) opts.threshold = args.threshold;
        if (args.type !== undefined) opts.typeFilter = args.type;
        if (args.rerank) opts.rerank = true;

        const response = await search(opts);
        const format = args.format ?? 'markdown';

        if (format === 'json') {
          return {
            content: [{ type: 'text', text: JSON.stringify(response, null, 2) }],
            structuredContent: response as unknown as Record<string, unknown>,
          };
        }
        if (format === 'both') {
          return {
            content: [
              { type: 'text', text: renderSearchMarkdown(response) },
              { type: 'text', text: JSON.stringify(response, null, 2) },
            ],
            structuredContent: response as unknown as Record<string, unknown>,
          };
        }
        return {
          content: [{ type: 'text', text: renderSearchMarkdown(response) }],
          structuredContent: response as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof XRayError ? `${err.code}: ${err.message}` : String(err);
        logger.error(`xray_search failed: ${msg}`);
        return {
          isError: true,
          content: [{ type: 'text', text: msg }],
        };
      }
    },
  );

  server.registerTool(
    'xray_profile',
    {
      title: 'Build a profile from cached XRay content for an X handle',
      description:
        'Aggregates every cached post + comment authored by the given X handle and synthesizes a ProfileReport via 3 Kyma calls (topics + expertise, stance, notable quotes + summary). Cache-only — populate the cache with `xray thread` on their posts first. 24h cache via `profile_cache`. ~$0.05-0.20 per profile. The `fresh` arg is reserved for P5+ and currently logs a warning + falls back to cache-only.',
      inputSchema: ProfileInput,
      _meta: { version: TOOL_VERSION },
    },
    async (args) => {
      try {
        const opts: ProfileAnalyzeOptions = { handle: args.handle };
        if (args.noCache) opts.noCache = true;
        if (args.fresh !== undefined) opts.fresh = args.fresh;
        if (args.model) opts.synthesisModel = args.model;

        const report = await analyzeProfile(opts);
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
              { type: 'text', text: renderProfileMarkdown(report) },
              { type: 'text', text: JSON.stringify(report, null, 2) },
            ],
            structuredContent: report as unknown as Record<string, unknown>,
          };
        }
        return {
          content: [{ type: 'text', text: renderProfileMarkdown(report) }],
          structuredContent: report as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const msg = err instanceof XRayError ? `${err.code}: ${err.message}` : String(err);
        logger.error(`xray_profile failed: ${msg}`);
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
