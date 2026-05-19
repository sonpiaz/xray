import type { Page } from 'playwright';
import { logger } from '../core/logger.ts';
import type { XComment } from '../models/comment.ts';
import {
  type ExtractedCursors,
  type NestedShowMoreCursor,
  type ParsedDetail,
  extractCursors,
  parseTweetDetail,
} from './parser.ts';

/** Status bucket for ThreadCoverage. */
export type CoverageStatus = 'ok' | 'partial' | 'failed';

export type WalkCoverage = {
  targetDepth: number;
  achievedDepth: number;
  targetReplies: number;
  fetchedReplies: number;
  paginationCursors: string[];
  status: CoverageStatus;
  failureReason?: string;
};

export type WalkOptions = {
  /** Max top-level replies to accumulate (spec default 50). */
  maxReplies: number;
  /** Max nested-reply depth to expand (spec default 3). */
  depth: number;
  /** Hard cap on total milliseconds spent paginating (spec default 60s). */
  totalTimeoutMs?: number;
  /** Delay between successive GraphQL fetches inside the page context. */
  paginationDelayMs?: number;
  /** Hard cap on the number of GraphQL calls (defensive). */
  maxRequests?: number;
};

export type PaginationContext = {
  /** Full TweetDetail URL captured from the initial response (incl. queryId and variables). */
  url: string;
  /** Request headers harvested from the initial TweetDetail request (auth-token, csrf, etc.). */
  headers: Record<string, string>;
};

/**
 * Defaults aligned with PHASE_1_PLAN.md §6.3.
 */
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_DELAY_MS = 500;
const DEFAULT_MAX_REQUESTS = 30;
const EMPTY_PAGE_STREAK_LIMIT = 3;

/**
 * Walk the reply tree by replaying TweetDetail GraphQL calls inside the
 * already-authenticated page context. Mutates `aggregate.comments` to attach
 * nested replies via `replies[]`, and returns coverage metadata.
 *
 * Caller is responsible for the initial navigation + initial-page parse.
 */
