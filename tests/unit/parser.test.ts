import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTweetDetail } from '../../src/fetcher/parser.ts';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail.min.json'), 'utf8'),
);

describe('parseTweetDetail', () => {
  const parsed = parseTweetDetail(fixture, '1001');

  it('extracts the root post', () => {
    expect(parsed.rootPost).toBeDefined();
    expect(parsed.rootPost?.id).toBe('1001');
    expect(parsed.rootPost?.author.handle).toBe('alice');
    expect(parsed.rootPost?.metrics.likes).toBe(12400);
  });

  it('captures same-author follow-up as authorPost', () => {
    expect(parsed.authorPosts).toHaveLength(1);
    expect(parsed.authorPosts[0]?.id).toBe('1002');
  });

  it('captures replies from other authors as comments', () => {
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]?.author.handle).toBe('bob');
    expect(parsed.comments[0]?.author.verified).toBe(true);
  });

  it('returns canonical url with author handle', () => {
    expect(parsed.rootPost?.url).toBe('https://x.com/alice/status/1001');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P1.6 — self-thread + author-engagement routing
// ────────────────────────────────────────────────────────────────────────────

const selfThreadFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'tweet-detail-self-thread.min.json'), 'utf8'),
);

describe('parseTweetDetail — P1.6 self-thread + author engagement', () => {
  const parsed = parseTweetDetail(selfThreadFixture, '1001');

  it('extracts root post by alice', () => {
    expect(parsed.rootPost?.id).toBe('1001');
    expect(parsed.rootPost?.author.handle).toBe('alice');
  });

  it('routes chain continuation (in_reply_to=root) to authorPosts', () => {
    const ids = parsed.authorPosts.map((p) => p.id);
    expect(ids).toContain('1002');
  });

  it('routes module continuation without in_reply_to to authorPosts', () => {
    const ids = parsed.authorPosts.map((p) => p.id);
    expect(ids).toContain('1003');
  });

  it('treats the same-author reply to a commenter as a comment, not authorPost', () => {
    const ids = parsed.authorPosts.map((p) => p.id);
    expect(ids).not.toContain('2099');
  });

  it('flags the author-reply-to-commenter with isAuthorReply=true', () => {
    const authorReply = parsed.comments.find((c) => c.id === '2099');
    expect(authorReply).toBeDefined();
    expect(authorReply?.isAuthorReply).toBe(true);
    expect(authorReply?.inReplyToPostId).toBe('2001');
  });

  it('keeps third-party replies as plain comments without isAuthorReply', () => {
    const bob = parsed.comments.find((c) => c.id === '2001');
    const carol = parsed.comments.find((c) => c.id === '3001');
    expect(bob?.isAuthorReply).toBeUndefined();
    expect(carol?.isAuthorReply).toBeUndefined();
  });

  it('produces the expected authorPosts.length=2 and comments.length=3', () => {
    expect(parsed.authorPosts).toHaveLength(2);
    expect(parsed.comments).toHaveLength(3);
  });
});
