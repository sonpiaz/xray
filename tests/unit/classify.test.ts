import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the kyma client module BEFORE importing anything that depends on it.
vi.mock('../../src/kyma/client.ts', () => ({
  chat: vi.fn(),
}));

import {
  CLASSIFY_VERSION,
  MAX_CLASSIFY_CALLS,
  chunkForClassification,
  classifyCacheKey,
  classifyComments,
  computeStanceDistribution,
  engagementScore,
  flattenComments,
  prefilterByEngagement,
} from '../../src/intelligence/classify.ts';
import { chat } from '../../src/kyma/client.ts';
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  MAX_REPLIES_IN_PROMPT,
  renderClassificationPrompt,
} from '../../src/kyma/prompts.ts';
import type { XComment } from '../../src/models/comment.ts';
import type { XPost } from '../../src/models/post.ts';
import type { XThread } from '../../src/models/thread.ts';

const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'classify-response.json'), 'utf8'),
);

const mockChat = vi.mocked(chat);

function mkPost(id: string, text = `post ${id}`): XPost {
  return {
    id,
    url: `https://x.com/u/status/${id}`,
    author: { handle: 'u', verified: false },
    text,
    metrics: {},
    media: [],
    links: [],
    isReply: false,
    isQuote: false,
  };
}

function mkComment(id: string, opts: Partial<XComment> = {}): XComment {
  return {
    id,
    url: `https://x.com/u/status/${id}`,
    author: { handle: `u${id}`, verified: false },
    text: opts.text ?? `reply ${id}`,
    metrics: opts.metrics ?? { likes: 0 },
    media: [],
    links: [],
    isReply: true,
    isQuote: false,
    depth: opts.depth ?? 0,
    replies: opts.replies ?? [],
  };
}

function mkThread(comments: XComment[]): XThread {
  return {
    rootPost: mkPost('1001', 'root post text'),
    authorPosts: [],
    quoteTweets: [],
    comments,
    fetchedAt: new Date().toISOString(),
    partial: false,
  };
}

