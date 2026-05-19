import { z } from 'zod';
import { ParseError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { chat } from '../kyma/client.ts';
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  MAX_REPLIES_IN_PROMPT,
  renderClassificationPrompt,
} from '../kyma/prompts.ts';
import { CommentClassificationSchema, type XComment } from '../models/comment.ts';
import type { XPost } from '../models/post.ts';
import type { StanceDistribution } from '../models/report.ts';
import type { XThread } from '../models/thread.ts';

/**
 * Bumped when the classification prompt text changes — invalidates per-comment
 * cache entries automatically because the cache key contains this version.
 */
export const CLASSIFY_VERSION = 1;

/**
 * Hard cap on classification calls per `research()` invocation.
 *
 * P1.2: dropped from 2 → 1. With the engagement pre-filter in front of the batch,
 * one call covers the top MAX_REPLIES_IN_PROMPT (40) most-engaged replies — the
 * tail of low-engagement comments isn't worth a second Kyma call in shallow mode.
 * Deep mode (P1.3) gets its own per-subtree budget that bypasses this constant.
 */
export const MAX_CLASSIFY_CALLS = 1;

const ClassificationItemSchema = CommentClassificationSchema.extend({
  id: z.string(),
});

const ClassificationResponseSchema = z.object({
  classifications: z.array(ClassificationItemSchema),
});

export type ClassifyOutcome = {
  classifiedCount: number;
  callCount: number;
  warnings: string[];
  /**
   * P1.2: prefilter telemetry. Populated when the engagement pre-filter ran
   * (i.e., total fetched > MAX_REPLIES_IN_PROMPT). Folded into
   * `coverage.prefilter*` fields by `research()`.
   */
  prefilterApplied: boolean;
  candidatePool: number;
  classifiedFromPool: number;
};

/**
 * P1.2 engagement score used to rank candidate comments before the single
 * shallow-mode classification call.
 *
 * Formula (intentionally simple — tune later from feedback):
 *   likes + 2 * reply_count + (verified ? 50 : 0)
 *
 * Why this shape:
 *  - `likes` is the cheapest proxy for "people thought this was useful".
 *  - `reply_count` is weighted 2x because a comment that sparks a sub-thread
 *    is a stronger conversational signal than a passive like.
 *  - The +50 verified-author boost surfaces blue-check responses that often
 *    get drowned by viral-but-shallow replies in the raw like ranking.
 *
 * We intentionally do NOT use views (often absent on nested replies) and
 * keep weights small integers so the ordering is easy to reason about in
 * logs and tests.
 */
export function engagementScore(c: XComment): number {
  const likes = c.metrics.likes ?? 0;
  const replyCount = c.replies.length;
  const verifiedBoost = c.author.verified ? 50 : 0;
  return likes + 2 * replyCount + verifiedBoost;
}

/**
 * P1.2 engagement-based pre-filter. Sorts the flattened comment list by
 * `engagementScore` descending and returns the top `limit` (defaults to
 * MAX_REPLIES_IN_PROMPT).
 *
 * Stable-ish: ties are broken by original DFS position (we use a stable sort
 * over an index-decorated array) so cache keys stay deterministic when two
 * comments have identical engagement.
 *
 * Skipped by the caller when `comments.length <= limit` — there's no point
 * sorting a list that fits in a single batch.
 */
export function prefilterByEngagement(
  comments: XComment[],
  limit: number = MAX_REPLIES_IN_PROMPT,
): XComment[] {
  if (comments.length <= limit) return comments;
  const decorated = comments.map((c, idx) => ({ c, idx, score: engagementScore(c) }));
  decorated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx; // stable: preserve DFS order on ties
  });
  return decorated.slice(0, limit).map((d) => d.c);
}

function stripJsonFence(s: string): string {
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fence?.[1]) return fence[1].trim();
  return s.trim();
}

/**
 * Flatten the (possibly nested) reply tree to a single array of XComment refs.
 * We return references (not copies) so mutating `.classification` propagates back into the tree.
 */
export function flattenComments(comments: XComment[]): XComment[] {
  const out: XComment[] = [];
  const walk = (list: XComment[]): void => {
    for (const c of list) {
      out.push(c);
      if (c.replies.length > 0) walk(c.replies);
    }
  };
  walk(comments);
  return out;
}

/**
 * P1.2 chunking: callers pass the (already prefiltered) comment set. We split
 * into chunks of MAX_REPLIES_IN_PROMPT (40), capped at MAX_CLASSIFY_CALLS — in
 * shallow mode that's a single chunk because the prefilter already capped at 40.
 *
 * Kept exported so deep mode (P1.3) and tests can reuse the chunk-budget math.
 */
