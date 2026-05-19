/**
 * P4.0 — Embedding store tests.
 *
 * Uses the same in-memory db shim pattern as `tests/unit/article.test.ts`
 * — we never actually load sqlite-vec or open bun:sqlite. The shim
 * implements just enough of the bun:sqlite Database surface that
 * `putEmbedding`, `getEmbedding`, `searchSimilar`, `embeddingCount`,
 * and `clearEmbeddings` exercise.
 *
 * `ensureVecReady()` is forced into the fallback path by making
 * `loadExtension` throw on the fake db, which is what the JS-cosine
 * branch is for in the first place. That gives us deterministic
 * coverage of the path most users on macOS arm64 will NOT hit, and
 * proves the fallback math agrees with the in-line `cosineSimilarity`
 * helper.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Same as the orchestrator test — silence the fallback WARN that the
// in-memory shim deliberately triggers on first put/search.
process.env.XRAY_LOG_LEVEL = 'error';

import {
  _resetVecStateForTests,
  _setDbModuleForTests,
  clearEmbeddings,
  cosineSimilarity,
  embeddingCount,
  embeddingStorageBytes,
  getEmbedding,
  hashContent,
  putEmbedding,
  searchSimilar,
} from '../../src/embeddings/store.ts';

// ──────────────────────────────────────────────────────────────────
// In-memory db shim — mirrors `tests/unit/article.test.ts`
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
type VectorRow = {
  entity_type: string;
  entity_id: string;
  vector: Buffer;
};

const tables = {
  embedding_meta: new Map<string, MetaRow>(),
  embedding_vectors: new Map<string, VectorRow>(),
};

function resetTables(): void {
  tables.embedding_meta.clear();
  tables.embedding_vectors.clear();
}

function metaKey(et: string, id: string): string {
  return `${et}::${id}`;
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
        const row = tables.embedding_meta.get(metaKey(String(params[0]), String(params[1])));
        return row;
      }
      return undefined;
    },
    all() {
      // Used by fallback searchSimilar — join meta with vectors.
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
      // Vec0 paths — should never run because loadExtension throws.
      return { lastInsertRowid: 0 };
    },
  };
}

function fakeExec(sql: string): void {
  const lower = sql.toLowerCase().trim();
  if (lower.includes('delete from embedding_meta')) {
    tables.embedding_meta.clear();
  } else if (lower.includes('delete from embedding_vectors')) {
    tables.embedding_vectors.clear();
  }
  // CREATE VIRTUAL TABLE etc. are no-ops in the shim.
}

function fakeLoadExtension(): void {
  // Force the JS-cosine fallback path — the whole point of the test
  // file is to exercise that path deterministically.
  throw new Error('shim: sqlite-vec extension disabled for tests');
}

const fakeDb = { query: fakeQuery, exec: fakeExec, loadExtension: fakeLoadExtension };

const fakeDbModule = {
  getDb: () => fakeDb,
  closeDb: () => {
    /* noop */
  },
  isFresh: () => true,
};

beforeAll(() => {
  _setDbModuleForTests(fakeDbModule as unknown as typeof import('../../src/cache/db.ts'));
});

afterEach(() => {
  // ensure each test starts from a clean store + a fresh vec attempt.
  resetTables();
  _resetVecStateForTests();
});

beforeEach(() => {
  resetTables();
  _resetVecStateForTests();
});

// ──────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────