export async function walkReplyTree(
  page: Page,
  rootId: string,
  aggregate: ParsedDetail,
  seenIds: Set<string>,
  initialCursors: ExtractedCursors,
  ctx: PaginationContext | undefined,
  options: WalkOptions,
): Promise<WalkCoverage> {
  const coverage: WalkCoverage = {
    targetDepth: options.depth,
    achievedDepth: 0,
    targetReplies: options.maxReplies,
    fetchedReplies: aggregate.comments.length,
    paginationCursors: [],
    status: 'ok',
  };

  if (!ctx) {
    // We never observed a TweetDetail request, so we can't replay one. Still
    // attach any nested replies we may already have from the initial parse.
    attachInitialNested(aggregate);
    coverage.achievedDepth = computeAchievedDepth(aggregate.comments);
    coverage.fetchedReplies = countAllComments(aggregate.comments);
    coverage.status = determineStatus(coverage);
    return coverage;
  }

  const startedAt = Date.now();
  const deadline = startedAt + (options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
  const delayMs = options.paginationDelayMs ?? DEFAULT_DELAY_MS;
  const maxRequests = options.maxRequests ?? DEFAULT_MAX_REQUESTS;
  let requestsMade = 0;

  let bottom = initialCursors.bottom;
  const showMore: NestedShowMoreCursor[] = [...initialCursors.showMore];
  let emptyStreak = 0;

  // -- Phase A: paginate top-level replies via Bottom cursor.
  while (
    bottom &&
    aggregate.comments.length < options.maxReplies &&
    Date.now() < deadline &&
    requestsMade < maxRequests
  ) {
    if (delayMs > 0) await page.waitForTimeout(delayMs).catch(() => undefined);
    const before = aggregate.comments.length;
    const next = await fetchAndMerge(page, ctx, bottom, rootId, aggregate, seenIds);
    requestsMade += 1;
    if (!next) {
      coverage.status = 'partial';
      coverage.failureReason = coverage.failureReason ?? 'pagination fetch failed';
      break;
    }
    coverage.paginationCursors.push(bottom);
    const gained = aggregate.comments.length - before;
    if (gained === 0) {
      emptyStreak += 1;
      if (emptyStreak >= EMPTY_PAGE_STREAK_LIMIT) break;
    } else {
      emptyStreak = 0;
    }
    // Update cursors from the latest response.
    bottom = next.bottom;
    for (const sm of next.showMore) showMore.push(sm);
    if (!bottom) break;
  }

  // -- Phase B: walk ShowMore (nested) cursors up to `depth`.
  let achievedDepth = computeAchievedDepth(aggregate.comments);
  emptyStreak = 0;
  while (showMore.length > 0 && Date.now() < deadline && requestsMade < maxRequests) {
    const cursor = showMore.shift();
    if (!cursor) break;
    if (cursor.depth > options.depth) continue;
    if (delayMs > 0) await page.waitForTimeout(delayMs).catch(() => undefined);
    const beforeTotal = countAllComments(aggregate.comments);
    const next = await fetchAndMerge(page, ctx, cursor.value, rootId, aggregate, seenIds, cursor);
    requestsMade += 1;
    if (!next) {
      coverage.status = 'partial';
      coverage.failureReason = coverage.failureReason ?? 'nested fetch failed';
      continue;
    }
    coverage.paginationCursors.push(cursor.value);
    const gainedTotal = countAllComments(aggregate.comments) - beforeTotal;
    if (gainedTotal === 0) {
      emptyStreak += 1;
      if (emptyStreak >= EMPTY_PAGE_STREAK_LIMIT) break;
    } else {
      emptyStreak = 0;
      achievedDepth = Math.max(achievedDepth, cursor.depth);
    }
    for (const sm of next.showMore) {
      // Only enqueue cursors whose target depth is still within budget.
      if (sm.depth <= options.depth) showMore.push(sm);
    }
  }

  // Final tree attach pass: turn any flat nested-depth comments still sitting at
  // the top level into children of their inReplyTo parent where possible.
  attachInitialNested(aggregate);

  coverage.fetchedReplies = countAllComments(aggregate.comments);
  coverage.achievedDepth = Math.max(achievedDepth, computeAchievedDepth(aggregate.comments));
  coverage.status = determineStatus(coverage);
  if (requestsMade >= maxRequests && coverage.status === 'ok') {
    coverage.status = 'partial';
    coverage.failureReason = `hit max request cap (${maxRequests})`;
  }
  if (Date.now() >= deadline && coverage.status === 'ok') {
    coverage.status = 'partial';
    coverage.failureReason = `pagination timed out after ${options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS}ms`;
  }
  return coverage;
}

/**
 * Replay the TweetDetail GraphQL call with a new cursor inside the page
 * context. Reuses the browser's cookies/CSRF. Merges results into aggregate.
 */
async function fetchAndMerge(
  page: Page,
  ctx: PaginationContext,
  cursor: string,
  rootId: string,
  aggregate: ParsedDetail,
  seenIds: Set<string>,
  nestedParent?: NestedShowMoreCursor,
): Promise<ExtractedCursors | undefined> {
  const url = rewriteCursor(ctx.url, cursor);
  try {
    const payload = await page.evaluate(
      async (args: { u: string; h: Record<string, string> }) => {
        const res = await fetch(args.u, { method: 'GET', headers: args.h, credentials: 'include' });
        if (!res.ok) throw new Error(`status ${res.status}`);
        return await res.json();
      },
      { u: url, h: ctx.headers },
    );
    const parsed = parseTweetDetail(payload, rootId);
    mergeParsed(aggregate, parsed, seenIds, nestedParent);
    return extractCursors(payload);
  } catch (err) {
    logger.debug('pagination fetch failed', { cursor: cursor.slice(0, 24), err: String(err) });
    return undefined;
  }
}

/**
 * Rewrite the `cursor` field inside the GraphQL `variables` query param.
 * If the URL doesn't already encode a cursor, we inject one.
 */
export function rewriteCursor(url: string, cursor: string): string {
  try {
    const u = new URL(url);
    const rawVars = u.searchParams.get('variables');
    if (!rawVars) return url;
    let vars: Record<string, unknown>;
    try {
      vars = JSON.parse(rawVars) as Record<string, unknown>;
    } catch {
      return url;
    }
    vars.cursor = cursor;
    u.searchParams.set('variables', JSON.stringify(vars));
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Merge a parsed page into the aggregate. New top-level comments get appended;
 * a non-root nestedParent hint causes parser-extracted comments to be attached
 * as children of the matching parent comment when possible.
 */
function mergeParsed(
  target: ParsedDetail,
  src: ParsedDetail,
  seen: Set<string>,
  nestedParent?: NestedShowMoreCursor,
): void {
  if (src.rootPost && !target.rootPost) target.rootPost = src.rootPost;
  for (const p of src.authorPosts) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    target.authorPosts.push(p);
  }
  for (const q of src.quoteTweets) {
    if (seen.has(q.id)) continue;
    seen.add(q.id);
    target.quoteTweets.push(q);
  }
  for (const c of src.comments) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (nestedParent?.parentPostId) {
      const attached = attachReplyToParent(target.comments, nestedParent.parentPostId, c);
      if (attached) continue;
    }
    target.comments.push(c);
  }
}

/**
 * Walk the existing reply tree and attach `child` under the first comment whose
 * id matches parentId. Returns true if attached.
 */
function attachReplyToParent(comments: XComment[], parentId: string, child: XComment): boolean {
  for (const c of comments) {
    if (c.id === parentId) {
      child.depth = c.depth + 1;
      c.replies.push(child);
      return true;
    }
    if (c.replies.length > 0 && attachReplyToParent(c.replies, parentId, child)) return true;
  }
  return false;
}

/**
 * Post-process: any flat comment that has `inReplyToPostId` pointing to another
 * fetched comment (not the root) should be hoisted into that parent's
 * `replies[]`. This handles the case where nested replies arrive alongside
 * top-level replies on the initial page.
 */
function attachInitialNested(aggregate: ParsedDetail): void {
  if (!aggregate.rootPost) return;
  const rootId = aggregate.rootPost.id;
  const flat = aggregate.comments;
  const idIndex = new Map<string, XComment>();
  for (const c of flat) idIndex.set(c.id, c);

  const keep: XComment[] = [];
  for (const c of flat) {
    const parentId = c.inReplyToPostId;
    if (parentId && parentId !== rootId && idIndex.has(parentId) && parentId !== c.id) {
      const parent = idIndex.get(parentId);
      if (parent && parent !== c) {
        c.depth = parent.depth + 1;
        parent.replies.push(c);
        continue;
      }
    }
    keep.push(c);
  }
  aggregate.comments.splice(0, aggregate.comments.length, ...keep);
}

function computeAchievedDepth(comments: XComment[]): number {
  let max = 0;
  for (const c of comments) {
    if (c.depth > max) max = c.depth;
    if (c.replies.length > 0) {
      const sub = computeAchievedDepth(c.replies);
      if (sub > max) max = sub;
    }
  }
  return max;
}

function countAllComments(comments: XComment[]): number {
  let n = 0;
  for (const c of comments) {
    n += 1;
    if (c.replies.length > 0) n += countAllComments(c.replies);
  }
  return n;
}

function determineStatus(c: WalkCoverage): CoverageStatus {
  if (c.status !== 'ok') return c.status;
  if (c.fetchedReplies === 0) return 'failed';
  if (c.fetchedReplies >= Math.floor(c.targetReplies * 0.9) && c.achievedDepth >= c.targetDepth) {
    return 'ok';
  }
  if (c.fetchedReplies < c.targetReplies || c.achievedDepth < c.targetDepth) return 'partial';
  return 'ok';
}