export function chunkForClassification(comments: XComment[]): XComment[][] {
  if (comments.length === 0) return [];
  const chunks: XComment[][] = [];
  const cap = MAX_CLASSIFY_CALLS * MAX_REPLIES_IN_PROMPT;
  const eligible = comments.slice(0, cap);
  for (let i = 0; i < eligible.length; i += MAX_REPLIES_IN_PROMPT) {
    chunks.push(eligible.slice(i, i + MAX_REPLIES_IN_PROMPT));
  }
  return chunks;
}

export function classifyCacheKey(commentId: string): string {
  return `comment-classify:${commentId}:${CLASSIFY_VERSION}`;
}

/**
 * Classify a single batch via Kyma. Returns the parsed array indexed by id.
 * Throws ParseError on malformed model output — caller decides whether to surface or swallow.
 */
async function classifyBatch(
  rootPost: XPost,
  batch: XComment[],
): Promise<Map<string, z.infer<typeof ClassificationItemSchema>>> {
  // Composite cache key for the batch = join of per-comment keys (deterministic order).
  const batchCacheKey = `comment-classify-batch:${CLASSIFY_VERSION}:${batch
    .map((c) => c.id)
    .sort()
    .join(',')}`;

  const userMsg = renderClassificationPrompt(rootPost, batch);

  const result = await chat({
    messages: [
      { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 2000,
    cacheKey: batchCacheKey,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(result.content));
  } catch (err) {
    throw new ParseError(
      `Kyma classification returned non-JSON: ${result.content.slice(0, 200)}`,
      err,
    );
  }

  const validated = ClassificationResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ParseError(`Kyma classification failed schema: ${validated.error.message}`);
  }

  const byId = new Map<string, z.infer<typeof ClassificationItemSchema>>();
  for (const item of validated.data.classifications) {
    byId.set(item.id, item);
  }
  return byId;
}

/**
 * Top-level entry point. Mutates `thread.comments` in place by attaching `.classification`
 * to each successfully-classified comment. Also persists per-comment results to the kyma cache
 * keyed by `comment-classify:{id}:{version}` for fast hydration on the next run.
 *
 * Single-batch by default; splits into at most `MAX_CLASSIFY_CALLS` calls. Comments beyond
 * that ceiling are not classified this run (warning emitted).
 *
 * Returns an outcome summary the caller folds into `coverage.classifiedReplies` + warnings.
 */
export async function classifyComments(thread: XThread): Promise<ClassifyOutcome> {
  const flat = flattenComments(thread.comments);
  if (flat.length === 0) {
    return {
      classifiedCount: 0,
      callCount: 0,
      warnings: [],
      prefilterApplied: false,
      candidatePool: 0,
      classifiedFromPool: 0,
    };
  }

  // P1.2: in shallow mode we pre-filter by engagement before chunking. When the
  // total fetched set already fits in a single batch we skip the sort entirely
  // (no point reordering a list that fits as-is) and `prefilterApplied` stays false.
  const prefilterApplied = flat.length > MAX_REPLIES_IN_PROMPT;
  const candidatePool = flat.length;
  const candidates = prefilterApplied ? prefilterByEngagement(flat) : flat;

  if (prefilterApplied) {
    logger.debug('classification prefilter applied', {
      candidatePool,
      batchSize: candidates.length,
      formula: 'likes + 2*replies + (verified ? 50 : 0)',
    });
  } else {
    logger.debug('classification prefilter skipped — fetched set fits in single batch', {
      candidatePool,
    });
  }

  const batches = chunkForClassification(candidates);
  const warnings: string[] = [];
  let classifiedCount = 0;
  let callCount = 0;

  const skipped = flat.length - batches.reduce((sum, b) => sum + b.length, 0);
  if (skipped > 0) {
    warnings.push(
      `Partial: classified top ${batches.reduce((s, b) => s + b.length, 0)} of ${flat.length} replies by engagement (${skipped} skipped — shallow-mode prefilter).`,
    );
  }

  for (const batch of batches) {
    let batchResults: Map<string, z.infer<typeof ClassificationItemSchema>>;
    try {
      batchResults = await classifyBatch(thread.rootPost, batch);
      callCount += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.debug('classification batch failed', { reason, batchSize: batch.length });
      warnings.push(`Partial: classification batch failed (${batch.length} replies) — ${reason}`);
      continue;
    }

    for (const c of batch) {
      const item = batchResults.get(c.id);
      if (!item) continue;
      c.classification = {
        stance: item.stance,
        quality: item.quality,
        qualityScore: item.qualityScore,
      };
      classifiedCount += 1;
    }
  }

  return {
    classifiedCount,
    callCount,
    warnings,
    prefilterApplied,
    candidatePool,
    classifiedFromPool: classifiedCount,
  };
}

export function computeStanceDistribution(thread: XThread): StanceDistribution {
  const dist: StanceDistribution = {
    agree: 0,
    disagree: 0,
    neutral: 0,
    question: 0,
    humor: 0,
    meta: 0,
  };
  for (const c of flattenComments(thread.comments)) {
    if (!c.classification) continue;
    dist[c.classification.stance] += 1;
  }
  return dist;
}
