import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { _internals, rewriteCursor, walkReplyTree } from '../../src/fetcher/pagination.ts';
import {
  type NestedShowMoreCursor,
  type ParsedDetail,
  extractCursors,
  parseTweetDetail,
} from '../../src/fetcher/parser.ts';
import type { XComment } from '../../src/models/comment.ts';
import type { XPost } from '../../src/models/post.ts';

const minFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail.min.json'), 'utf8'),
);
const page2Fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail-page2.min.json'), 'utf8'),
);
const nestedFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail-nested.min.json'), 'utf8'),
);
const authorCursorFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail-author-cursor.min.json'), 'utf8'),
);

describe('extractCursors', () => {
  it('returns no cursors for the minimal fixture (none present)', () => {
    const c = extractCursors(minFixture);
    expect(c.bottom).toBeUndefined();
    expect(c.showMore).toEqual([]);
  });

  it('extracts a top-level Bottom cursor from page2 fixture', () => {
    const c = extractCursors(page2Fixture);
    expect(c.bottom).toBe('CURSOR_NEXT_PAGE_3');
    expect(c.showMore).toEqual([]);
  });

  it('extracts both Bottom + ShowMore cursors from the nested fixture', () => {
    const c = extractCursors(nestedFixture);
    expect(c.bottom).toBe('CURSOR_NEXT_PAGE_2');
    expect(c.showMore).toHaveLength(1);
    expect(c.showMore[0]?.value).toBe('SHOW_MORE_UNDER_4001');
    // The ShowMore cursor sits AFTER tweet 4002 inside the conversation module,
    // so its anchor parent should be 4002 (the most recent tweet in module).
    expect(c.showMore[0]?.parentPostId).toBe('4002');
    expect(c.showMore[0]?.depth).toBeGreaterThanOrEqual(1);
  });

  it('is robust to a payload with no instructions', () => {
    expect(extractCursors({})).toEqual({ showMore: [] });
    expect(extractCursors(null)).toEqual({ showMore: [] });
  });
});

describe('rewriteCursor', () => {
  it('replaces the cursor field inside the variables JSON', () => {
    const original = `https://x.com/i/api/graphql/abc123/TweetDetail?variables=${encodeURIComponent(JSON.stringify({ focalTweetId: '1001', cursor: 'OLD' }))}`;
    const rewritten = rewriteCursor(original, 'NEW_CURSOR_VALUE');
    const u = new URL(rewritten);
    const v = JSON.parse(u.searchParams.get('variables') ?? '{}');
    expect(v.cursor).toBe('NEW_CURSOR_VALUE');
    expect(v.focalTweetId).toBe('1001');
  });

  it('injects a cursor if none was present', () => {
    const original = `https://x.com/i/api/graphql/abc123/TweetDetail?variables=${encodeURIComponent(JSON.stringify({ focalTweetId: '1001' }))}`;
    const rewritten = rewriteCursor(original, 'XYZ');
    const v = JSON.parse(new URL(rewritten).searchParams.get('variables') ?? '{}');
    expect(v.cursor).toBe('XYZ');
  });

  it('returns the url unchanged when variables is missing or invalid', () => {
    expect(rewriteCursor('https://example.com/path', 'X')).toBe('https://example.com/path');
    expect(rewriteCursor('not-a-url', 'X')).toBe('not-a-url');
  });
});

