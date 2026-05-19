import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rewriteCursor, walkReplyTree } from '../../src/fetcher/pagination.ts';
import { extractCursors, parseTweetDetail } from '../../src/fetcher/parser.ts';

const minFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail.min.json'), 'utf8'),
);
const page2Fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail-page2.min.json'), 'utf8'),
);
const nestedFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail-nested.min.json'), 'utf8'),
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
