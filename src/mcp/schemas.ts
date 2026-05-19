/**
 * P3.3 — MCP tool input-schema definitions, extracted from
 * `src/mcp/server.ts` so unit tests can validate the Zod shapes without
 * importing the full server (which pulls in `bun:sqlite` via the cache
 * layer and breaks under Node/vitest).
 *
 * The server re-exports these objects and passes them straight into
 * `server.registerTool({ inputSchema: ThreadInput })`.
 */
import { z } from 'zod';

export const ThreadInput = {
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
  video: z
    .boolean()
    .optional()
    .describe(
      'Run video analysis on any X-native videos in the thread (~$0.05-0.50 per video, cap 3).',
    ),
  articles: z
    .boolean()
    .optional()
    .describe(
      'Run article analysis on linked content (X Articles + external links + cross-reference). Opt-in, ~$0.04-0.30 per article, cap 5 per thread.',
    ),
  format: z
    .enum(['markdown', 'json', 'both'])
    .optional()
    .describe('Output format. Default: markdown (recommended for agent consumption).'),
};

export const VideoInput = {
  url: z.string().url().describe('Video URL (X-native, YouTube, TikTok, Vimeo, LinkedIn).'),
  noCache: z
    .boolean()
    .optional()
    .describe('Skip the video cache (re-download, re-transcribe, re-analyze).'),
  synthesize: z
    .boolean()
    .optional()
    .describe(
      'Run XRay-side Kyma synthesis (topic/keyMoments/summary). DEFAULT FALSE for MCP — caller agent typically synthesises better with its own context. Set true if you want a pre-built summary and accept the ~$0.02/video cost.',
    ),
  model: z
    .string()
    .optional()
    .describe('Override Kyma synthesis model (only used if synthesize=true).'),
  format: z
    .enum(['markdown', 'json', 'both'])
    .optional()
    .describe('Output format. Default: markdown.'),
};

export const ArticleInput = {
  url: z
    .string()
    .url()
    .describe('Article URL (X Article like x.com/i/article/<id>, OR an external blog/news URL).'),
  noCache: z
    .boolean()
    .optional()
    .describe('Skip the article cache (re-fetch, re-summarize, re-cross-reference).'),
  tweetContext: z
    .string()
    .optional()
    .describe(
      'Tweet text context — when provided, runs cross-reference attribution to map tweet claims to article passages. ~$0.03-0.10 extra cost.',
    ),
  tweetPostId: z.string().optional().describe('Tweet post ID for cache keying.'),
  model: z.string().optional().describe('Override Kyma summarization model.'),
  synthesize: z.boolean().optional().describe(
    // P3.3 rationale: articles benefit from a pre-built summary because
    // human readers DO consume articles via XRay output more often than
    // they consume raw video transcripts. Agents can still opt out with
    // synthesize=false. This is the OPPOSITE default of xray_video
    // (where synthesize defaults false because agents typically
    // re-summarise video transcripts with their own context).
    'DEFAULT TRUE for xray_article (vs xray_video where it is false). Set false to return only the parsed body + cross-references without the summary step. Saves ~$0.01-0.03 per article.',
  ),
  format: z
    .enum(['markdown', 'json', 'both'])
    .optional()
    .describe('Output format. Default: markdown.'),
};
