/**
 * P3.0 — Article schemas.
 *
 * Three shapes, all Zod-validated at orchestrator boundaries so any
 * downstream renderer / cache / MCP consumer can trust the data:
 *   1. `ArticleSource`   — discriminator for which fetcher pipeline applies
 *      (`x-article` is the only path implemented in P3.0; `external-html`
 *      classifies correctly but is wired by P3.1).
 *   2. `ArticleBody`     — the raw extracted body (title + plain text +
 *      content source). Cached separately from summaries because the same
 *      body can feed multiple summarization passes (different thread
 *      contexts in P3.2).
 *   3. `ArticleSummary`  — the final orchestrator output. Includes the
 *      embedded body, the LLM summary + key points, cost surfacing fields,
 *      and a `partial` flag for graceful degradation. `crossReferences` is
 *      reserved for P3.2 — kept as an optional array so the schema bump
 *      lands without breaking P3.0 callers.
 */
import { z } from 'zod';

export const ArticleSourceSchema = z.enum(['x-article', 'external-html']);
export type ArticleSource = z.infer<typeof ArticleSourceSchema>;

/**
 * Which extraction path produced the body. P3.0 only emits `x-article-card`.
 * P3.1 adds the other three values (Readability primary, cheerio fallback,
 * Playwright SPA). Listed up-front so P3.0 schemas are forward-compatible.
 */
export const ArticleContentSourceSchema = z.enum([
  'x-article-card',
  'readability',
  'cheerio-fallback',
  'playwright',
]);
export type ArticleContentSource = z.infer<typeof ArticleContentSourceSchema>;

export const ArticleBodySchema = z.object({
  /** Article title — defaults to "Untitled" rather than failing the parse. */
  title: z.string().default('Untitled'),
  /** Author / byline line if surfaced by the source. */
  byline: z.string().optional(),
  /** ISO 8601 publish timestamp if surfaced by the source. */
  publishedAt: z.string().datetime().optional(),
  /** Word count of `text` — derived during parse, not trusted from source. */
  wordCount: z.number().int().nonnegative(),
  /** Cleaned HTML if the source carried any (often absent for X Article cards). */
  html: z.string().optional(),
  /** Plain text. Primary input for summarization downstream. */
  text: z.string(),
  /** Which extraction path produced this body. */
  contentSource: ArticleContentSourceSchema,
  /** Optional platform hint (substack/medium/devto/github/generic). P3.1 fills this in. */
  platform: z.string().optional(),
});
export type ArticleBody = z.infer<typeof ArticleBodySchema>;

/**
 * Cross-reference attribution — claim ↔ passage mapping.
 *
 * P3.0 does NOT produce these (no cross-reference stage yet). The schema
 * lands now so `ArticleSummary.crossReferences` is forward-compatible with
 * P3.2 without an additive schema bump.
 */
export const CrossReferenceRelationshipSchema = z.enum([
  'supports',
  'extends',
  'contradicts',
  'unrelated',
]);
export type CrossReferenceRelationship = z.infer<typeof CrossReferenceRelationshipSchema>;

export const CrossReferenceSchema = z.object({
  tweetClaim: z.string(),
  articlePassage: z.string(),
  relationship: CrossReferenceRelationshipSchema,
  confidence: z.number().min(0).max(1),
});
export type CrossReference = z.infer<typeof CrossReferenceSchema>;

export const ArticleCostBreakdownSchema = z.object({
  summarize: z.number().nonnegative().optional(),
  /** Reserved for P3.2 — never set in P3.0 results. */
  crossReference: z.number().nonnegative().optional(),
});
export type ArticleCostBreakdown = z.infer<typeof ArticleCostBreakdownSchema>;

export const ArticleSummarySchema = z.object({
  /** Original URL as supplied. */
  url: z.string().url(),
  /** Canonical URL after redirect / tracking-param stripping. P3.0 echoes `url`. */
  canonicalUrl: z.string().url().optional(),
  source: ArticleSourceSchema,
  body: ArticleBodySchema,
  /** LLM summary — absent on `--raw`, on Kyma key missing, or on parse-only failure. */
  summary: z.string().optional(),
  /** LLM-extracted bullets — empty on `--raw`. */
  keyPoints: z.array(z.string()).default([]),
  /**
   * P3.2 — claim ↔ passage attribution. P3.0 always produces `[]`. Kept
   * optional so the field is omittable from JSON output before P3.2 lands.
   */
  crossReferences: z.array(CrossReferenceSchema).default([]).optional(),
  /** Sum of `costBreakdown.*`. Surfaced in `--json` and at debug log level. */
  estimatedCostUsd: z.number().nonnegative().optional(),
  costBreakdown: ArticleCostBreakdownSchema.optional(),
  /** True when extraction or analysis was incomplete (paywall, missing body, etc.). */
  partial: z.boolean().default(false),
  /** Human-readable error / warning strings — never thrown. */
  errors: z.array(z.string()).default([]),
  /** ISO timestamp of when the summary was produced. */
  generatedAt: z.string().datetime(),
});
export type ArticleSummary = z.infer<typeof ArticleSummarySchema>;
