/**
 * P4.2 — Profile analysis schemas.
 *
 * `ProfileReport` is the public output of `analyzeProfile()` (and the
 * `xray profile @<handle>` CLI / `xray_profile` MCP tool). All
 * sub-shapes use Zod for runtime validation + TypeScript inference.
 *
 * Design notes:
 *   - `samplingScope: 'cache' | 'fresh'` lets future P5 work add a
 *     timeline-fetch path; P4.2 only ships the `'cache'` path. The
 *     orchestrator silently warns when `--fresh N` is passed and falls
 *     back to cache-only.
 *   - `Topic.confidence` and `StanceSummary.confidence` are coarse-
 *     grained ('low' | 'medium' | 'high') because the model output is
 *     small and a fuzzy 0-1 score would suggest false precision.
 *   - `StanceSummary.stance` enum mirrors what the spec calls out in
 *     §6 — the model occasionally emits adjacent-but-valid synonyms
 *     ("optimistic", "negative"); the orchestrator's lenient repair
 *     pass coerces those to the canonical six.
 *   - `NotableQuote.sourceUrl` + `postId` are both optional — we attach
 *     them when the snippet came from a row with a known URL/post id,
 *     and omit them when it came from a thread-body chunk we couldn't
 *     attribute precisely.
 *   - `partial` + `warnings[]` mirror the pattern in `ArticleSummary` /
 *     `VideoReport` so callers can render a "degraded result" UI.
 */
import { z } from 'zod';

export const TopicSchema = z.object({
  topic: z.string(),
  mentions: z.number().int().nonnegative(),
  confidence: z.enum(['low', 'medium', 'high']),
  representativeSnippet: z.string().optional(),
});
export type Topic = z.infer<typeof TopicSchema>;

// Note: name-spaced as `ProfileStance` to avoid collision with the
// XComment `Stance` enum (`agree | disagree | ...`) — they describe
// different things (subject opinion vs. reply relation to root claim).
export const ProfileStanceSchema = z.enum([
  'bullish',
  'bearish',
  'neutral',
  'critical',
  'enthusiastic',
  'skeptical',
]);
export type ProfileStance = z.infer<typeof ProfileStanceSchema>;

export const StanceSummarySchema = z.object({
  subject: z.string(),
  stance: ProfileStanceSchema,
  evidenceSnippets: z.array(z.string()).max(3),
  confidence: z.enum(['low', 'medium', 'high']),
});
export type StanceSummary = z.infer<typeof StanceSummarySchema>;

export const NotableQuoteSchema = z.object({
  text: z.string(),
  context: z.string().optional(),
  sourceUrl: z.string().url().optional(),
  postId: z.string().optional(),
});
export type NotableQuote = z.infer<typeof NotableQuoteSchema>;

export const ProfileSamplingScopeSchema = z.enum(['cache', 'fresh']);
export type ProfileSamplingScope = z.infer<typeof ProfileSamplingScopeSchema>;

export const ProfileReportSchema = z.object({
  handle: z.string(),
  samplingScope: ProfileSamplingScopeSchema,
  cachedThreadsAnalyzed: z.number().int().nonnegative(),
  cachedCommentsAnalyzed: z.number().int().nonnegative(),
  topics: z.array(TopicSchema),
  stance: z.array(StanceSummarySchema),
  expertiseAreas: z.array(z.string()),
  notableQuotes: z.array(NotableQuoteSchema),
  summary: z.string(),
  estimatedCostUsd: z.number().nonnegative(),
  partial: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
  generatedAt: z.string().datetime(),
});
export type ProfileReport = z.infer<typeof ProfileReportSchema>;