function unitVector(seed: number): Float32Array {
  const v = new Float32Array(384);
  // Deterministic but distinct per seed; normalize at the end so
  // cosine matches the expected math.
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

describe('hashContent', () => {
  it('returns a stable 64-char sha256 hex', () => {
    const a = hashContent('hello world');
    const b = hashContent('hello world');
    const c = hashContent('hello worlD');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('cosineSimilarity', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = unitVector(1);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it('returns 0 on length mismatch (defensive)', () => {
    expect(cosineSimilarity(new Float32Array(3), new Float32Array(4))).toBe(0);
  });

  it('returns a smaller value for unrelated vectors than for the same vector', () => {
    const a = unitVector(1);
    const b = unitVector(99);
    expect(cosineSimilarity(a, b)).toBeLessThan(cosineSimilarity(a, a));
  });
});

describe('putEmbedding + getEmbedding round-trip', () => {
  it('stores and retrieves an embedding by entity', () => {
    const vec = unitVector(7);
    putEmbedding({
      meta: {
        entityType: 'post',
        entityId: 'p1',
        contentHash: hashContent('hello'),
        sourceUrl: 'https://x.com/alice/status/1',
        authorHandle: 'alice',
        snippet: 'hello',
      },
      vector: vec,
    });
    const got = getEmbedding('post', 'p1');
    expect(got).toBeDefined();
    expect(got?.snippet).toBe('hello');
    expect(got?.authorHandle).toBe('alice');
  });

  it('returns undefined for an unknown entity', () => {
    expect(getEmbedding('post', 'does-not-exist')).toBeUndefined();
  });

  it('overwrites on second put with the same entity id', () => {
    putEmbedding({
      meta: {
        entityType: 'post',
        entityId: 'p1',
        contentHash: 'h1',
        snippet: 'first',
      },
      vector: unitVector(1),
    });
    putEmbedding({
      meta: {
        entityType: 'post',
        entityId: 'p1',
        contentHash: 'h2',
        snippet: 'second',
      },
      vector: unitVector(2),
    });
    expect(embeddingCount()).toBe(1);
    expect(getEmbedding('post', 'p1')?.snippet).toBe('second');
  });

  it('rejects vectors with the wrong dimensionality', () => {
    expect(() =>
      putEmbedding({
        meta: { entityType: 'post', entityId: 'bad', contentHash: 'h', snippet: 's' },
        vector: new Float32Array(10),
      }),
    ).toThrow(/vector length 10/);
  });
});

describe('searchSimilar (pure-JS fallback)', () => {
  it('returns top-K hits in similarity order', () => {
    // Seed 5 distinct vectors; query == seed 3, expect that hit first.
    for (const seed of [1, 2, 3, 4, 5]) {
      putEmbedding({
        meta: {
          entityType: 'post',
          entityId: `p${seed}`,
          contentHash: `h${seed}`,
          snippet: `text ${seed}`,
        },
        vector: unitVector(seed),
      });
    }
    const hits = searchSimilar(unitVector(3), 3);
    expect(hits).toHaveLength(3);
    expect(hits[0]?.entityId).toBe('p3');
    expect(hits[0]?.similarity).toBeCloseTo(1, 5);
    // Subsequent hits must be in non-increasing similarity order.
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i]!.similarity).toBeLessThanOrEqual(hits[i - 1]!.similarity);
    }
  });

  it('returns an empty array when the store is empty', () => {
    expect(searchSimilar(unitVector(1), 5)).toEqual([]);
  });

  it('caps results at the requested limit', () => {
    for (let i = 0; i < 8; i++) {
      putEmbedding({
        meta: { entityType: 'post', entityId: `p${i}`, contentHash: `h${i}`, snippet: '' },
        vector: unitVector(i),
      });
    }
    expect(searchSimilar(unitVector(0), 3)).toHaveLength(3);
  });

  it('rejects query vectors with the wrong dimensionality', () => {
    expect(() => searchSimilar(new Float32Array(5))).toThrow(/query vector length 5/);
  });
});

describe('embeddingCount + embeddingStorageBytes', () => {
  it('counts up as embeddings are added', () => {
    expect(embeddingCount()).toBe(0);
    expect(embeddingStorageBytes()).toBe(0);
    for (let i = 0; i < 4; i++) {
      putEmbedding({
        meta: { entityType: 'post', entityId: `p${i}`, contentHash: `h${i}`, snippet: '' },
        vector: unitVector(i),
      });
    }
    expect(embeddingCount()).toBe(4);
    // Each row ≈ 1786 bytes; total should be 4 * that.
    expect(embeddingStorageBytes()).toBe(4 * (1536 + 250));
  });
});

describe('clearEmbeddings', () => {
  it('wipes every row', () => {
    putEmbedding({
      meta: { entityType: 'post', entityId: 'p1', contentHash: 'h', snippet: '' },
      vector: unitVector(1),
    });
    expect(embeddingCount()).toBe(1);
    clearEmbeddings();
    expect(embeddingCount()).toBe(0);
    expect(getEmbedding('post', 'p1')).toBeUndefined();
  });
});
