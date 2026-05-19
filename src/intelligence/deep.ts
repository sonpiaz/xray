import { z } from 'zod';
import { ParseError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { chat } from '../kyma/client.ts';
import {
  DEEP_SUBTREE_SYSTEM_PROMPT,
  DEEP_SYNTHESIS_SYSTEM_PROMPT,
  type ShallowAnalysisDigest,
  type SubtreeSummaryForSynthesis,
  renderDeepSubtreePrompt,
  renderDeepSynthesisPrompt,
} from '../kyma/prompts.ts';
import type { XComment } from '../models/comment.ts';
import type { XPost } from '../models/post.ts';
import {
  type DeepSynthesis,
  DeepSynthesisSchema,
  type SubtreeSummary,
  SubtreeSummarySchema,
} from '../models/report.ts';
import type { XThread } from '../models/thread.ts';
import { engagementScore } from './classify.ts';

/**
 * Bumped when any deep-mode prompt text changes — invalidates per-subtree /
 * per-synthesis cache entries automatically because the cache keys embed it.
 */
export const DEEP_VERSION = 1;

/**
 * Per the spec (§7.4, lines 376-382): at most 10 subtree calls + 1 synthesis
 * call in deep mode. The wider §8.3 cap of 15 calls per `research()` invocation
 * accommodates that plus the upstream classification + shallow-analyze pair.
 *
 * The spec contradicts itself slightly (§7.4 says "up to 11" total for deep
 * mode but the shallow analyze is expected to run first in our wiring); we
 * pick the LOWER number for the deep-mode-only budget — 10 subtree calls —
 * and surface cap-hit as a warning rather than an error.
 */
export const MAX_SUBTREE_CALLS = 10;

const DeepSubtreeResponseSchema = z.object({
  headline: z.string(),
  keyPoints: z.array(z.string()).default([]),
  dissent: z.array(z.string()).default([]),
});

export type DeepOutcome = {
  subtreeSummaries: SubtreeSummary[];
  /** Present only when the synthesis call succeeded. */
  deepSynthesis?: DeepSynthesis;
  subtreeCallCount: number;
  synthesisCallCount: number;
  warnings: string[];
};

function stripJsonFence(s: string): string {
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/);
  if (fence?.[1]) return fence[1].trim();
  return s.trim();
}

/**
 * Flatten the descendants of a subtree root in DFS order (excluding the root itself).
 */
export function flattenSubtreeDescendants(root: XComment): XComment[] {
  const out: XComment[] = [];
  const walk = (list: XComment[]): void => {
    for (const c of list) {
      out.push(c);
      if (c.replies.length > 0) walk(c.replies);
    }
  };
  walk(root.replies);
  return out;
}

/**
 * Group the thread's top-level replies into subtrees ordered by engagement score
 * (descending), capped at `MAX_SUBTREE_CALLS`. Ties are broken by original DFS
 * position so cache keys remain deterministic.
 *
 * "Meaningful" filter: we keep any top-level reply that has either non-zero
 * engagement OR ≥1 nested reply. Pure-noise top-level replies (0 likes, 0
 * replies, unverified author) are skipped — they don't earn a Kyma call.
 */
export function selectSubtrees(
  topLevelReplies: XComment[],
  limit: number = MAX_SUBTREE_CALLS,
): XComment[] {
  if (topLevelReplies.length === 0) return [];
  const decorated = topLevelReplies
    .map((c, idx) => ({ c, idx, score: engagementScore(c) }))
    .filter(({ c, score }) => score > 0 || c.replies.length > 0);
  decorated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  return decorated.slice(0, limit).map((d) => d.c);
}

export function deepSubtreeCacheKey(commentId: string): string {
  return `deep-subtree:${commentId}:${DEEP_VERSION}`;
}

export function deepSynthesisCacheKey(rootPostId: string): string {
  return `deep-synth:${rootPostId}:${DEEP_VERSION}`;
}

