/**
 * v1.0.1 — `research()` must populate `report.coverage` on cache-hit paths.
 *
 * In v1.0.0, the cache layer only stored `XThread` (not `ThreadCoverage`),
 * so every cache hit silently dropped `report.coverage` to `undefined`
 * even though classification + the report ran successfully. The smoke
 * test on `https://x.com/AnatoliKopadze/status/2056362875195686927`
 * surfaced this immediately: `coverage: null` in the catch-all JSON output.
 *
 * The fix synthesizes a minimal `ThreadCoverage` on cache reads using the
 * cached `thread.comments.length` + `thread.partial` flag. The classification
 * step then layers `classifiedReplies` + prefilter telemetry on top.
 *
 * These tests pin the contract so the field doesn't regress again.
 */
import { describe, expect, it, vi } from 'vitest';

const cachedThreadFixture = {
  rootPost: {
    id: '99001',
    url: 'https://x.com/alice/status/99001',
    author: { handle: 'alice', verified: false, id: 'u-alice' },
    text: 'cached thread root post',
    metrics: {},
    media: [],
    links: [],
    isReply: false,
    isQuote: false,
  },
  authorPosts: [],
  quoteTweets: [],
  comments: [],
  fetchedAt: '2026-05-19T12:00:00.000Z',
  partial: false,
};

// Cache returns the fixture. Fetcher / browser must NOT be called on a hit.
vi.mock('../../src/cache/threads.ts', () => ({
  putCachedThread: vi.fn(),
  getCachedThread: vi.fn(() => cachedThreadFixture),
}));

vi.mock('../../src/fetcher/browser.ts', () => ({
  newContext: vi.fn(),
  newContextWithCookies: vi.fn(),
  getBrowser: vi.fn(),
  saveStorageState: vi.fn(),
  closeBrowser: vi.fn(),
}));

// fetchThread must never run on a cache hit — explode if it does.
vi.mock('../../src/fetcher/thread.ts', () => ({
  fetchThread: vi.fn(() => {
    throw new Error('fetchThread must not run on cache hit');
  }),
}));

// Kyma analyze + classify return deterministic stubs so we can focus on
// the coverage field without spinning up a real model. classify returns
// 0 classifications (no comments in the fixture) so the assertion stays
// tight on the synthesized coverage shape.
vi.mock('../../src/kyma/analyze.ts', () => ({
  analyzeThread: vi.fn(async () => ({
    model: 'stub-model',
    tldr: 'tldr',
    summary: 'summary',
    keyInsights: [],
    notableReplies: [],
    openQuestions: [],
    topic: 'test',
  })),
}));

vi.mock('../../src/intelligence/classify.ts', () => ({
  classifyComments: vi.fn(async () => ({
    classifiedCount: 0,
    callCount: 0,
    prefilterApplied: false,
    candidatePool: 0,
    classifiedFromPool: 0,
    warnings: [],
  })),
  computeStanceDistribution: vi.fn(() => ({
    agree: 0,
    disagree: 0,
    neutral: 0,
    question: 0,
    humor: 0,
    meta: 0,
  })),
}));

vi.mock('../../src/core/config.ts', () => ({
  loadConfig: () => ({
    kyma: { key: 'test-key', model: 'stub-model' },
    fetcher: { timeoutMs: 10_000 },
    log: { level: 'error' },
  }),
  resetConfigForTests: () => undefined,
}));

import { research } from '../../src/intelligence/analyze-thread.ts';

describe('research() — coverage on cache hit (v1.0.1)', () => {
  it('populates report.coverage when the thread comes from cache', async () => {
    const report = await research('https://x.com/alice/status/99001');
    expect(report.source.cacheHit).toBe(true);
    expect(report.coverage).toBeDefined();
    expect(report.coverage?.status).toBe('ok');
    expect(report.coverage?.fetchedReplies).toBe(0);
    // No depth/cursor info on a cache hit — we don't fabricate values.
    expect(report.coverage?.paginationCursors).toEqual([]);
    expect(report.coverage?.targetDepth).toBe(0);
  });

  it('carries thread.partial into coverage.status when the cached thread was partial', async () => {
    const { getCachedThread } = await import('../../src/cache/threads.ts');
    (getCachedThread as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      ...cachedThreadFixture,
      partial: true,
      partialReason: 'cached as partial during fetch',
    }));
    const report = await research('https://x.com/alice/status/99001');
    expect(report.coverage?.status).toBe('partial');
    expect(report.coverage?.failureReason).toBe('cached as partial during fetch');
  });

  it('preserves report.coverage when --articles + --video flags are set on a cache hit', async () => {
    // Bug 2 in the v1.0.1 task brief: catch-all `--video --articles` runs
    // showed `coverage: null`. Confirms the field survives both flag paths.
    const report = await research('https://x.com/alice/status/99001', {
      articles: true,
      video: true,
    });
    expect(report.coverage).toBeDefined();
    expect(report.coverage?.status).toBe('ok');
  });

  it('respects opts.maxReplies and opts.depth when synthesizing coverage', async () => {
    const report = await research('https://x.com/alice/status/99001', {
      maxReplies: 75,
      depth: 4,
    });
    expect(report.coverage?.targetReplies).toBe(75);
    expect(report.coverage?.targetDepth).toBe(4);
  });
});
