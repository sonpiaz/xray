/**
 * P2.3 — `collectVideoCandidates` is the pure helper that decides which
 * media URLs the `--video` flag will analyze. Importing it via
 * `analyze-thread.ts` transitively pulls `bun:sqlite` through the cache
 * layer; we stub the side-effect-heavy modules here so the suite runs
 * under Node (same pattern as `escalation.test.ts`).
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

import { collectVideoCandidates } from '../../src/intelligence/analyze-thread.ts';
import type { XMedia } from '../../src/models/media.ts';
import type { XPost } from '../../src/models/post.ts';
import type { XThread } from '../../src/models/thread.ts';

const FETCHED_AT = '2026-05-19T12:00:00.000Z';

function media(url: string, type: XMedia['type'] = 'video'): XMedia {
  return { type, url };
}

function post(id: string, mediaArr: XMedia[]): XPost {
  return {
    id,
    url: `https://x.com/alice/status/${id}`,
    author: { handle: 'alice', verified: false },
    text: `post ${id}`,
    metrics: {},
    media: mediaArr,
    links: [],
    isReply: false,
    isQuote: false,
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
// collectVideoCandidates
// ──────────────────────────────────────────────────────────────────────

describe('collectVideoCandidates', () => {
  it('returns an empty list when no media is present', () => {
    expect(collectVideoCandidates(thread(post('1', [])))).toEqual([]);
  });

  it('returns video media from the root post', () => {
    const root = post('1', [media('https://video.twimg.com/ext_tw_video/1/pu/vid/a.mp4')]);
    const out = collectVideoCandidates(thread(root));
    expect(out).toHaveLength(1);
    expect(out[0]?.url).toBe('https://video.twimg.com/ext_tw_video/1/pu/vid/a.mp4');
  });

  it('ignores image and gif media types', () => {
    const root = post('1', [
      media('https://pbs.twimg.com/media/img.jpg', 'image'),
      media('https://video.twimg.com/g.gif', 'gif'),
      media('https://video.twimg.com/v.mp4', 'video'),
    ]);
    const out = collectVideoCandidates(thread(root));
    expect(out).toHaveLength(1);
    expect(out[0]?.url.endsWith('.mp4')).toBe(true);
  });

  it('aggregates videos across rootPost and authorPosts', () => {
    const root = post('1', [media('https://video.twimg.com/a.mp4')]);
    const followUp = post('2', [media('https://video.twimg.com/b.mp4')]);
    const out = collectVideoCandidates(thread(root, [followUp]));
    expect(out.map((m) => m.url)).toEqual([
      'https://video.twimg.com/a.mp4',
      'https://video.twimg.com/b.mp4',
    ]);
  });

  it('de-duplicates by URL', () => {
    const root = post('1', [media('https://video.twimg.com/x.mp4')]);
    const followUp = post('2', [media('https://video.twimg.com/x.mp4')]);
    const out = collectVideoCandidates(thread(root, [followUp]));
    expect(out).toHaveLength(1);
  });

  it('does NOT scan comments for video media (cost guardrail)', () => {
    const t = thread(post('1', []));
    // Inject a video into a comment — must be ignored.
    (t.comments as unknown as Array<{ media: XMedia[] }>).push({
      media: [media('https://video.twimg.com/should-not-appear.mp4')],
    });
    expect(collectVideoCandidates(t)).toEqual([]);
  });
});