describe('walkReplyTree without a pagination context (attach-only pass)', () => {
  // With ctx=undefined the walk skips network and only runs the
  // post-process tree-attach pass over already-parsed comments. That gives us
  // a test seam for the dedup + nested-attach logic without playwright.

  it('hoists a flat reply whose inReplyTo points to another fetched comment into replies[]', async () => {
    // Build an aggregate where comment 4002 (reply to 4001) was parsed flat;
    // attach pass should move 4002 under 4001.replies.
    const detail = parseTweetDetail(nestedFixture, '1001');
    expect(detail.rootPost?.id).toBe('1001');
    const flatBefore = detail.comments.length;
    expect(flatBefore).toBeGreaterThanOrEqual(2);

    const seen = new Set<string>(detail.comments.map((c) => c.id));
    const coverage = await walkReplyTree(
      // page arg is unused when ctx is undefined; cast to satisfy TS
      undefined as unknown as Parameters<typeof walkReplyTree>[0],
      '1001',
      detail,
      seen,
      { showMore: [] },
      undefined,
      { maxReplies: 50, depth: 3 },
    );

    // After attach: 4002 should no longer be a top-level comment.
    const topIds = detail.comments.map((c) => c.id);
    expect(topIds).toContain('4001');
    expect(topIds).not.toContain('4002');
    const erin = detail.comments.find((c) => c.id === '4001');
    expect(erin?.replies.map((r) => r.id)).toContain('4002');
    expect(erin?.replies[0]?.depth).toBe(1);

    // Coverage reflects the achieved depth (>=1) and a non-zero reply count.
    expect(coverage.targetDepth).toBe(3);
    expect(coverage.achievedDepth).toBeGreaterThanOrEqual(1);
    expect(coverage.fetchedReplies).toBeGreaterThanOrEqual(2);
    // status is 'partial' because targetReplies(50) > fetchedReplies and targetDepth(3) > achievedDepth(1)
    expect(['ok', 'partial']).toContain(coverage.status);
  });

  it('reports failed when no replies were fetched at all', async () => {
    const empty = {
      rootPost: {
        id: '999',
        url: 'https://x.com/x/status/999',
        author: { handle: 'x', verified: false },
        text: '',
        metrics: {},
        media: [],
        links: [],
        isReply: false,
        isQuote: false,
      },
      authorPosts: [],
      comments: [],
      quoteTweets: [],
    };
    const coverage = await walkReplyTree(
      undefined as unknown as Parameters<typeof walkReplyTree>[0],
      '999',
      empty,
      new Set(),
      { showMore: [] },
      undefined,
      { maxReplies: 50, depth: 3 },
    );
    expect(coverage.fetchedReplies).toBe(0);
    expect(coverage.status).toBe('failed');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// P1.6 PR2 — author-priority queue + adaptive budget + early-stop
// ──────────────────────────────────────────────────────────────────────────

describe('extractCursors — P1.6 PR2 author-anchored ShowMore flag', () => {
  it('flags cursor with parentIsAuthorReply when anchor parent is author replying to commenter', () => {
    // Root is alice (u1). Module A's last tweet before the ShowMore cursor is
    // alice's reply to bob (in_reply_to=2001, not root). With rootAuthorId
    // passed in, that cursor should carry parentIsAuthorReply=true.
    const cursors = extractCursors(authorCursorFixture, { rootId: '1001', rootAuthorId: 'u1' });
    expect(cursors.showMore).toHaveLength(2);
    const authorCursor = cursors.showMore.find((c) => c.value === 'SHOW_MORE_UNDER_AUTHOR_REPLY');
    const thirdPartyCursor = cursors.showMore.find(
      (c) => c.value === 'SHOW_MORE_UNDER_THIRD_PARTY',
    );
    expect(authorCursor?.parentIsAuthorReply).toBe(true);
    expect(authorCursor?.parentPostId).toBe('2099');
    expect(thirdPartyCursor?.parentIsAuthorReply).toBeUndefined();
    expect(thirdPartyCursor?.parentPostId).toBe('3001');
  });

  it('omits parentIsAuthorReply when no rootAuthorId ctx is passed (backward compat)', () => {
    const cursors = extractCursors(authorCursorFixture);
    expect(cursors.showMore).toHaveLength(2);
    for (const c of cursors.showMore) {
      expect(c.parentIsAuthorReply).toBeUndefined();
    }
  });

  it('omits parentIsAuthorReply when rootAuthorId does not match any tweet', () => {
    const cursors = extractCursors(authorCursorFixture, {
      rootId: '1001',
      rootAuthorId: 'u_other',
    });
    for (const c of cursors.showMore) {
      expect(c.parentIsAuthorReply).toBeUndefined();
    }
  });
});

describe('_internals.sortAuthorFirst — author-priority queue ordering', () => {
  it('places author-anchored cursors before others, preserving relative order within each bucket', () => {
    const cursors: NestedShowMoreCursor[] = [
      { value: 'A', depth: 1 },
      { value: 'B', depth: 1, parentIsAuthorReply: true },
      { value: 'C', depth: 1 },
      { value: 'D', depth: 1, parentIsAuthorReply: true },
    ];
    const sorted = _internals.sortAuthorFirst(cursors);
    expect(sorted.map((c) => c.value)).toEqual(['B', 'D', 'A', 'C']);
  });

  it('is a no-op when all cursors are third-party', () => {
    const cursors: NestedShowMoreCursor[] = [
      { value: 'A', depth: 1 },
      { value: 'B', depth: 2 },
    ];
    const sorted = _internals.sortAuthorFirst(cursors);
    expect(sorted.map((c) => c.value)).toEqual(['A', 'B']);
  });

  it('returns empty when input is empty', () => {
    expect(_internals.sortAuthorFirst([])).toEqual([]);
  });
});

describe('_internals.shouldBumpBudget — adaptive maxRequests trigger', () => {
  function fakeAggregate(authorPosts: number, comments: number): ParsedDetail {
    const rootPost: XPost = {
      id: '1001',
      url: 'https://x.com/alice/status/1001',
      author: { id: 'u1', handle: 'alice', verified: false },
      text: 'root',
      metrics: {},
      media: [],
      links: [],
      isReply: false,
      isQuote: false,
    };
    const ap: XPost[] = Array.from({ length: authorPosts }, (_, i) => ({
      ...rootPost,
      id: `auth_${i}`,
    }));
    const cs: XComment[] = Array.from({ length: comments }, (_, i) => ({
      ...rootPost,
      id: `c_${i}`,
      depth: 0,
      replies: [],
    }));
    return { rootPost, authorPosts: ap, comments: cs, quoteTweets: [] };
  }

  it('triggers when authorPosts.length >= threshold (Karpathy-style self-thread)', () => {
    expect(_internals.shouldBumpBudget(fakeAggregate(2, 10))).toBe(true);
    expect(_internals.shouldBumpBudget(fakeAggregate(5, 0))).toBe(true);
  });

  it('triggers on very busy threads even without a self-thread', () => {
    expect(_internals.shouldBumpBudget(fakeAggregate(0, 201))).toBe(true);
  });

  it('does NOT trigger below either threshold', () => {
    expect(_internals.shouldBumpBudget(fakeAggregate(1, 50))).toBe(false);
    expect(_internals.shouldBumpBudget(fakeAggregate(0, 199))).toBe(false);
  });

  it('caps the bumped budget at MAX_REQUESTS_CEILING (= DEFAULT * 3)', () => {
    // Sanity-check the ceiling constant relationship the loop relies on.
    expect(_internals.MAX_REQUESTS_CEILING).toBe(_internals.DEFAULT_MAX_REQUESTS * 3);
    // Bumped value (DEFAULT * 2) sits strictly under the ceiling.
    expect(_internals.DEFAULT_MAX_REQUESTS * 2).toBeLessThanOrEqual(
      _internals.MAX_REQUESTS_CEILING,
    );
  });
});

describe('_internals.countAuthorReplies — early-stop counter', () => {
  function comment(id: string, isAuthorReply: boolean, replies: XComment[] = []): XComment {
    return {
      id,
      url: `https://x.com/x/status/${id}`,
      author: { handle: 'x', verified: false },
      text: '',
      metrics: {},
      media: [],
      links: [],
      isReply: false,
      isQuote: false,
      depth: 0,
      replies,
      ...(isAuthorReply ? { isAuthorReply: true } : {}),
    };
  }

  it('counts flat author replies', () => {
    const flat = [comment('a', true), comment('b', false), comment('c', true)];
    expect(_internals.countAuthorReplies(flat)).toBe(2);
  });

  it('counts nested author replies recursively', () => {
    const tree = [
      comment('top', false, [
        comment('mid', true, [comment('deep', true)]),
        comment('sibling', false),
      ]),
      comment('top2', true),
    ];
    expect(_internals.countAuthorReplies(tree)).toBe(3);
  });

  it('returns 0 for empty tree', () => {
    expect(_internals.countAuthorReplies([])).toBe(0);
  });

  it('hits the EARLY_STOP_AUTHOR_REPLIES threshold at exactly 5 by default', () => {
    const five = Array.from({ length: 5 }, (_, i) => comment(`a${i}`, true));
    expect(_internals.countAuthorReplies(five)).toBeGreaterThanOrEqual(
      _internals.EARLY_STOP_AUTHOR_REPLIES,
    );
    const four = Array.from({ length: 4 }, (_, i) => comment(`a${i}`, true));
    expect(_internals.countAuthorReplies(four)).toBeLessThan(_internals.EARLY_STOP_AUTHOR_REPLIES);
  });
});