/** Single Kyma call for one subtree. Throws ParseError on malformed output. */
async function summarizeSubtree(rootPost: XPost, subtreeRoot: XComment): Promise<SubtreeSummary> {
  const descendants = flattenSubtreeDescendants(subtreeRoot);
  const userMsg = renderDeepSubtreePrompt(rootPost, subtreeRoot, descendants);

  const result = await chat({
    messages: [
      { role: 'system', content: DEEP_SUBTREE_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    jsonMode: true,
    temperature: 0.3,
    maxTokens: 1200,
    cacheKey: deepSubtreeCacheKey(subtreeRoot.id),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(result.content));
  } catch (err) {
    throw new ParseError(
      `Kyma deep-subtree returned non-JSON: ${result.content.slice(0, 200)}`,
      err,
    );
  }

  const validated = DeepSubtreeResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ParseError(`Kyma deep-subtree failed schema: ${validated.error.message}`);
  }

  const summary: SubtreeSummary = {
    rootReplyPostId: subtreeRoot.id,
    rootReplyHandle: subtreeRoot.author.handle,
    // +1 to include the subtree root itself in the count.
    replyCount: descendants.length + 1,
    headline: validated.data.headline,
    keyPoints: validated.data.keyPoints,
    dissent: validated.data.dissent,
  };
  // Re-validate via the canonical schema so downstream consumers get a known-good shape.
  return SubtreeSummarySchema.parse(summary);
}

/** Final cross-subtree synthesis call. Throws ParseError on malformed output. */
async function synthesize(
  rootPost: XPost,
  shallow: ShallowAnalysisDigest,
  summaries: SubtreeSummary[],
): Promise<DeepSynthesis> {
  const forPrompt: SubtreeSummaryForSynthesis[] = summaries.map((s) => ({
    rootReplyPostId: s.rootReplyPostId,
    rootReplyHandle: s.rootReplyHandle,
    replyCount: s.replyCount,
    headline: s.headline,
    keyPoints: s.keyPoints,
    dissent: s.dissent,
  }));

  const userMsg = renderDeepSynthesisPrompt(rootPost, shallow, forPrompt);

  const result = await chat({
    messages: [
      { role: 'system', content: DEEP_SYNTHESIS_SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
    jsonMode: true,
    temperature: 0.3,
    maxTokens: 2000,
    cacheKey: deepSynthesisCacheKey(rootPost.id),
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(result.content));
  } catch (err) {
    throw new ParseError(
      `Kyma deep-synthesis returned non-JSON: ${result.content.slice(0, 200)}`,
      err,
    );
  }

  const validated = DeepSynthesisSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ParseError(`Kyma deep-synthesis failed schema: ${validated.error.message}`);
  }
  return validated.data;
}

/**
 * Top-level entry point for deep mode.
 *
 * Inputs:
 *  - `thread` — already enriched by P1.1 + P1.2 (classifications attached where they fit).
 *  - `shallow` — the digest of the just-completed shallow `analyzeThread` call, threaded
 *    into the synthesis prompt so the deep report explicitly builds on the shallow one.
 *
 * Flow:
 *  1. Select top-N top-level replies as subtree roots (engagement-ranked, cap 10).
 *  2. Fire one Kyma call per subtree (`DEEP_SUBTREE_PROMPT`). Failures are isolated:
 *     other subtrees still surface, and a `Partial: deep subtree …` warning is emitted.
 *  3. If at least one subtree summary succeeded, run the synthesis call
 *     (`DEEP_SYNTHESIS_PROMPT`). Synthesis failure → warning, no `deepSynthesis` field.
 */
export async function deepAnalyze(
  thread: XThread,
  shallow: ShallowAnalysisDigest,
): Promise<DeepOutcome> {
  const warnings: string[] = [];

  if (thread.comments.length === 0) {
    return {
      subtreeSummaries: [],
      subtreeCallCount: 0,
      synthesisCallCount: 0,
      warnings: [],
    };
  }

  const candidatePool = thread.comments.length;
  const subtrees = selectSubtrees(thread.comments);
  const skipped = candidatePool - subtrees.length;

  if (skipped > 0) {
    if (candidatePool > MAX_SUBTREE_CALLS) {
      warnings.push(
        `Partial: deep mode analyzed top ${subtrees.length} of ${candidatePool} top-level replies by engagement (${skipped} skipped — cap ${MAX_SUBTREE_CALLS}).`,
      );
    } else {
      warnings.push(
        `Partial: deep mode skipped ${skipped} of ${candidatePool} top-level replies (no engagement, no nested replies).`,
      );
    }
  }

  logger.debug('deep subtree selection', {
    candidatePool,
    selected: subtrees.length,
    cap: MAX_SUBTREE_CALLS,
  });

  const subtreeSummaries: SubtreeSummary[] = [];
  let subtreeCallCount = 0;

  for (const subtreeRoot of subtrees) {
    try {
      const summary = await summarizeSubtree(thread.rootPost, subtreeRoot);
      subtreeSummaries.push(summary);
      subtreeCallCount += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.debug('deep subtree call failed', {
        subtreeRootId: subtreeRoot.id,
        reason,
      });
      warnings.push(
        `Partial: deep subtree @${subtreeRoot.author.handle} (id=${subtreeRoot.id}) failed — ${reason}`,
      );
      // Continue: one bad subtree must not poison the rest.
    }
  }

  if (subtreeSummaries.length === 0) {
    warnings.push('Deep mode: no subtree summaries produced — synthesis skipped.');
    return {
      subtreeSummaries,
      subtreeCallCount,
      synthesisCallCount: 0,
      warnings,
    };
  }

  let deepSynthesis: DeepSynthesis | undefined;
  let synthesisCallCount = 0;
  try {
    deepSynthesis = await synthesize(thread.rootPost, shallow, subtreeSummaries);
    synthesisCallCount = 1;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.debug('deep synthesis call failed', { reason });
    warnings.push(`Partial: deep synthesis failed — ${reason}`);
  }

  return {
    subtreeSummaries,
    ...(deepSynthesis ? { deepSynthesis } : {}),
    subtreeCallCount,
    synthesisCallCount,
    warnings,
  };
}
