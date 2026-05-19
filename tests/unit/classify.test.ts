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
  flattenComments,
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

  it('splits at MAX_REPLIES_IN_PROMPT boundaries', () => {
    const cs = Array.from({ length: MAX_REPLIES_IN_PROMPT + 1 }, (_, i) => mkComment(String(i)));
    const chunks = chunkForClassification(cs);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(MAX_REPLIES_IN_PROMPT);
    expect(chunks[1]).toHaveLength(1);
  });

  it('caps total chunks at MAX_CLASSIFY_CALLS — excess comments are skipped this run', () => {
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
    expect(outcome).toEqual({ classifiedCount: 0, callCount: 0, warnings: [] });
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

describe('classifyComments — partial cap', () => {
  it('warns when fetched count exceeds shallow-mode cap (no third Kyma call attempted)', async () => {
    // Build a thread larger than the cap: cap = MAX_CLASSIFY_CALLS * MAX_REPLIES_IN_PROMPT
    const total = MAX_CLASSIFY_CALLS * MAX_REPLIES_IN_PROMPT + 3;
    const comments = Array.from({ length: total }, (_, i) => mkComment(`c${i}`));
    const thread = mkThread(comments);

    mockChat.mockResolvedValue({
      content: JSON.stringify({ classifications: [] }),
      model: 'gemini-2.5-flash',
      cached: false,
    });

    const outcome = await classifyComments(thread);
    // Two chunks dispatched, not three
    expect(outcome.callCount).toBe(MAX_CLASSIFY_CALLS);
    expect(mockChat).toHaveBeenCalledTimes(MAX_CLASSIFY_CALLS);
    expect(outcome.warnings.some((w) => w.includes('shallow-mode cap'))).toBe(true);
  });
});
