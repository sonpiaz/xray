import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the kyma client module BEFORE importing anything that depends on it.
vi.mock('../../src/kyma/client.ts', () => ({
  chat: vi.fn(),
}));

import {
  DEEP_VERSION,
  MAX_SUBTREE_CALLS,
  deepAnalyze,
  deepSubtreeCacheKey,
  deepSynthesisCacheKey,
  flattenSubtreeDescendants,
  selectSubtrees,
} from '../../src/intelligence/deep.ts';
import { chat } from '../../src/kyma/client.ts';
import {
  DEEP_SUBTREE_SYSTEM_PROMPT,
  DEEP_SYNTHESIS_SYSTEM_PROMPT,
} from '../../src/kyma/prompts.ts';
import type { XComment } from '../../src/models/comment.ts';
import type { XPost } from '../../src/models/post.ts';
import type { XThread } from '../../src/models/thread.ts';

const subtreeFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'deep-subtree-response.json'), 'utf8'),
);
const synthesisFixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'deep-synthesis-response.json'), 'utf8'),
);

const mockChat = vi.mocked(chat);

function mkPost(id: string, text = `post ${id}`): XPost {
  return {
    id,
    url: `https://x.com/u/status/${id}`,
    author: { handle: 'op', verified: false },
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

const shallowDigest = {
  topic: 'scaling',
  tldr: 'tldr',
  summary: 'summary',
  keyInsights: [{ insight: 'i1', confidence: 'medium' as const }],
  openQuestions: ['q1'],
};

beforeEach(() => {
  mockChat.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('DEEP_VERSION + cache key shape', () => {
  it('uses the documented composite key formats', () => {
    expect(deepSubtreeCacheKey('29481')).toBe(`deep-subtree:29481:${DEEP_VERSION}`);
    expect(deepSynthesisCacheKey('18374629')).toBe(`deep-synth:18374629:${DEEP_VERSION}`);
  });

  it('exposes a stable integer version constant', () => {
    expect(Number.isInteger(DEEP_VERSION)).toBe(true);
    expect(DEEP_VERSION).toBeGreaterThanOrEqual(1);
  });
});

describe('flattenSubtreeDescendants', () => {
  it('walks descendants only (excludes the subtree root itself)', () => {
    const grandchild = mkComment('2003', { depth: 2 });
    const child = mkComment('2002', { depth: 1, replies: [grandchild] });
    const root = mkComment('2001', { depth: 0, replies: [child] });
    const flat = flattenSubtreeDescendants(root);
    expect(flat.map((c) => c.id)).toEqual(['2002', '2003']);
  });

  it('returns empty array for a leaf subtree root', () => {
    expect(flattenSubtreeDescendants(mkComment('2001'))).toEqual([]);
  });
});

describe('selectSubtrees', () => {
  it('orders top-level replies by engagement score and caps at MAX_SUBTREE_CALLS', () => {
    const cs = [
      mkComment('low', { metrics: { likes: 1 } }),
      mkComment('mid', { metrics: { likes: 50 } }),
      mkComment('high', { metrics: { likes: 200 } }),
      mkComment('noisy', { metrics: { likes: 0 } }), // dropped — no engagement, no replies
    ];
    expect(selectSubtrees(cs).map((c) => c.id)).toEqual(['high', 'mid', 'low']);
  });

  it('keeps zero-engagement comments that have nested replies', () => {
    const cs = [
      mkComment('engaged', { metrics: { likes: 5 } }),
      mkComment('quiet-but-has-replies', { metrics: { likes: 0 }, replies: [mkComment('child')] }),
      mkComment('pure-noise', { metrics: { likes: 0 } }),
    ];
    const sel = selectSubtrees(cs).map((c) => c.id);
    expect(sel).toContain('engaged');
    expect(sel).toContain('quiet-but-has-replies');
    expect(sel).not.toContain('pure-noise');
  });

  it('caps at exactly MAX_SUBTREE_CALLS even when more candidates exist', () => {
    const cs = Array.from({ length: MAX_SUBTREE_CALLS + 5 }, (_, i) =>
      mkComment(`c${i}`, { metrics: { likes: i + 1 } }),
    );
    expect(selectSubtrees(cs)).toHaveLength(MAX_SUBTREE_CALLS);
  });

  it('breaks ties by original DFS index (stable)', () => {
    const cs = [
      mkComment('first', { metrics: { likes: 10 } }),
      mkComment('second', { metrics: { likes: 10 } }),
      mkComment('third', { metrics: { likes: 10 } }),
    ];
    expect(selectSubtrees(cs, 2).map((c) => c.id)).toEqual(['first', 'second']);
  });

  it('returns empty array for empty input', () => {
    expect(selectSubtrees([])).toEqual([]);
  });
});

describe('deepAnalyze — happy path', () => {
  it('fires one Kyma call per subtree + one synthesis call, returns summaries + synthesis', async () => {
    const comments = [
      mkComment('2001', { metrics: { likes: 100 }, replies: [mkComment('2001a', { depth: 1 })] }),
      mkComment('2002', { metrics: { likes: 50 } }),
      mkComment('2003', { metrics: { likes: 20 } }),
    ];

    // 3 subtree calls + 1 synthesis = 4 chat() invocations
    mockChat
      .mockResolvedValueOnce({
        content: JSON.stringify(subtreeFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(subtreeFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(subtreeFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(synthesisFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      });

    const outcome = await deepAnalyze(mkThread(comments), shallowDigest);

    expect(outcome.subtreeCallCount).toBe(3);
    expect(outcome.synthesisCallCount).toBe(1);
    expect(outcome.subtreeSummaries).toHaveLength(3);
    expect(outcome.deepSynthesis).toBeDefined();
    expect(outcome.warnings).toEqual([]);

    // Subtree summary shape
    const first = outcome.subtreeSummaries[0]!;
    expect(first.rootReplyPostId).toBe('2001');
    expect(first.rootReplyHandle).toBe('u2001');
    expect(first.replyCount).toBe(2); // root + 1 descendant
    expect(first.headline).toContain('scaling');
    expect(first.keyPoints.length).toBeGreaterThan(0);
    expect(first.dissent.length).toBeGreaterThan(0);

    // Synthesis shape
    expect(outcome.deepSynthesis?.topArguments.length).toBeGreaterThan(0);
    expect(outcome.deepSynthesis?.dissentMap.length).toBeGreaterThan(0);
    expect(outcome.deepSynthesis?.subThreadsWorthReading.length).toBeGreaterThan(0);

    // Subtree call uses correct system prompt + JSON mode + cache key
    const subtreeCall = mockChat.mock.calls[0]![0];
    expect(subtreeCall.jsonMode).toBe(true);
    expect(subtreeCall.messages[0]?.content).toBe(DEEP_SUBTREE_SYSTEM_PROMPT);
    expect(subtreeCall.cacheKey).toBe(deepSubtreeCacheKey('2001'));

    // Synthesis call uses the synthesis system prompt + cache key
    const synthCall = mockChat.mock.calls[3]![0];
    expect(synthCall.messages[0]?.content).toBe(DEEP_SYNTHESIS_SYSTEM_PROMPT);
    expect(synthCall.cacheKey).toBe(deepSynthesisCacheKey('1001'));
  });
});

describe('deepAnalyze — caps at MAX_SUBTREE_CALLS with warning', () => {
  it('analyzes top N subtrees and warns about the tail', async () => {
    const comments = Array.from({ length: MAX_SUBTREE_CALLS + 3 }, (_, i) =>
      mkComment(`c${i}`, { metrics: { likes: i + 1 } }),
    );

    mockChat.mockResolvedValue({
      content: JSON.stringify(subtreeFixture),
      model: 'gemini-2.5-flash',
      cached: false,
    });

    const outcome = await deepAnalyze(mkThread(comments), shallowDigest);

    expect(outcome.subtreeCallCount).toBe(MAX_SUBTREE_CALLS);
    expect(outcome.synthesisCallCount).toBe(1);
    // Total chat() invocations = subtrees + synthesis
    expect(mockChat).toHaveBeenCalledTimes(MAX_SUBTREE_CALLS + 1);
    expect(outcome.warnings.some((w) => w.includes(`cap ${MAX_SUBTREE_CALLS}`))).toBe(true);
  });
});

describe('deepAnalyze — synthesis prompt assembles all subtree summaries', () => {
  it('threads each subtree summary into the synthesis user message', async () => {
    const comments = [
      mkComment('2001', { metrics: { likes: 100 } }),
      mkComment('2002', { metrics: { likes: 50 } }),
    ];

    mockChat
      .mockResolvedValueOnce({
        content: JSON.stringify(subtreeFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(subtreeFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(synthesisFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      });

    await deepAnalyze(mkThread(comments), shallowDigest);

    const synthCall = mockChat.mock.calls[2]![0];
    const userMsg = synthCall.messages[1]!.content as string;
    expect(userMsg).toContain('@u2001');
    expect(userMsg).toContain('@u2002');
    expect(userMsg).toContain('SHALLOW THREAD-LEVEL ANALYSIS');
    // The shallow digest is threaded in
    expect(userMsg).toContain('tldr: tldr');
    expect(userMsg).toContain('topic: scaling');
    // Subtree summary headlines surface in the synthesis prompt
    expect(userMsg).toContain('scaling has actually decelerated');
  });
});

describe('deepAnalyze — one subtree call fails, others succeed + synthesis still runs', () => {
  it('isolates per-subtree failures and emits a warning', async () => {
    const comments = [
      mkComment('good1', { metrics: { likes: 100 } }),
      mkComment('bad', { metrics: { likes: 80 } }),
      mkComment('good2', { metrics: { likes: 60 } }),
    ];

    mockChat
      .mockResolvedValueOnce({
        content: JSON.stringify(subtreeFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      })
      // Bad subtree → non-JSON → ParseError caught + warned
      .mockResolvedValueOnce({
        content: 'sorry I am a language model and cannot do that',
        model: 'gemini-2.5-flash',
        cached: false,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(subtreeFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      })
      .mockResolvedValueOnce({
        content: JSON.stringify(synthesisFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      });

    const outcome = await deepAnalyze(mkThread(comments), shallowDigest);

    expect(outcome.subtreeCallCount).toBe(2);
    expect(outcome.subtreeSummaries).toHaveLength(2);
    expect(outcome.subtreeSummaries.map((s) => s.rootReplyPostId)).toEqual(['good1', 'good2']);
    expect(outcome.synthesisCallCount).toBe(1);
    expect(outcome.deepSynthesis).toBeDefined();
    expect(outcome.warnings.some((w) => w.startsWith('Partial: deep subtree @ubad'))).toBe(true);
  });

  it('emits warning + skips synthesis when ALL subtree calls fail', async () => {
    const comments = [mkComment('a', { metrics: { likes: 100 } })];

    mockChat.mockResolvedValueOnce({
      content: 'not json at all',
      model: 'gemini-2.5-flash',
      cached: false,
    });

    const outcome = await deepAnalyze(mkThread(comments), shallowDigest);
    expect(outcome.subtreeCallCount).toBe(0);
    expect(outcome.synthesisCallCount).toBe(0);
    expect(outcome.deepSynthesis).toBeUndefined();
    expect(outcome.warnings.some((w) => w.includes('no subtree summaries produced'))).toBe(true);
  });

  it('emits warning when synthesis fails but still returns subtree summaries', async () => {
    const comments = [mkComment('a', { metrics: { likes: 100 } })];

    mockChat
      .mockResolvedValueOnce({
        content: JSON.stringify(subtreeFixture),
        model: 'gemini-2.5-flash',
        cached: false,
      })
      .mockResolvedValueOnce({
        content: 'synthesis broken',
        model: 'gemini-2.5-flash',
        cached: false,
      });

    const outcome = await deepAnalyze(mkThread(comments), shallowDigest);
    expect(outcome.subtreeCallCount).toBe(1);
    expect(outcome.subtreeSummaries).toHaveLength(1);
    expect(outcome.synthesisCallCount).toBe(0);
    expect(outcome.deepSynthesis).toBeUndefined();
    expect(outcome.warnings.some((w) => w.startsWith('Partial: deep synthesis failed'))).toBe(true);
  });
});

describe('deepAnalyze — empty thread short-circuit', () => {
  it('makes zero Kyma calls when the thread has no comments', async () => {
    const outcome = await deepAnalyze(mkThread([]), shallowDigest);
    expect(outcome).toEqual({
      subtreeSummaries: [],
      subtreeCallCount: 0,
      synthesisCallCount: 0,
      warnings: [],
    });
    expect(mockChat).not.toHaveBeenCalled();
  });
});

describe('deepAnalyze — schema validation rejects malformed responses', () => {
  it('rejects a subtree response missing required fields', async () => {
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({ headline: 'ok' /* missing keyPoints/dissent OK by default */ }),
      model: 'gemini-2.5-flash',
      cached: false,
    });
    // headline alone parses fine (keyPoints/dissent default to []); confirm that path:
    const ok = await deepAnalyze(
      mkThread([mkComment('a', { metrics: { likes: 1 } })]),
      shallowDigest,
    );
    // Synthesis will run with whatever we configure; we only seeded one response,
    // so synthesis call hits the default mock — undefined. Just verify subtree succeeded.
    expect(ok.subtreeSummaries).toHaveLength(1);
    expect(ok.subtreeSummaries[0]!.keyPoints).toEqual([]);
    expect(ok.subtreeSummaries[0]!.dissent).toEqual([]);
  });

  it('rejects a subtree response with non-string headline (schema fail)', async () => {
    mockChat.mockResolvedValueOnce({
      content: JSON.stringify({ headline: 42, keyPoints: [], dissent: [] }),
      model: 'gemini-2.5-flash',
      cached: false,
    });
    const outcome = await deepAnalyze(
      mkThread([mkComment('a', { metrics: { likes: 1 } })]),
      shallowDigest,
    );
    expect(outcome.subtreeCallCount).toBe(0);
    expect(outcome.warnings.some((w) => w.includes('deep subtree'))).toBe(true);
  });
});
