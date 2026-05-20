/**
 * P3.2 — `collectArticleCandidates` + `buildTweetContext` tests.
 *
 * `analyze-thread.ts` transitively pulls `bun:sqlite` via the thread
 * cache + browser modules. We stub those side-effect heavy modules at
 * the top so vitest under Node can import the file (same pattern as
 * `analyze-thread-video.test.ts`).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cache/threads.ts', () => ({
  putCachedThread: vi.fn(),
  getCachedThread: vi.fn(),
}));

vi.mock('../../src/fetcher/browser.ts', () => ({
  newContext: vi.fn(),
  newContextWithCookies: vi.fn(),
  getBrowser: vi.fn(),
  saveStorageState: vi.fn(),
  closeBrowser: vi.fn(),
}));

import {
  buildTweetContext,
  collectArticleCandidates,
} from '../../src/intelligence/analyze-thread.ts';
import type { XExternalLink } from '../../src/models/link.ts';
import type { XArticleCard, XPost } from '../../src/models/post.ts';
import type { XThread } from '../../src/models/thread.ts';

const FETCHED_AT = '2026-05-19T12:00:00.000Z';

function link(url: string, expanded?: string): XExternalLink {
  return expanded ? { url, expandedUrl: expanded } : { url };
}

function post(
  id: string,
  opts: {
    text?: string;
    links?: XExternalLink[];
    raw?: unknown;
    card?: XArticleCard;
  } = {},
): XPost {
  return {
    id,
    url: `https://x.com/alice/status/${id}`,
    author: { handle: 'alice', verified: false },
    text: opts.text ?? `post ${id}`,
    metrics: {},
    media: [],
    links: opts.links ?? [],
    isReply: false,
    isQuote: false,
    ...(opts.card !== undefined ? { card: opts.card } : {}),
    ...(opts.raw !== undefined ? { raw: opts.raw } : {}),
  };
}

function thread(root: XPost, authorPosts: XPost[] = []): XThread {
  return {
    rootPost: root,
    authorPosts,
    quoteTweets: [],
    comments: [],
    fetchedAt: FETCHED_AT,
    partial: false,
  };
}

// ──────────────────────────────────────────────────────────────────────
// collectArticleCandidates
// ──────────────────────────────────────────────────────────────────────

describe('collectArticleCandidates', () => {
  it('returns an empty list when no links + no card on the thread', () => {
    expect(collectArticleCandidates(thread(post('1')))).toEqual([]);
  });

  it('extracts external HTTP links from rootPost.links', () => {
    const root = post('1', {
      links: [link('https://substack.example.com/p/article')],
    });
    const out = collectArticleCandidates(thread(root));
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://substack.example.com/p/article');
    expect(out[0]?.source).toBe('external-html');
  });

  it('prefers expandedUrl over the raw url when both are set', () => {
    const root = post('1', {
      links: [link('https://t.co/abc', 'https://medium.com/@u/real-post')],
    });
    const out = collectArticleCandidates(thread(root));
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://medium.com/@u/real-post');
  });

  it('extracts X Article card payload from rootPost.raw.card', () => {
    const card = {
      name: 'article',
      url: 'https://x.com/i/article/9999',
      legacy: {
        binding_values: [
          { key: 'card_url', value: { string_value: 'https://x.com/i/article/9999' } },
          { key: 'title', value: { string_value: 'Test' } },
        ],
      },
    };
    const root = post('1', { raw: { card } });
    const out = collectArticleCandidates(thread(root));
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('x-article');
    expect(out[0]?.url).toBe('https://x.com/i/article/9999');
    expect(out[0]?.cardData).toBe(card);
  });

  it('deduplicates an article that appears both as link + as card', () => {
    const url = 'https://x.com/i/article/9999';
    const card = {
      url,
      legacy: {
        binding_values: [{ key: 'card_url', value: { string_value: url } }],
      },
    };
    const root = post('1', { links: [link(url)], raw: { card } });
    const out = collectArticleCandidates(thread(root));
    expect(out).toHaveLength(1);
    // Card data should be attached to the unified entry so the
    // orchestrator skips the redundant network fetch.
    expect(out[0]?.cardData).toBe(card);
  });

  it('aggregates links across rootPost and authorPosts', () => {
    const root = post('1', { links: [link('https://a.com/x')] });
    const follow = post('2', { links: [link('https://b.com/y')] });
    const out = collectArticleCandidates(thread(root, [follow]));
    expect(out.map((c) => c.url)).toEqual(['https://a.com/x', 'https://b.com/y']);
  });

  it('skips non-article URLs (mailto, images, videos, plain tweet URLs)', () => {
    const root = post('1', {
      links: [
        link('mailto:foo@example.com'),
        link('https://example.com/photo.jpg'),
        link('https://example.com/clip.mp4'),
        link('https://x.com/karpathy/status/12345'),
      ],
    });
    expect(collectArticleCandidates(thread(root))).toEqual([]);
  });

  it('does NOT scan comments for article links (cost guardrail)', () => {
    const t = thread(post('1'));
    // Inject a link into a comment — must be ignored.
    (t.comments as unknown as Array<{ links: XExternalLink[] }>).push({
      links: [link('https://should-not-appear.com/post')],
    });
    expect(collectArticleCandidates(t)).toEqual([]);
  });

  // ──────────────────────────────────────────────────────────────────
  // v1.0.1 — Channel 2: structured XPost.card
  // ──────────────────────────────────────────────────────────────────

  it('extracts X Article candidate from structured XPost.card', () => {
    const card: XArticleCard = {
      url: 'https://x.com/i/article/777',
      title: 'Headline',
      bodyText: 'Body text already extracted by parser.',
    };
    const root = post('1', { card });
    const out = collectArticleCandidates(thread(root));
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://x.com/i/article/777');
    expect(out[0]?.source).toBe('x-article');
    expect(out[0]?.cardData).toBe(card);
  });

  it('scans authorPosts for structured cards (v1.0.0 only scanned rootPost)', () => {
    const card: XArticleCard = {
      url: 'https://x.com/i/article/888',
      bodyText: 'Article body packed into a 2/N follow-up.',
    };
    const follow = post('2', { card });
    const out = collectArticleCandidates(thread(post('1'), [follow]));
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://x.com/i/article/888');
    expect(out[0]?.cardData).toBe(card);
  });

  it('classifies external-html cards (e.g. summary_large_image) as external-html', () => {
    const card: XArticleCard = {
      url: 'https://substack.example.com/p/external-article',
      title: 'External blog',
    };
    const root = post('1', { card });
    const out = collectArticleCandidates(thread(root));
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://substack.example.com/p/external-article');
    expect(out[0]?.source).toBe('external-html');
  });

  it('deduplicates structured card against a matching links entry', () => {
    const url = 'https://x.com/i/article/9999';
    const card: XArticleCard = { url, bodyText: 'cached body' };
    const root = post('1', { links: [link(url)], card });
    const out = collectArticleCandidates(thread(root));
    expect(out).toHaveLength(1);
    // The card payload should land on the unified entry so the
    // orchestrator can skip the network fetch.
    expect(out[0]?.cardData).toBe(card);
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildTweetContext
// ──────────────────────────────────────────────────────────────────────

describe('buildTweetContext', () => {
  it('returns just the root text when there are no follow-ups', () => {
    const ctx = buildTweetContext(thread(post('1', { text: 'root thesis' })));
    expect(ctx).toBe('root thesis');
  });

  it('joins root + author follow-ups with blank-line separators', () => {
    const root = post('1', { text: 'root' });
    const f1 = post('2', { text: 'follow 1' });
    const f2 = post('3', { text: 'follow 2' });
    const ctx = buildTweetContext(thread(root, [f1, f2]));
    expect(ctx).toBe('root\n\nfollow 1\n\nfollow 2');
  });

  it('skips empty follow-up texts', () => {
    const root = post('1', { text: 'root' });
    const f1 = post('2', { text: '' });
    const ctx = buildTweetContext(thread(root, [f1]));
    expect(ctx).toBe('root');
  });
});