beforeEach(() => {
  mockChat.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('CLASSIFY_VERSION + cache key shape', () => {
  it('uses the documented composite key format', () => {
    expect(classifyCacheKey('29481')).toBe(`comment-classify:29481:${CLASSIFY_VERSION}`);
  });

  it('exposes a stable integer version constant', () => {
    expect(Number.isInteger(CLASSIFY_VERSION)).toBe(true);
    expect(CLASSIFY_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('flattenComments', () => {
  it('walks nested replies in DFS order, preserving references', () => {
    const child = mkComment('2002', { depth: 1 });
    const root = mkComment('2001', { depth: 0, replies: [child] });
    const flat = flattenComments([root]);
    expect(flat.map((c) => c.id)).toEqual(['2001', '2002']);
    // mutation via reference must propagate back to the tree
    flat[1]!.classification = { stance: 'neutral', quality: 'noise', qualityScore: 0.1 };
    expect(root.replies[0]!.classification?.stance).toBe('neutral');
  });

  it('returns empty array for empty input', () => {
    expect(flattenComments([])).toEqual([]);
  });
});

describe('chunkForClassification', () => {
  it('returns a single chunk for small batches', () => {
    const cs = Array.from({ length: 5 }, (_, i) => mkComment(String(i)));
    expect(chunkForClassification(cs)).toHaveLength(1);
  });

  it('caps at MAX_CLASSIFY_CALLS chunks — excess comments are skipped this run', () => {
    // P1.2: MAX_CLASSIFY_CALLS = 1, so a 41-item input still returns 1 chunk of 40
    // even though geometrically it could be 2. Callers must prefilter first.
    const cs = Array.from({ length: MAX_REPLIES_IN_PROMPT + 1 }, (_, i) => mkComment(String(i)));
    const chunks = chunkForClassification(cs);
    expect(chunks).toHaveLength(MAX_CLASSIFY_CALLS);
    expect(chunks[0]).toHaveLength(MAX_REPLIES_IN_PROMPT);
  });

  it('total chunked count never exceeds the shallow-mode call ceiling', () => {
    const total = MAX_REPLIES_IN_PROMPT * (MAX_CLASSIFY_CALLS + 1);
    const cs = Array.from({ length: total }, (_, i) => mkComment(String(i)));
    const chunks = chunkForClassification(cs);
    expect(chunks).toHaveLength(MAX_CLASSIFY_CALLS);
    expect(chunks.flat()).toHaveLength(MAX_CLASSIFY_CALLS * MAX_REPLIES_IN_PROMPT);
  });
});

describe('renderClassificationPrompt', () => {
  it('includes root post handle/text and one bullet per reply with id+handle+likes', () => {
    const root = mkPost('1001', 'Why scaling has decelerated.');
    const batch = [
      mkComment('2001', { text: 'this is right', metrics: { likes: 42 } }),
      mkComment('2002', { text: 'actually wrong because…', metrics: { likes: 9 } }),
    ];
    const rendered = renderClassificationPrompt(root, batch);
    expect(rendered).toContain('@u');
    expect(rendered).toContain('Why scaling has decelerated.');
    expect(rendered).toContain('id=2001');
    expect(rendered).toContain('id=2002');
    expect(rendered).toContain('@u2001');
    expect(rendered).toContain('likes=42');
    expect(rendered).toContain('"classifications"');
  });
});

describe('classifyComments — happy path', () => {
  it('mutates comments with classification + records a stance distribution', async () => {
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify(fixture),
      model: 'gemini-2.5-flash',
      cached: false,
    });

    const comments = (fixture.classifications as Array<{ id: string }>).map((c) => mkComment(c.id));
    const thread = mkThread(comments);

    const outcome = await classifyComments(thread);

    expect(outcome.classifiedCount).toBe(7);
    expect(outcome.callCount).toBe(1);
    expect(outcome.warnings).toEqual([]);

    // every comment now has classification attached
    for (const c of comments) {
      expect(c.classification).toBeDefined();
    }
    expect(comments[0]!.classification?.stance).toBe('agree');
    expect(comments[1]!.classification?.quality).toBe('expert');

    // chat() was called with the cache key + classification system prompt + JSON mode
    expect(mockChat).toHaveBeenCalledTimes(1);
    const arg = mockChat.mock.calls[0]![0];
    expect(arg.jsonMode).toBe(true);
    expect(arg.cacheKey).toContain(`comment-classify-batch:${CLASSIFY_VERSION}:`);
    expect(arg.messages[0]?.content).toBe(CLASSIFICATION_SYSTEM_PROMPT);

    const dist = computeStanceDistribution(thread);
    expect(dist.agree).toBe(2);
    expect(dist.disagree).toBe(1);
    expect(dist.humor).toBe(1);
    expect(dist.question).toBe(1);
    expect(dist.neutral).toBe(1);
    expect(dist.meta).toBe(1);
  });

  it('returns zero-call outcome when the thread has no comments', async () => {
    const thread = mkThread([]);
    const outcome = await classifyComments(thread);
    expect(outcome).toEqual({
      classifiedCount: 0,
      callCount: 0,
      warnings: [],
      prefilterApplied: false,
      candidatePool: 0,
      classifiedFromPool: 0,
    });
    expect(mockChat).not.toHaveBeenCalled();
  });
});

describe('classifyComments — error paths surface clearly', () => {
  it('emits a partial warning when Kyma returns non-JSON (does not throw)', async () => {
    mockChat.mockResolvedValueOnce({
      content: 'sorry I am a language model and cannot do that',
      model: 'gemini-2.5-flash',
      cached: false,
    });
    const thread = mkThread([mkComment('2001')]);
    const outcome = await classifyComments(thread);
    expect(outcome.classifiedCount).toBe(0);
    expect(outcome.warnings.some((w) => w.startsWith('Partial: classification batch failed'))).toBe(
      true,
    );
    expect(thread.comments[0]!.classification).toBeUndefined();
  });

  it('emits a partial warning on schema mismatch (missing required fields)', async () => {
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({ classifications: [{ id: '2001', stance: 'banana' }] }),
      model: 'gemini-2.5-flash',
      cached: false,
    });
    const thread = mkThread([mkComment('2001')]);
    const outcome = await classifyComments(thread);
    expect(outcome.classifiedCount).toBe(0);
    expect(outcome.warnings.some((w) => w.includes('classification batch failed'))).toBe(true);
  });
});

describe('classifyComments — partial cap (P1.2 prefilter)', () => {
  it('classifies top MAX_REPLIES_IN_PROMPT by engagement and warns about the tail', async () => {
    // Build a thread larger than a single batch: prefilter must trim to 40.
    const total = MAX_REPLIES_IN_PROMPT + 7;
    const comments = Array.from({ length: total }, (_, i) => mkComment(`c${i}`));
    const thread = mkThread(comments);

    mockChat.mockResolvedValue({
      content: JSON.stringify({ classifications: [] }),
      model: 'gemini-2.5-flash',
      cached: false,
    });

    const outcome = await classifyComments(thread);
    // Single Kyma call (MAX_CLASSIFY_CALLS = 1 in shallow mode)
    expect(outcome.callCount).toBe(MAX_CLASSIFY_CALLS);
    expect(mockChat).toHaveBeenCalledTimes(MAX_CLASSIFY_CALLS);
    expect(outcome.prefilterApplied).toBe(true);
    expect(outcome.candidatePool).toBe(total);
    expect(outcome.warnings.some((w) => w.includes('shallow-mode prefilter'))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// P1.2 — engagement pre-filter
// ───────────────────────────────────────────────────────────────────────────

describe('engagementScore (P1.2)', () => {
  it('computes likes + 2*replies + verified boost', () => {
    const plain = mkComment('a', { metrics: { likes: 10 } });
    expect(engagementScore(plain)).toBe(10);

    const withReplies = mkComment('b', {
      metrics: { likes: 10 },
      replies: [mkComment('b1'), mkComment('b2')],
    });
    expect(engagementScore(withReplies)).toBe(10 + 2 * 2);

    const verified = mkComment('c', { metrics: { likes: 10 } });
    verified.author = { ...verified.author, verified: true };
    expect(engagementScore(verified)).toBe(10 + 50);
  });

  it('treats missing likes as 0', () => {
    const c = mkComment('a', { metrics: {} });
    expect(engagementScore(c)).toBe(0);
  });
});

describe('prefilterByEngagement (P1.2)', () => {
  it('returns the input unchanged when length <= limit', () => {
    const cs = Array.from({ length: 5 }, (_, i) => mkComment(`c${i}`, { metrics: { likes: i } }));
    expect(prefilterByEngagement(cs, 10)).toBe(cs); // identity — no sort, no copy
  });

  it('orders by engagement score descending and trims to limit', () => {
    const cs = [
      mkComment('low', { metrics: { likes: 1 } }),
      mkComment('mid', { metrics: { likes: 50 } }),
      mkComment('high', { metrics: { likes: 200 } }),
      mkComment('verifiedSmall', { metrics: { likes: 5 } }),
      mkComment('noisy', { metrics: { likes: 0 } }),
    ];
    // Promote one entry via verified-author boost (+50) so it beats mid (50 ties → DFS order wins)
    cs[3]!.author = { ...cs[3]!.author, verified: true };
    const top3 = prefilterByEngagement(cs, 3);
    expect(top3.map((c) => c.id)).toEqual(['high', 'verifiedSmall', 'mid']);
  });

  it('breaks ties by original DFS index (stable)', () => {
    const cs = [
      mkComment('first', { metrics: { likes: 10 } }),
      mkComment('second', { metrics: { likes: 10 } }),
      mkComment('third', { metrics: { likes: 10 } }),
    ];
    const top2 = prefilterByEngagement(cs, 2);
    expect(top2.map((c) => c.id)).toEqual(['first', 'second']);
  });
});

describe('classifyComments — prefilter integration (P1.2)', () => {
  it('skips prefilter when fetched <= MAX_REPLIES_IN_PROMPT', async () => {
    const cs = Array.from({ length: 5 }, (_, i) =>
      mkComment(`c${i}`, { metrics: { likes: i * 10 } }),
    );
    const thread = mkThread(cs);
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({ classifications: [] }),
      model: 'gemini-2.5-flash',
      cached: false,
    });
    const outcome = await classifyComments(thread);
    expect(outcome.prefilterApplied).toBe(false);
    expect(outcome.candidatePool).toBe(5);
    expect(outcome.warnings).toEqual([]);
  });

  it('passes the top-by-engagement batch to chat() when fetched > MAX_REPLIES_IN_PROMPT', async () => {
    // 41 comments with engagement = idx; expect ids 40..1 (top 40 desc) to be in the prompt
    const cs = Array.from({ length: MAX_REPLIES_IN_PROMPT + 1 }, (_, i) =>
      mkComment(`c${i}`, { metrics: { likes: i } }),
    );
    const thread = mkThread(cs);
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({ classifications: [] }),
      model: 'gemini-2.5-flash',
      cached: false,
    });
    const outcome = await classifyComments(thread);
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(outcome.prefilterApplied).toBe(true);
    expect(outcome.candidatePool).toBe(MAX_REPLIES_IN_PROMPT + 1);

    const userMsg = mockChat.mock.calls[0]![0].messages[1]!.content as string;
    // Highest-engagement id (c40) must be in the prompt; lowest (c0) must NOT.
    expect(userMsg).toContain('id=c40');
    expect(userMsg).not.toContain('id=c0 ');
    // The batch cache key encodes the filtered ids, so it changes when prefilter selects a different set.
    expect(mockChat.mock.calls[0]![0].cacheKey).toContain(
      `comment-classify-batch:${CLASSIFY_VERSION}:`,
    );
  });

  it('produces deterministic cache keys for the same filtered set', async () => {
    const cs = Array.from({ length: MAX_REPLIES_IN_PROMPT + 2 }, (_, i) =>
      mkComment(`c${i}`, { metrics: { likes: i } }),
    );
    mockChat.mockResolvedValue({
      content: JSON.stringify({ classifications: [] }),
      model: 'gemini-2.5-flash',
      cached: false,
    });
    await classifyComments(mkThread(cs));
    await classifyComments(mkThread(cs.slice())); // same set, fresh array
    const key1 = mockChat.mock.calls[0]![0].cacheKey;
    const key2 = mockChat.mock.calls[1]![0].cacheKey;
    expect(key1).toBe(key2);
  });
});
