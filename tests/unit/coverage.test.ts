import { describe, expect, it, vi } from 'vitest';

// classify.ts → kyma/client.ts → cache/db.ts (bun:sqlite). Stub the client so vitest
// under Node doesn't try to resolve the Bun-native module path. We never call chat() here.
vi.mock('../../src/kyma/client.ts', () => ({ chat: vi.fn() }));

import { computeStanceDistribution } from '../../src/intelligence/classify.ts';
import type { XComment } from '../../src/models/comment.ts';
import { ResearchReportSchema, ThreadCoverageSchema } from '../../src/models/report.ts';

function mkComment(id: string, opts: Partial<XComment> = {}): XComment {
  return {
    id,
    url: `https://x.com/u/status/${id}`,
    author: { handle: `u${id}`, verified: false },
    text: `reply ${id}`,
    metrics: {},
    media: [],
    links: [],
    isReply: true,
    isQuote: false,
    depth: opts.depth ?? 0,
    replies: opts.replies ?? [],
    ...(opts.classification !== undefined ? { classification: opts.classification } : {}),
  };
}

describe('ThreadCoverage — classifiedReplies field (P1.1)', () => {
  it('defaults classifiedReplies to 0 when omitted', () => {
    const c = ThreadCoverageSchema.parse({
      targetDepth: 3,
      achievedDepth: 1,
      targetReplies: 50,
      fetchedReplies: 12,
    });
    expect(c.classifiedReplies).toBe(0);
    expect(c.status).toBe('ok');
  });

  it('preserves an explicit classifiedReplies value', () => {
    const c = ThreadCoverageSchema.parse({
      targetDepth: 3,
      achievedDepth: 3,
      targetReplies: 50,
      fetchedReplies: 47,
      classifiedReplies: 40,
      status: 'ok',
    });
    expect(c.classifiedReplies).toBe(40);
    expect(c.fetchedReplies).toBe(47);
  });

  it('allows classifiedReplies > 0 even when status is partial', () => {
    const c = ThreadCoverageSchema.parse({
      targetDepth: 3,
      achievedDepth: 1,
      targetReplies: 50,
      fetchedReplies: 32,
      classifiedReplies: 32,
      status: 'partial',
      failureReason: 'pagination stopped at depth 2/3',
    });
    expect(c.status).toBe('partial');
    expect(c.classifiedReplies).toBe(32);
    expect(c.failureReason).toContain('pagination');
  });
});

describe('ResearchReport — stanceDistribution wiring (P1.1)', () => {
  it('accepts an optional stanceDistribution alongside coverage', () => {
    const r = ResearchReportSchema.parse({
      generatedAt: new Date().toISOString(),
      source: { url: 'https://x.com/a/status/1', model: 'gemini' },
      thread: {
        rootPost: {
          id: '1',
          url: 'https://x.com/a/status/1',
          author: { handle: 'a' },
          text: 'root',
        },
        fetchedAt: new Date().toISOString(),
      },
      tldr: 't',
      summary: 's',
      coverage: {
        targetDepth: 3,
        achievedDepth: 2,
        targetReplies: 50,
        fetchedReplies: 30,
        classifiedReplies: 30,
        status: 'partial',
      },
      stanceDistribution: {
        agree: 10,
        disagree: 5,
        neutral: 8,
        question: 3,
        humor: 3,
        meta: 1,
      },
    });
    expect(r.stanceDistribution?.agree).toBe(10);
    expect(r.coverage?.classifiedReplies).toBe(30);
  });

  it('omitting stanceDistribution stays backward-compatible (Phase 0 shape still parses)', () => {
    const r = ResearchReportSchema.parse({
      generatedAt: new Date().toISOString(),
      source: { url: 'https://x.com/a/status/1', model: 'gemini' },
      thread: {
        rootPost: {
          id: '1',
          url: 'https://x.com/a/status/1',
          author: { handle: 'a' },
          text: 'root',
        },
        fetchedAt: new Date().toISOString(),
      },
      tldr: 't',
      summary: 's',
    });
    expect(r.stanceDistribution).toBeUndefined();
    expect(r.coverage).toBeUndefined();
  });
});

describe('computeStanceDistribution — counts attached classifications across the nested tree', () => {
  it('sums stances across top-level + nested replies (ignores unclassified)', () => {
    const nested = mkComment('2002', {
      depth: 1,
      classification: { stance: 'disagree', quality: 'substantive', qualityScore: 0.7 },
    });
    const top = mkComment('2001', {
      classification: { stance: 'agree', quality: 'substantive', qualityScore: 0.6 },
      replies: [nested],
    });
    const noClass = mkComment('2003');
    const thread = {
      rootPost: {
        id: '1',
        url: 'https://x.com/a/status/1',
        author: { handle: 'a', verified: false },
        text: 'root',
        metrics: {},
        media: [],
        links: [],
        isReply: false,
        isQuote: false,
      },
      authorPosts: [],
      quoteTweets: [],
      comments: [top, noClass],
      fetchedAt: new Date().toISOString(),
      partial: false,
    };
    const dist = computeStanceDistribution(thread);
    expect(dist.agree).toBe(1);
    expect(dist.disagree).toBe(1);
    expect(dist.neutral).toBe(0);
    expect(dist.question).toBe(0);
    expect(dist.humor).toBe(0);
    expect(dist.meta).toBe(0);
  });

  it('returns all-zeros for a thread with no classifications', () => {
    const thread = {
      rootPost: {
        id: '1',
        url: 'https://x.com/a/status/1',
        author: { handle: 'a', verified: false },
        text: 'root',
        metrics: {},
        media: [],
        links: [],
        isReply: false,
        isQuote: false,
      },
      authorPosts: [],
      quoteTweets: [],
      comments: [mkComment('2001')],
      fetchedAt: new Date().toISOString(),
      partial: false,
    };
    const dist = computeStanceDistribution(thread);
    expect(Object.values(dist).every((v) => v === 0)).toBe(true);
  });
});
