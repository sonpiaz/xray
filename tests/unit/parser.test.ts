import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTweetCard, parseTweetDetail } from '../../src/fetcher/parser.ts';

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

// ────────────────────────────────────────────────────────────────────────────
// v1.0.1 — X Article card → XPost.card surfacing
// ────────────────────────────────────────────────────────────────────────────

const articleCardFixture = JSON.parse(
  readFileSync(
    join(__dirname, '..', 'fixtures', 'tweet-detail-with-article-card.min.json'),
    'utf8',
  ),
);

describe('parseTweetDetail — v1.0.1 X Article card on rootPost', () => {
  const parsed = parseTweetDetail(articleCardFixture, '5001');

  it('surfaces the structured card on rootPost.card', () => {
    expect(parsed.rootPost?.card).toBeDefined();
    expect(parsed.rootPost?.card?.url).toBe('https://x.com/i/article/9001');
    expect(parsed.rootPost?.card?.title).toBe('How to Actually Use Claude');
    expect(parsed.rootPost?.card?.byline).toBe('Alice Author');
  });

  it('extracts body_text from binding_values into card.bodyText', () => {
    expect(parsed.rootPost?.card?.bodyText).toMatch(/Claude is most useful/);
    expect(parsed.rootPost?.card?.bodyText).toMatch(/18 patterns/);
  });

  it('keeps the v1.0.0 raw.card payload for backward compatibility', () => {
    const raw = parsed.rootPost?.raw as { card?: unknown } | undefined;
    expect(raw?.card).toBeDefined();
  });
});

describe('parseTweetCard', () => {
  it('returns undefined when tweet has no card', () => {
    const tweet = { rest_id: '1', legacy: { id_str: '1' } };
    expect(parseTweetCard(tweet)).toBeUndefined();
  });

  it('extracts url + title + bodyText from a standard X Article card', () => {
    const tweet = {
      rest_id: '1',
      card: {
        url: 'https://x.com/i/article/42',
        legacy: {
          binding_values: [
            { key: 'title', value: { string_value: 'Headline' } },
            { key: 'body_text', value: { string_value: 'Body text here.' } },
          ],
        },
      },
    };
    const out = parseTweetCard(tweet);
    expect(out?.url).toBe('https://x.com/i/article/42');
    expect(out?.title).toBe('Headline');
    expect(out?.bodyText).toBe('Body text here.');
  });

  it('falls back to binding_values.card_url when card.url is missing', () => {
    const tweet = {
      rest_id: '1',
      card: {
        legacy: {
          binding_values: [
            { key: 'card_url', value: { string_value: 'https://example.com/post' } },
          ],
        },
      },
    };
    expect(parseTweetCard(tweet)?.url).toBe('https://example.com/post');
  });

  it('returns undefined when neither card.url nor any url binding is present', () => {
    const tweet = {
      rest_id: '1',
      card: {
        legacy: {
          binding_values: [{ key: 'title', value: { string_value: 'No URL' } }],
        },
      },
    };
    expect(parseTweetCard(tweet)).toBeUndefined();
  });

  it('leaves bodyText undefined for non-article cards (e.g. summary_large_image)', () => {
    const tweet = {
      rest_id: '1',
      card: {
        name: 'summary_large_image',
        url: 'https://example.com/blog/post',
        legacy: {
          binding_values: [
            { key: 'title', value: { string_value: 'External blog title' } },
            { key: 'description', value: { string_value: 'Short preview snippet.' } },
          ],
        },
      },
    };
    const out = parseTweetCard(tweet);
    expect(out?.url).toBe('https://example.com/blog/post');
    expect(out?.title).toBe('External blog title');
    // `description` is not promoted into bodyText (X Articles only).
    expect(out?.bodyText).toBeUndefined();
  });
});
