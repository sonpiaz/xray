/**
 * P4.2 — Profile analysis orchestrator tests.
 *
 * Stubs:
 *   - `chat()` via `_orchestratorDeps.chat` so the 3 synthesis calls
 *     return deterministic JSON the orchestrator can parse.
 *   - `getCachedProfile` / `putCachedProfile` via the cache module
 *     test-seam so cache hits/misses are explicit.
 *   - The db module via `_setDbModuleForTests()` so the
 *     `collectSnippetsForHandle()` walk returns synthetic rows from
 *     `embedding_meta` + `threads`.
 *
 * Coverage:
 *   1. Empty cache → throws clear "No cached data" error
 *   2. Happy path with embedding rows → ProfileReport assembled
 *   3. Cache hit → skips Kyma calls
 *   4. `noCache=true` bypasses cache → calls Kyma
 *   5. `--fresh N` silently warns + still uses cache
 *   6. Defensive snippet cap warns + truncates
 *   7. Cost sums across 3 calls (each ~$0.02)
 *   8. Cached chat responses contribute $0
 *   9. Empty Kyma response → partial + warnings
 *  10. KYMA_API_KEY missing → throws
 *  11. Threads-table-only fallback (handle has data in threads but not embeddings)
 *  12. Stance call B skipped when Call A returns no topics
 *  13. Stance synonym repair (optimistic → bullish)
 *  14. Notable quote snippetIndex attribution
 *  15. Handle normalization (@karpathy → karpathy)
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Squelch expected WARN logs from the lenient repair + fresh fallback.
process.env.XRAY_LOG_LEVEL = 'error';
// Set KYMA_API_KEY so the synthesis path runs (the test seam stubs the
// actual chat() call, so the key value is irrelevant — it just has to
// be non-empty for loadConfig() to skip the throw).
process.env.KYMA_API_KEY = 'test-key';

import { resetConfigForTests } from '../../src/core/config.ts';
import {
  _SNIPPETS_CAP,
  _orchestratorDeps,
  _setCacheModuleForTests,
  _setDbModuleForTests,
  analyzeProfile,
} from '../../src/intelligence/profile.ts';
import type { ProfileReport } from '../../src/models/profile.ts';

// ──────────────────────────────────────────────────────────────────
// In-memory db shim — fakes embedding_meta + threads tables.
// ──────────────────────────────────────────────────────────────────

type EmbedRow = {
  entity_type: string;
  entity_id: string;
  source_url: string | null;
  author_handle: string | null;
  snippet: string;
};

type ThreadRow = { json: string };

const tables = {
  embedding_meta: [] as EmbedRow[],
  threads: [] as ThreadRow[],
};

function resetTables(): void {
  tables.embedding_meta = [];
  tables.threads = [];
}

function fakeQuery(sql: string) {
  const lower = sql.toLowerCase().trim();
  return {
    get() {
      return undefined;
    },
    all(...params: unknown[]) {
      if (lower.includes('from embedding_meta')) {
        const handle = String(params[0] ?? '');
        return tables.embedding_meta.filter((r) => r.author_handle === handle);
      }
      if (lower.includes('from threads')) {
        return tables.threads;
      }
      return [];
    },
    run() {
      return { lastInsertRowid: 0 };
    },
  };
}

const fakeDb = { query: fakeQuery, exec: () => undefined };
const fakeDbModule = {
  getDb: () => fakeDb,
  closeDb: () => undefined,
  isFresh: () => true,
};

// ──────────────────────────────────────────────────────────────────
// Cache shim — in-memory profile_cache.
// ──────────────────────────────────────────────────────────────────

const profileCacheStore = new Map<string, ProfileReport>();

const fakeCacheModule = {
  normalizeHandle: (h: string) => h.trim().replace(/^@/, '').toLowerCase(),
  getCachedProfile: (handle: string) => profileCacheStore.get(handle.toLowerCase()),
  putCachedProfile: (report: ProfileReport) => {
    profileCacheStore.set(report.handle.toLowerCase(), report);
  },
  clearProfileCache: () => profileCacheStore.clear(),
  profileCacheCount: () => profileCacheStore.size,
};

// ──────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────

const originalChat = _orchestratorDeps.chat;

type ChatRes = { content: string; model: string; cached: boolean };

function makeSequencedChat(responses: ChatRes[]): { fn: typeof originalChat; calls: number } {
  let i = 0;
  const state = { calls: 0 };
  const fn = (async () => {
    state.calls++;
    const next = responses[i] ?? responses[responses.length - 1];
    i++;
    return next!;
  }) as typeof originalChat;
  return { fn, calls: state.calls } as unknown as {
    fn: typeof originalChat;
    calls: number;
  };
}

function seedEmbeddings(
  rows: Array<{
    entityType: 'post' | 'comment';
    entityId: string;
    snippet: string;
    handle: string;
    sourceUrl?: string;
  }>,
): void {
  for (const r of rows) {
    tables.embedding_meta.push({
      entity_type: r.entityType,
      entity_id: r.entityId,
      author_handle: r.handle,
      source_url: r.sourceUrl ?? null,
      snippet: r.snippet,
    });
  }
}

function seedThread(handle: string, rootText: string, authorPosts: string[] = []): void {
  const thread = {
    rootPost: {
      id: 'root-1',
      url: `https://x.com/${handle}/status/root-1`,
      text: rootText,
      author: { handle, displayName: handle, verified: false },
      createdAt: '2026-05-19T10:00:00.000Z',
      metrics: { likes: 1, reposts: 0, replies: 0 },
      media: [],
      links: [],
      raw: {},
    },
    authorPosts: authorPosts.map((text, idx) => ({
      id: `ap-${idx}`,
      url: `https://x.com/${handle}/status/ap-${idx}`,
      text,
      author: { handle, displayName: handle, verified: false },
      createdAt: '2026-05-19T10:00:00.000Z',
      metrics: { likes: 1, reposts: 0, replies: 0 },
      media: [],
      links: [],
      raw: {},
    })),
    comments: [],
    quotes: [],
    rootCommentCount: 0,
    fetchedAt: '2026-05-19T10:00:00.000Z',
  };
  tables.threads.push({ json: JSON.stringify(thread) });
}

// ──────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────

beforeAll(() => {
  _setDbModuleForTests(fakeDbModule as unknown as typeof import('../../src/cache/db.ts'));
  _setCacheModuleForTests(
    fakeCacheModule as unknown as typeof import('../../src/cache/profiles.ts'),
  );
});

beforeEach(() => {
  resetTables();
  profileCacheStore.clear();
  _orchestratorDeps.chat = originalChat;
});

afterEach(() => {
  _orchestratorDeps.chat = originalChat;
});

// Stable response shapes the orchestrator can parse.
const happyTopics: ChatRes = {
  content: JSON.stringify({
    topics: [
      {
        topic: 'AI scaling',
        mentions: 3,
        confidence: 'high',
        representativeSnippet: 'scaling is decelerating',
      },
      { topic: 'transformer architecture', mentions: 2, confidence: 'medium' },
    ],
    expertiseAreas: ['LLMs', 'deep learning'],
  }),
  model: 'gemini-2.5-flash',
  cached: false,
};
const happyStance: ChatRes = {
  content: JSON.stringify({
    stance: [
      {
        subject: 'AI scaling',
        stance: 'skeptical',
        evidenceSnippets: ['scaling is decelerating'],
        confidence: 'high',
      },
      {
        subject: 'transformer architecture',
        stance: 'neutral',
        evidenceSnippets: [],
        confidence: 'low',
      },
    ],
  }),
  model: 'gemini-2.5-flash',
  cached: false,
};
const happyQuotes: ChatRes = {
  content: JSON.stringify({
    notableQuotes: [
      { text: 'transformer scaling is decelerating', snippetIndex: 1 },
      { text: 'attention is not all you need anymore', snippetIndex: 2 },
    ],
    summary: 'Karpathy posts pragmatic, nuanced takes on LLM research with a wry voice.',
  }),
  model: 'gemini-2.5-flash',
  cached: false,
};

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('analyzeProfile — error cases', () => {
  it('throws when no cached data exists for the handle', async () => {
    await expect(analyzeProfile({ handle: 'nonexistent' })).rejects.toThrow(/No cached data/);
  });

  it('throws when handle is empty', async () => {
    await expect(analyzeProfile({ handle: '   ' })).rejects.toThrow(/handle is required/);
  });
});

describe('analyzeProfile — happy path', () => {
  it('assembles a full ProfileReport from embeddings + 3 chat calls', async () => {
    seedEmbeddings([
      {
        entityType: 'post',
        entityId: 'p1',
        snippet: 'scaling is decelerating',
        handle: 'karpathy',
      },
      {
        entityType: 'post',
        entityId: 'p2',
        snippet: 'attention is not all you need anymore',
        handle: 'karpathy',
      },
    ]);
    const { fn } = makeSequencedChat([happyTopics, happyStance, happyQuotes]);
    _orchestratorDeps.chat = fn;

    const report = await analyzeProfile({ handle: '@karpathy' });
    expect(report.handle).toBe('karpathy');
    expect(report.samplingScope).toBe('cache');
    expect(report.topics).toHaveLength(2);
    expect(report.topics[0]!.topic).toBe('AI scaling');
    expect(report.expertiseAreas).toEqual(['LLMs', 'deep learning']);
    expect(report.stance).toHaveLength(2);
    expect(report.stance[0]!.stance).toBe('skeptical');
    expect(report.notableQuotes).toHaveLength(2);
    expect(report.summary).toContain('Karpathy');
    expect(report.cachedThreadsAnalyzed).toBe(0);
    expect(report.cachedCommentsAnalyzed).toBe(0);
    expect(report.estimatedCostUsd).toBeCloseTo(0.06, 6);
    expect(report.partial).toBe(false);
    expect(report.warnings).toEqual([]);
  });

  it('normalizes handle (@karpathy → karpathy)', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'karpathy' }]);
    const { fn } = makeSequencedChat([happyTopics, happyStance, happyQuotes]);
    _orchestratorDeps.chat = fn;
    const r = await analyzeProfile({ handle: '@Karpathy' });
    expect(r.handle).toBe('karpathy');
  });
});

describe('analyzeProfile — cache behavior', () => {
  it('returns cached report without calling Kyma when cache hit', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'karpathy' }]);
    const cached: ProfileReport = {
      handle: 'karpathy',
      samplingScope: 'cache',
      cachedThreadsAnalyzed: 1,
      cachedCommentsAnalyzed: 5,
      topics: [{ topic: 'pre-cached', mentions: 10, confidence: 'high' }],
      stance: [],
      expertiseAreas: ['ML'],
      notableQuotes: [],
      summary: 'cached summary',
      estimatedCostUsd: 0.05,
      partial: false,
      warnings: [],
      generatedAt: '2026-05-19T10:00:00.000Z',
    };
    fakeCacheModule.putCachedProfile(cached);

    let calls = 0;
    _orchestratorDeps.chat = (async () => {
      calls++;
      return { content: '{}', model: 'x', cached: false };
    }) as typeof originalChat;

    const r = await analyzeProfile({ handle: 'karpathy' });
    expect(calls).toBe(0);
    expect(r.topics[0]!.topic).toBe('pre-cached');
  });

  it('noCache=true bypasses cache hit and re-synthesizes', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'karpathy' }]);
    const cached: ProfileReport = {
      handle: 'karpathy',
      samplingScope: 'cache',
      cachedThreadsAnalyzed: 0,
      cachedCommentsAnalyzed: 0,
      topics: [{ topic: 'stale', mentions: 1, confidence: 'low' }],
      stance: [],
      expertiseAreas: [],
      notableQuotes: [],
      summary: 'stale',
      estimatedCostUsd: 0,
      partial: false,
      warnings: [],
      generatedAt: '2026-05-19T10:00:00.000Z',
    };
    fakeCacheModule.putCachedProfile(cached);

    const { fn } = makeSequencedChat([happyTopics, happyStance, happyQuotes]);
    _orchestratorDeps.chat = fn;

    const r = await analyzeProfile({ handle: 'karpathy', noCache: true });
    expect(r.topics[0]!.topic).toBe('AI scaling'); // fresh, not stale
  });
});

describe('analyzeProfile — fresh fallback', () => {
  it('silently warns + falls back to cache when --fresh is set', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'karpathy' }]);
    const { fn } = makeSequencedChat([happyTopics, happyStance, happyQuotes]);
    _orchestratorDeps.chat = fn;

    const r = await analyzeProfile({ handle: 'karpathy', fresh: 10 });
    expect(r.samplingScope).toBe('cache');
    expect(r.partial).toBe(true);
    expect(r.warnings.some((w) => w.includes('not yet implemented'))).toBe(true);
  });
});

describe('analyzeProfile — snippet cap', () => {
  it('truncates snippets past the defensive cap and warns', async () => {
    const many = Array.from({ length: _SNIPPETS_CAP + 10 }, (_, i) => ({
      entityType: 'post' as const,
      entityId: `p${i}`,
      snippet: `snippet ${i}`,
      handle: 'busy',
    }));
    seedEmbeddings(many);
    const { fn } = makeSequencedChat([happyTopics, happyStance, happyQuotes]);
    _orchestratorDeps.chat = fn;

    const r = await analyzeProfile({ handle: 'busy' });
    expect(r.partial).toBe(true);
    expect(r.warnings.some((w) => w.includes('snippet cap reached'))).toBe(true);
  });
});

describe('analyzeProfile — cost surfacing', () => {
  it('sums flat per-call cost ($0.02 x 3) when responses are fresh', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'karpathy' }]);
    const { fn } = makeSequencedChat([happyTopics, happyStance, happyQuotes]);
    _orchestratorDeps.chat = fn;
    const r = await analyzeProfile({ handle: 'karpathy' });
    expect(r.estimatedCostUsd).toBeCloseTo(0.06, 6);
  });

  it('reports $0 for cached chat responses', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'karpathy' }]);
    const cachedTopics = { ...happyTopics, cached: true };
    const cachedStance = { ...happyStance, cached: true };
    const cachedQuotes = { ...happyQuotes, cached: true };
    const { fn } = makeSequencedChat([cachedTopics, cachedStance, cachedQuotes]);
    _orchestratorDeps.chat = fn;
    const r = await analyzeProfile({ handle: 'karpathy', noCache: true });
    expect(r.estimatedCostUsd).toBe(0);
  });
});

describe('analyzeProfile — degradation', () => {
  it('marks partial when topic call throws and skips stance call', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'karpathy' }]);
    let i = 0;
    _orchestratorDeps.chat = (async () => {
      i++;
      if (i === 1) throw new Error('kyma down'); // Call A fails
      // Call B is skipped because Call A returned no topics
      // Call C should be called next — return notable quotes
      return happyQuotes;
    }) as typeof originalChat;
    const r = await analyzeProfile({ handle: 'karpathy' });
    expect(r.partial).toBe(true);
    expect(r.topics).toEqual([]);
    expect(r.stance).toEqual([]); // Call B skipped because Call A returned no topics
    expect(r.summary).toBeTruthy(); // Call C still runs independently
    expect(i).toBe(2); // A + C only (B skipped)
  });

  it('marks partial when stance call returns malformed JSON', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'karpathy' }]);
    const brokenStance: ChatRes = { content: 'not json', model: 'm', cached: false };
    const { fn } = makeSequencedChat([happyTopics, brokenStance, happyQuotes]);
    _orchestratorDeps.chat = fn;
    const r = await analyzeProfile({ handle: 'karpathy' });
    expect(r.topics).toHaveLength(2); // Topics survived
    expect(r.stance).toEqual([]); // Stance dropped silently
    expect(r.notableQuotes).toHaveLength(2); // Quotes survived
  });
});

describe('analyzeProfile — threads-table fallback', () => {
  it('walks threads table for handles with cached threads but no embeddings', async () => {
    seedThread('karpathy', 'scaling is decelerating', ['attention reconsidered']);
    const { fn } = makeSequencedChat([happyTopics, happyStance, happyQuotes]);
    _orchestratorDeps.chat = fn;
    const r = await analyzeProfile({ handle: 'karpathy' });
    expect(r.cachedThreadsAnalyzed).toBe(1);
    expect(r.handle).toBe('karpathy');
  });
});

describe('analyzeProfile — stance synonym repair', () => {
  it('coerces "optimistic" → "bullish"', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'h' }]);
    const synonymStance: ChatRes = {
      content: JSON.stringify({
        stance: [
          { subject: 'AGI', stance: 'optimistic', evidenceSnippets: [], confidence: 'medium' },
        ],
      }),
      model: 'm',
      cached: false,
    };
    const { fn } = makeSequencedChat([happyTopics, synonymStance, happyQuotes]);
    _orchestratorDeps.chat = fn;
    const r = await analyzeProfile({ handle: 'h' });
    expect(r.stance[0]!.stance).toBe('bullish');
  });

  it('drops unrepairable stance rows', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'h' }]);
    const broken: ChatRes = {
      content: JSON.stringify({
        stance: [
          { subject: 'X', stance: 'gibberish', evidenceSnippets: [], confidence: 'low' },
          { subject: 'Y', stance: 'bullish', evidenceSnippets: [], confidence: 'high' },
        ],
      }),
      model: 'm',
      cached: false,
    };
    const { fn } = makeSequencedChat([happyTopics, broken, happyQuotes]);
    _orchestratorDeps.chat = fn;
    const r = await analyzeProfile({ handle: 'h' });
    expect(r.stance).toHaveLength(1);
    expect(r.stance[0]!.subject).toBe('Y');
  });
});

describe('analyzeProfile — notable quote attribution', () => {
  it('attributes a quote to source URL + postId via snippetIndex', async () => {
    seedEmbeddings([
      {
        entityType: 'post',
        entityId: '12345',
        snippet: 'first',
        handle: 'h',
        sourceUrl: 'https://x.com/h/status/12345',
      },
      {
        entityType: 'post',
        entityId: '67890',
        snippet: 'second',
        handle: 'h',
        sourceUrl: 'https://x.com/h/status/67890',
      },
    ]);
    const quoteRes: ChatRes = {
      content: JSON.stringify({
        notableQuotes: [{ text: 'first quote', snippetIndex: 1 }],
        summary: 'tight voice',
      }),
      model: 'm',
      cached: false,
    };
    const { fn } = makeSequencedChat([happyTopics, happyStance, quoteRes]);
    _orchestratorDeps.chat = fn;
    const r = await analyzeProfile({ handle: 'h' });
    expect(r.notableQuotes[0]!.sourceUrl).toBe('https://x.com/h/status/12345');
    expect(r.notableQuotes[0]!.postId).toBe('12345');
  });

  it('omits sourceUrl when snippetIndex is out of range', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'h' }]);
    const quoteRes: ChatRes = {
      content: JSON.stringify({
        notableQuotes: [{ text: 'unattributed', snippetIndex: 99 }],
        summary: 's',
      }),
      model: 'm',
      cached: false,
    };
    const { fn } = makeSequencedChat([happyTopics, happyStance, quoteRes]);
    _orchestratorDeps.chat = fn;
    const r = await analyzeProfile({ handle: 'h' });
    expect(r.notableQuotes[0]!.sourceUrl).toBeUndefined();
  });
});

describe('analyzeProfile — KYMA_API_KEY gate', () => {
  it('throws when KYMA_API_KEY is unset', async () => {
    seedEmbeddings([{ entityType: 'post', entityId: 'p1', snippet: 's', handle: 'h' }]);
    const original = process.env.KYMA_API_KEY;
    process.env.KYMA_API_KEY = '';
    resetConfigForTests();
    try {
      await expect(analyzeProfile({ handle: 'h' })).rejects.toThrow(/KYMA_API_KEY/);
    } finally {
      process.env.KYMA_API_KEY = original;
      resetConfigForTests();
    }
  });
});
