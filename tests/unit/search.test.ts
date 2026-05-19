/**
 * P4.1 — Semantic search orchestrator tests.
 *
 * Same shim approach as `tests/unit/embeddings.test.ts`: install an
 * in-memory db shim so `searchSimilar()` returns deterministic rows
 * pulled from a tiny fake `embedding_meta` + `embedding_vectors`
 * table. The MiniLM provider is stubbed via `_depsForTests.embedFn`,
 * and `chat()` is stubbed via the search module's `_depsForTests.chatFn`.
 *
 * Coverage:
 *   1. result-shape — query + limit + generatedAt
 *   2. limit caps results
 *   3. threshold drops low-sim rows
 *   4. typeFilter excludes non-matching rows
 *   5. snippet truncation to 200 chars
 *   6. URL derivation from handle + postId
 *   7. URL preserved when meta.sourceUrl already set
 *   8. article-passage source.url comes from sourceUrl
 *   9. rerank=true reorders + flips `reranked`
 *  10. rerank cost = 0.005 when not cached
 *  11. rerank cost = 0 when chat is cached
 *  12. rerank parse failure → fallback to semantic order
 *  13. rerank throw → fallback to semantic order
 *  14. rerank skipped when < 2 candidates
 *  15. zero results when threshold too high
 *  16. limit + threshold compose correctly
 *  17. typeFilter `thread` returns empty when no thread rows exist
 *  18. invalid limit throws
 *  19. invalid threshold throws
 *  20. estimatedCostUsd = 0 by default
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Squelch the expected sqlite-vec WARN that the in-memory shim triggers.
process.env.XRAY_LOG_LEVEL = 'error';

import {
  _resetVecStateForTests,
  _setDbModuleForTests,
  putEmbedding,
} from '../../src/embeddings/index.ts';
import { _depsForTests as providerDeps } from '../../src/embeddings/provider.ts';
import { search, _depsForTests as searchDeps } from '../../src/search/search.ts';

// ──────────────────────────────────────────────────────────────────
// In-memory db shim — minimal store of meta + vectors.
// ──────────────────────────────────────────────────────────────────

type MetaRow = {
  entity_type: string;
  entity_id: string;
  content_hash: string;
  source_url: string | null;
  author_handle: string | null;
  snippet: string;
  model_version: string;
  vec_rowid: number | null;
  created_at: number;
};
type VectorRow = { entity_type: string; entity_id: string; vector: Buffer };

const tables = {
  embedding_meta: new Map<string, MetaRow>(),
  embedding_vectors: new Map<string, VectorRow>(),
};

function metaKey(et: string, id: string): string {
  return `${et}::${id}`;
}
function resetTables(): void {
  tables.embedding_meta.clear();
  tables.embedding_vectors.clear();
}

function fakeQuery(sql: string) {
  const lower = sql.toLowerCase().trim();
  return {
    get(...params: unknown[]) {
      if (lower.includes('count(*)') && lower.includes('embedding_meta')) {
        return { c: tables.embedding_meta.size };
      }
      if (lower.includes('select vec_rowid')) {
        const row = tables.embedding_meta.get(metaKey(String(params[0]), String(params[1])));
        return row ? { vec_rowid: row.vec_rowid } : undefined;
      }
      if (lower.startsWith('select entity_type, entity_id, content_hash')) {
        return tables.embedding_meta.get(metaKey(String(params[0]), String(params[1])));
      }
      return undefined;
    },
    all() {
      if (lower.includes('from embedding_vectors v') && lower.includes('join embedding_meta')) {
        const rows: Array<MetaRow & { vector: Buffer }> = [];
        for (const v of tables.embedding_vectors.values()) {
          const m = tables.embedding_meta.get(metaKey(v.entity_type, v.entity_id));
          if (m) rows.push({ ...m, vector: v.vector });
        }
        return rows;
      }
      return [];
    },
    run(...params: unknown[]) {
      if (lower.startsWith('insert into embedding_meta')) {
        const [
          entity_type,
          entity_id,
          content_hash,
          source_url,
          author_handle,
          snippet,
          model_version,
          vec_rowid,
          created_at,
        ] = params as [
          string,
          string,
          string,
          string | null,
          string | null,
          string,
          string,
          number | null,
          number,
        ];
        tables.embedding_meta.set(metaKey(entity_type, entity_id), {
          entity_type,
          entity_id,
          content_hash,
          source_url,
          author_handle,
          snippet,
          model_version,
          vec_rowid,
          created_at,
        });
        return { lastInsertRowid: tables.embedding_meta.size };
      }
      if (lower.startsWith('insert into embedding_vectors')) {
        const [entity_type, entity_id, vector] = params as [string, string, Buffer];
        tables.embedding_vectors.set(metaKey(entity_type, entity_id), {
          entity_type,
          entity_id,
          vector,
        });
        return { lastInsertRowid: tables.embedding_vectors.size };
      }
      return { lastInsertRowid: 0 };
    },
  };
}

function fakeExec(sql: string): void {
  const lower = sql.toLowerCase().trim();
  if (lower.includes('delete from embedding_meta')) tables.embedding_meta.clear();
  else if (lower.includes('delete from embedding_vectors')) tables.embedding_vectors.clear();
}

function fakeLoadExtension(): void {
  throw new Error('shim: sqlite-vec extension disabled for tests');
}

const fakeDb = { query: fakeQuery, exec: fakeExec, loadExtension: fakeLoadExtension };
const fakeDbModule = {
  getDb: () => fakeDb,
  closeDb: () => undefined,
  isFresh: () => true,
};

// ──────────────────────────────────────────────────────────────────
// Test helpers — deterministic vectors + seed function.
// ──────────────────────────────────────────────────────────────────

function unitVector(seed: number): Float32Array {
  const v = new Float32Array(384);
  let sum = 0;
  for (let i = 0; i < 384; i++) {
    const x = Math.sin((i + 1) * (seed + 1));
    v[i] = x;
    sum += x * x;
  }
  const norm = Math.sqrt(sum);
  for (let i = 0; i < 384; i++) v[i]! /= norm;
  return v;
}

type SeedItem = {
  entityType: 'post' | 'comment' | 'article-passage';
  entityId: string;
  snippet: string;
  authorHandle?: string;
  sourceUrl?: string;
  seed: number;
};

function seed(items: SeedItem[]): void {
  for (const item of items) {
    const meta = {
      entityType: item.entityType,
      entityId: item.entityId,
      contentHash: `h-${item.entityId}`,
      snippet: item.snippet,
    } as Parameters<typeof putEmbedding>[0]['meta'];
    if (item.sourceUrl) (meta as { sourceUrl?: string }).sourceUrl = item.sourceUrl;
    if (item.authorHandle) (meta as { authorHandle?: string }).authorHandle = item.authorHandle;
    putEmbedding({ meta, vector: unitVector(item.seed) });
  }
}

// ──────────────────────────────────────────────────────────────────
// Setup
// ──────────────────────────────────────────────────────────────────

const originalEmbedFn = providerDeps.embedFn;
const originalChatFn = searchDeps.chatFn;

beforeAll(() => {
  _setDbModuleForTests(fakeDbModule as unknown as typeof import('../../src/cache/db.ts'));
});

beforeEach(() => {
  resetTables();
  _resetVecStateForTests();
  // Default embedFn returns a fixed query vector; individual tests
  // override per case to steer the rank order.
  providerDeps.embedFn = async (texts: string[]) => texts.map(() => unitVector(0));
  searchDeps.chatFn = originalChatFn;
});

afterEach(() => {
  providerDeps.embedFn = originalEmbedFn;
  searchDeps.chatFn = originalChatFn;
});

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

describe('search — basic shape', () => {
  it('returns a SearchResponse with query, limit, and ISO generatedAt', async () => {
    seed([
      { entityType: 'post', entityId: 'p1', snippet: 'hello', seed: 1, authorHandle: 'alice' },
      { entityType: 'post', entityId: 'p2', snippet: 'world', seed: 2, authorHandle: 'bob' },
    ]);
    providerDeps.embedFn = async () => [unitVector(1)];

    const resp = await search({ query: 'hello' });
    expect(resp.query).toBe('hello');
    expect(resp.limit).toBe(10);
    expect(resp.reranked).toBe(false);
    expect(resp.estimatedCostUsd).toBe(0);
    expect(new Date(resp.generatedAt).toString()).not.toBe('Invalid Date');
    expect(resp.results).toHaveLength(2);
    expect(resp.results[0]?.entityId).toBe('p1');
  });
});

describe('search — limit + threshold', () => {
  it('caps results at the requested limit', async () => {
    seed(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({
        entityType: 'post' as const,
        entityId: `p${i}`,
        snippet: `text ${i}`,
        seed: i,
      })),
    );
    providerDeps.embedFn = async () => [unitVector(1)];
    const resp = await search({ query: 'x', limit: 3 });
    expect(resp.results).toHaveLength(3);
    expect(resp.limit).toBe(3);
  });

  it('drops results below threshold', async () => {
    seed([
      { entityType: 'post', entityId: 'match', snippet: 'a', seed: 1 },
      { entityType: 'post', entityId: 'far', snippet: 'b', seed: 99 },
    ]);
    providerDeps.embedFn = async () => [unitVector(1)];
    const resp = await search({ query: 'x', threshold: 0.99 });
    expect(resp.results).toHaveLength(1);
    expect(resp.results[0]?.entityId).toBe('match');
    expect(resp.threshold).toBe(0.99);
  });

  it('returns zero results when threshold too high', async () => {
    seed([{ entityType: 'post', entityId: 'p1', snippet: 'a', seed: 1 }]);
    providerDeps.embedFn = async () => [unitVector(99)];
    const resp = await search({ query: 'x', threshold: 0.999 });
    expect(resp.results).toHaveLength(0);
  });

  it('estimatedCostUsd = 0 by default (no rerank)', async () => {
    seed([{ entityType: 'post', entityId: 'p1', snippet: 'a', seed: 1 }]);
    const resp = await search({ query: 'x' });
    expect(resp.estimatedCostUsd).toBe(0);
  });
});

describe('search — typeFilter', () => {
  it('excludes non-matching entity types', async () => {
    seed([
      { entityType: 'post', entityId: 'p1', snippet: 'post hit', seed: 1 },
      { entityType: 'comment', entityId: 'c1', snippet: 'comment hit', seed: 2 },
      { entityType: 'article-passage', entityId: 'article:u:chunk:0', snippet: 'art', seed: 3 },
    ]);
    providerDeps.embedFn = async () => [unitVector(0)];

    const resp = await search({ query: 'x', typeFilter: 'comment' });
    expect(resp.results.every((r) => r.entityType === 'comment')).toBe(true);
    expect(resp.results).toHaveLength(1);
    expect(resp.typeFilter).toBe('comment');
  });

  it('returns empty when typeFilter matches nothing in the cache', async () => {
    seed([{ entityType: 'post', entityId: 'p1', snippet: 'p', seed: 1 }]);
    const resp = await search({ query: 'x', typeFilter: 'thread' });
    expect(resp.results).toHaveLength(0);
  });
});

describe('search — snippet truncation', () => {
  it('truncates snippets longer than 200 chars with an ellipsis', async () => {
    const longSnippet = 'x'.repeat(500);
    seed([{ entityType: 'post', entityId: 'p1', snippet: longSnippet, seed: 1 }]);
    providerDeps.embedFn = async () => [unitVector(1)];
    const resp = await search({ query: 'x' });
    expect(resp.results[0]!.snippet.length).toBeLessThanOrEqual(200);
    expect(resp.results[0]!.snippet.endsWith('…')).toBe(true);
  });

  it('leaves short snippets untouched', async () => {
    seed([{ entityType: 'post', entityId: 'p1', snippet: 'short', seed: 1 }]);
    providerDeps.embedFn = async () => [unitVector(1)];
    const resp = await search({ query: 'x' });
    expect(resp.results[0]!.snippet).toBe('short');
  });
});

describe('search — URL derivation', () => {
  it('synthesizes tweet URL from handle + postId when sourceUrl missing', async () => {
    seed([{ entityType: 'post', entityId: '12345', snippet: 's', seed: 1, authorHandle: 'alice' }]);
    providerDeps.embedFn = async () => [unitVector(1)];
    const resp = await search({ query: 'x' });
    expect(resp.results[0]!.source.postId).toBe('12345');
    expect(resp.results[0]!.source.authorHandle).toBe('alice');
    expect(resp.results[0]!.source.url).toBe('https://x.com/alice/status/12345');
  });

  it('uses explicit sourceUrl when present (overrides handle-derived URL)', async () => {
    seed([
      {
        entityType: 'comment',
        entityId: 'c1',
        snippet: 's',
        seed: 1,
        authorHandle: 'bob',
        sourceUrl: 'https://x.com/bob/status/9999',
      },
    ]);
    providerDeps.embedFn = async () => [unitVector(1)];
    const resp = await search({ query: 'x' });
    expect(resp.results[0]!.source.url).toBe('https://x.com/bob/status/9999');
  });

  it('article-passage source uses sourceUrl, not derived from handle', async () => {
    seed([
      {
        entityType: 'article-passage',
        entityId: 'article:https://example.com/post:chunk:0',
        snippet: 'art',
        seed: 1,
        sourceUrl: 'https://example.com/post',
      },
    ]);
    providerDeps.embedFn = async () => [unitVector(1)];
    const resp = await search({ query: 'x' });
    expect(resp.results[0]!.source.url).toBe('https://example.com/post');
    expect(resp.results[0]!.source.postId).toBeUndefined();
  });
});

describe('search — rerank', () => {
  function makeChatFn(payload: unknown, opts?: { cached?: boolean; throwIt?: boolean }) {
    return async () => {
      if (opts?.throwIt) throw new Error('kyma down');
      return {
        content: JSON.stringify(payload),
        model: 'gemini-2.5-flash',
        cached: opts?.cached ?? false,
      };
    };
  }

  it('reorders results and flips reranked=true', async () => {
    seed([
      { entityType: 'post', entityId: 'p1', snippet: 'first', seed: 1 },
      { entityType: 'post', entityId: 'p2', snippet: 'second', seed: 2 },
      { entityType: 'post', entityId: 'p3', snippet: 'third', seed: 3 },
    ]);
    providerDeps.embedFn = async () => [unitVector(1)];

    // Tell the reranker p3 wins.
    searchDeps.chatFn = makeChatFn({
      ranked: [
        { entityId: 'p3', rerankScore: 0.99 },
        { entityId: 'p1', rerankScore: 0.5 },
        { entityId: 'p2', rerankScore: 0.1 },
      ],
    });

    const resp = await search({ query: 'x', rerank: true });
    expect(resp.reranked).toBe(true);
    expect(resp.results[0]!.entityId).toBe('p3');
    expect(resp.results[0]!.rerankScore).toBeCloseTo(0.99, 5);
    expect(resp.estimatedCostUsd).toBeCloseTo(0.005, 6);
  });

  it('reports $0 when the chat result is cached', async () => {
    seed([
      { entityType: 'post', entityId: 'p1', snippet: 'a', seed: 1 },
      { entityType: 'post', entityId: 'p2', snippet: 'b', seed: 2 },
    ]);
    providerDeps.embedFn = async () => [unitVector(1)];
    searchDeps.chatFn = makeChatFn(
      {
        ranked: [
          { entityId: 'p2', rerankScore: 0.9 },
          { entityId: 'p1', rerankScore: 0.1 },
        ],
      },
      { cached: true },
    );
    const resp = await search({ query: 'x', rerank: true });
    expect(resp.reranked).toBe(true);
    expect(resp.estimatedCostUsd).toBe(0);
  });

  it('falls back to semantic order when the rerank JSON is malformed', async () => {
    seed([
      { entityType: 'post', entityId: 'p1', snippet: 'a', seed: 1 },
      { entityType: 'post', entityId: 'p2', snippet: 'b', seed: 2 },
    ]);
    providerDeps.embedFn = async () => [unitVector(1)];
    searchDeps.chatFn = async () => ({
      content: 'not json {{{',
      model: 'm',
      cached: false,
    });
    const resp = await search({ query: 'x', rerank: true });
    expect(resp.reranked).toBe(false);
    expect(resp.estimatedCostUsd).toBe(0);
    expect(resp.results[0]!.entityId).toBe('p1');
  });

  it('falls back to semantic order when chat throws', async () => {
    seed([
      { entityType: 'post', entityId: 'p1', snippet: 'a', seed: 1 },
      { entityType: 'post', entityId: 'p2', snippet: 'b', seed: 2 },
    ]);
    providerDeps.embedFn = async () => [unitVector(1)];
    searchDeps.chatFn = makeChatFn({}, { throwIt: true });
    const resp = await search({ query: 'x', rerank: true });
    expect(resp.reranked).toBe(false);
    expect(resp.estimatedCostUsd).toBe(0);
    // Original semantic top-pick still surfaces.
    expect(resp.results[0]!.entityId).toBe('p1');
  });

  it('skips rerank when fewer than 2 candidates', async () => {
    seed([{ entityType: 'post', entityId: 'p1', snippet: 'a', seed: 1 }]);
    providerDeps.embedFn = async () => [unitVector(1)];
    let called = 0;
    searchDeps.chatFn = async () => {
      called++;
      return { content: '{}', model: 'm', cached: false };
    };
    const resp = await search({ query: 'x', rerank: true });
    expect(called).toBe(0);
    expect(resp.reranked).toBe(false);
  });

  it('drops unrepairable rerank rows and keeps what is valid', async () => {
    seed([
      { entityType: 'post', entityId: 'p1', snippet: 'a', seed: 1 },
      { entityType: 'post', entityId: 'p2', snippet: 'b', seed: 2 },
      { entityType: 'post', entityId: 'p3', snippet: 'c', seed: 3 },
    ]);
    providerDeps.embedFn = async () => [unitVector(1)];
    searchDeps.chatFn = makeChatFn({
      ranked: [
        { entityId: 'p3', rerankScore: 0.95 },
        { entityId: 'p2', rerankScore: 'oops' }, // unrepairable score
        { wrongField: 'p1', rerankScore: 0.4 }, // missing entityId → dropped
      ],
    });
    const resp = await search({ query: 'x', rerank: true });
    expect(resp.reranked).toBe(true);
    expect(resp.results[0]!.entityId).toBe('p3');
  });
});

describe('search — input validation', () => {
  it('throws when limit is not a positive integer', async () => {
    await expect(search({ query: 'x', limit: 0 })).rejects.toThrow(/positive integer/);
  });

  it('throws when threshold is out of range', async () => {
    await expect(search({ query: 'x', threshold: 1.5 })).rejects.toThrow(/threshold must be in/);
  });
});
