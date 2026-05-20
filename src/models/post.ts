import { z } from 'zod';
import { XExternalLinkSchema } from './link.ts';
import { XMediaSchema } from './media.ts';

export const XAuthorSchema = z.object({
  id: z.string().optional(),
  handle: z.string(),
  displayName: z.string().optional(),
  verified: z.boolean().default(false),
  avatarUrl: z.string().url().optional(),
});
export type XAuthor = z.infer<typeof XAuthorSchema>;

export const XPostMetricsSchema = z.object({
  likes: z.number().int().nonnegative().optional(),
  reposts: z.number().int().nonnegative().optional(),
  replies: z.number().int().nonnegative().optional(),
  views: z.number().int().nonnegative().optional(),
  bookmarks: z.number().int().nonnegative().optional(),
});
export type XPostMetrics = z.infer<typeof XPostMetricsSchema>;

/**
 * v1.0.1 — Structured card payload surfaced from X's `tweet.card.binding_values`.
 *
 * X serves several card variants (X Article, summary_large_image, video_app, etc.)
 * under the same `tweet.card` slot in TweetDetail. v1.0.0 stashed the raw card
 * blob under `XPost.raw.card`, which `Zod.unknown()` preserved on construction
 * but downstream consumers couldn't introspect without re-parsing. v1.0.1 adds
 * this structured field so the article-candidate collector + summarizer can
 * pull out the canonical URL + body text without re-walking `binding_values`.
 *
 * All fields except `url` are optional — different card types ship different
 * subsets. `bodyText` is only populated for X Articles (where the body text
 * is packed into the card). `raw` preserves the original `binding_values`
 * payload so downstream debugging + future fields don't require a re-fetch.
 */
export const XArticleCardSchema = z.object({
  /** Canonical card URL (e.g. `https://x.com/i/article/<id>` for X Articles). */
  url: z.string(),
  title: z.string().optional(),
  byline: z.string().optional(),
  bodyText: z.string().optional(),
  publishedAt: z.string().optional(),
  /** Raw `binding_values` map (key → first-non-empty string) for debugging. */
  raw: z.unknown().optional(),
});
export type XArticleCard = z.infer<typeof XArticleCardSchema>;

export const XPostSchema = z.object({
  id: z.string(),
  url: z.string().url(),
  author: XAuthorSchema,
  text: z.string(),
  createdAt: z.string().datetime().optional(),
  language: z.string().optional(),
  metrics: XPostMetricsSchema.default({}),
  media: z.array(XMediaSchema).default([]),
  links: z.array(XExternalLinkSchema).default([]),
  isReply: z.boolean().default(false),
  inReplyToPostId: z.string().optional(),
  isQuote: z.boolean().default(false),
  quotedPostId: z.string().optional(),
  /**
   * v1.0.1 — Structured X card payload when present (X Articles, summary
   * cards, etc.). Absent on tweets without a card. v1.0.0 stashed this as
   * `raw.card`; v1.0.1 promotes it to a typed field so downstream code can
   * `post.card?.url` without unknown-narrowing.
   */
  card: XArticleCardSchema.optional(),
  raw: z.unknown().optional(),
});
export type XPost = z.infer<typeof XPostSchema>;
