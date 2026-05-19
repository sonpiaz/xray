/**
 * P4.0 — Embedding store. Wraps the `embedding_meta` row +
 * Float32Array vector behind a single put/get/search API.
 *
 * Two execution paths:
 *
 *   1. `sqlite-vec` extension loads successfully → we create the
 *      `vec_embeddings(rowid, embedding float[384])` virtual table at
 *      runtime and use sqlite-vec's KNN operator for O(log n) search.
 *
 *   2. The extension fails (older platform, prebuilt binary missing,
 *      etc.) → fall back to a plain `embedding_vectors(entity_type,
 *      entity_id, vector BLOB)` table and compute cosine similarity in
 *      pure JS at search time. O(n) but works everywhere bun:sqlite
 *      itself works. We log a WARN once on first attempt so the user
 *      knows search is in degraded mode.
 *
 * The lazy `bun:sqlite` import mirrors `src/cache/kyma.ts` so vitest
 * under Node can import this module at top level without crashing on
 * `bun:sqlite`. The actual db handle is grabbed only inside each
 * exported function via `getDb()`.
 *
 * Test seam: `_setDbModuleForTests()` swaps in a stub db so unit tests
 * never touch the real sqlite-vec native binary.
 */
import { createHash } from 'node:crypto';
import { logger } from '../core/logger.ts';
import type { EmbeddingMeta } from '../models/embedding.ts';
import { EMBEDDING_DIMS, EMBEDDING_MODEL_VERSION } from './provider.ts';

// ─── Lazy db module + test seam ────────────────────────────────────
// Same pattern as src/article/cache.ts. The `getDb()` resolver runs
// require() at call time (not import time) so a Node test runner can
// load this file without `bun:sqlite` being resolvable.
type DbModule = typeof import('../cache/db.ts');
let dbMod: DbModule | undefined;

function getDb(): ReturnType<DbModule['getDb']> {
  if (!dbMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dbMod = require('../cache/db.ts') as DbModule;
  }
  return dbMod.getDb();
}

/**
 * Shared accessor exposed for the orchestrator in `./index.ts` so a
 * single `_setDbModuleForTests()` call swaps both code paths. Internal
 * — not re-exported from the public root.
 */
export function _getDbForEmbeddings(): ReturnType<DbModule['getDb']> {
  return getDb();
}

export function _setDbModuleForTests(mod: DbModule | undefined): void {
  dbMod = mod;
}

// ─── sqlite-vec extension loading (try once, cache result) ─────────
// `extensionAvailable` is undefined until the first call. After that
// it's a stable boolean for the lifetime of the process — re-trying
// per call would log the WARN on every search.
let extensionAvailable: boolean | undefined;
let vecVirtualTableReady = false;

/**
 * Returns true when sqlite-vec is loaded AND the `vec_embeddings`
 * virtual table is set up. Logs a WARN the first time we fall back
 * to the pure-JS path. Safe to call on every put/search — the work
 * is gated by the cached booleans.
 */
function ensureVecReady(): boolean {
  if (extensionAvailable === false) return false;
  if (vecVirtualTableReady) return true;

  try {
    // sqlite-vec is dynamically required so test environments that
    // don't have the native binary on their platform can still import
    // this module. The error is caught below.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require('sqlite-vec') as typeof import('sqlite-vec');
    const db = getDb();
    db.loadExtension(sqliteVec.getLoadablePath());
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
         embedding float[${EMBEDDING_DIMS}]
       );`,
    );
    extensionAvailable = true;
    vecVirtualTableReady = true;
    logger.debug('sqlite-vec loaded', { dims: EMBEDDING_DIMS });
    return true;
  } catch (err) {
    if (extensionAvailable === undefined) {
      logger.warn('sqlite-vec extension failed to load — using pure-JS cosine fallback', {
        err: String(err),
      });
    }
    extensionAvailable = false;
    return false;
  }
}

/**
 * Force the next ensureVecReady() call to re-attempt extension load.
 * Used by tests that swap the db module between cases.
 */
export function _resetVecStateForTests(): void {
  extensionAvailable = undefined;
  vecVirtualTableReady = false;
}

// ─── Helpers ───────────────────────────────────────────────────────

/** SHA-256 of the text we embed — used as the dedup key. */
export function hashContent(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Serialize a Float32Array to a Buffer suitable for the BLOB column. */
function vectorToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/** Deserialize a BLOB read back from SQLite into a Float32Array. */
function blobToVector(blob: Buffer | Uint8Array): Float32Array {
  // Buffer extends Uint8Array; either way we want a fresh Float32Array
  // that owns its own slice of memory (the sqlite-vec row may be
  // re-used by the driver for subsequent reads).
  const u8 = blob instanceof Buffer ? blob : Buffer.from(blob);
  const copy = new Uint8Array(u8.byteLength);
  copy.set(u8);
  return new Float32Array(copy.buffer);
}

/** Cosine similarity between two unit-normalized 384-dim vectors. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
  }
  return dot;
}

// ─── Public API ────────────────────────────────────────────────────

export type PutEmbeddingArgs = {
  meta: Omit<EmbeddingMeta, 'createdAt'>;
  vector: Float32Array;
};

/**
 * Upsert an embedding. If a row already exists with the same
 * (entity_type, entity_id) the previous vector is overwritten and the
 * sqlite-vec rowid is reused so the virtual table stays in sync.
 *
 * Caller is responsible for skipping the call when `meta.contentHash`
 * already matches the stored hash (see `embedAllCached()`).
 */
export function putEmbedding(args: PutEmbeddingArgs): void {
  if (args.vector.length !== EMBEDDING_DIMS) {
    throw new Error(
      `putEmbedding: vector length ${args.vector.length} !== expected ${EMBEDDING_DIMS}`,
    );
  }

  const useVec = ensureVecReady();
  const db = getDb();
  const now = Date.now();

  // Look up existing meta to reuse the vec_rowid if present (so the
  // virtual table row gets overwritten in place rather than appended).
  const existing = db
    .query<{ vec_rowid: number | null }, [string, string]>(
      'SELECT vec_rowid FROM embedding_meta WHERE entity_type = ? AND entity_id = ?',
    )
    .get(args.meta.entityType, args.meta.entityId);

  let vecRowid: number | null = existing?.vec_rowid ?? null;

  if (useVec) {
    const blob = vectorToBlob(args.vector);
    if (vecRowid !== null) {
      db.query('UPDATE vec_embeddings SET embedding = ? WHERE rowid = ?').run(blob, vecRowid);
    } else {
      const res = db.query('INSERT INTO vec_embeddings (embedding) VALUES (?)').run(blob);
      vecRowid = Number(res.lastInsertRowid);
    }
  } else {
    db.query(
      `INSERT INTO embedding_vectors (entity_type, entity_id, vector) VALUES (?, ?, ?)
       ON CONFLICT(entity_type, entity_id) DO UPDATE SET vector = excluded.vector`,
    ).run(args.meta.entityType, args.meta.entityId, vectorToBlob(args.vector));
  }

  db.query(
    `INSERT INTO embedding_meta
       (entity_type, entity_id, content_hash, source_url, author_handle, snippet,
        model_version, vec_rowid, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_type, entity_id) DO UPDATE SET
       content_hash = excluded.content_hash,
       source_url = excluded.source_url,
       author_handle = excluded.author_handle,
       snippet = excluded.snippet,
       model_version = excluded.model_version,
       vec_rowid = excluded.vec_rowid,
       created_at = excluded.created_at`,
  ).run(
    args.meta.entityType,
    args.meta.entityId,
    args.meta.contentHash,
    args.meta.sourceUrl ?? null,
    args.meta.authorHandle ?? null,
    args.meta.snippet,
    EMBEDDING_MODEL_VERSION,
    vecRowid,
    now,
  );
}

type MetaRow = {
  entity_type: string;
  entity_id: string;
  content_hash: string;
  source_url: string | null;
  author_handle: string | null;
  snippet: string;
  created_at: number;
  vec_rowid: number | null;
};

function metaRowToMeta(row: MetaRow): EmbeddingMeta {
  return {
    entityType: row.entity_type as EmbeddingMeta['entityType'],
    entityId: row.entity_id,
    contentHash: row.content_hash,
    sourceUrl: row.source_url ?? undefined,
    authorHandle: row.author_handle ?? undefined,
    snippet: row.snippet,
    createdAt: row.created_at,
  };
}

/**
 * Look up an existing embedding by entity. Returns the meta row only —
 * callers who need the vector should use search. (Embeddings are
 * write-once-read-many at search time; we don't expose the raw vector
 * through the per-entity getter to keep the API narrow.)
 */
export function getEmbedding(
  entityType: EmbeddingMeta['entityType'],
  entityId: string,
): EmbeddingMeta | undefined {
  const row = getDb()
    .query<MetaRow, [string, string]>(
      `SELECT entity_type, entity_id, content_hash, source_url, author_handle,
              snippet, created_at, vec_rowid
       FROM embedding_meta WHERE entity_type = ? AND entity_id = ?`,
    )
    .get(entityType, entityId);
  return row ? metaRowToMeta(row) : undefined;
}

export type SearchHit = EmbeddingMeta & { similarity: number };

/**
 * Top-K nearest neighbours by cosine similarity to `queryVec`.
 *
 * sqlite-vec path: uses the `MATCH … ORDER BY distance` virtual-table
 * query, joins on `vec_rowid` for the meta fields. Returns L2-distance
 * which we convert back to similarity (vectors are unit-normalized so
 * `sim = 1 - distance² / 2`).
 *
 * Fallback path: scans `embedding_vectors` + `embedding_meta`, computes
 * cosine per row, sorts. Adequate for <10k rows; surface a debug log
 * when the row count would benefit from real ANN search.
 */
export function searchSimilar(queryVec: Float32Array, limit = 10): SearchHit[] {
  if (queryVec.length !== EMBEDDING_DIMS) {
    throw new Error(`searchSimilar: query vector length ${queryVec.length} !== ${EMBEDDING_DIMS}`);
  }
  const useVec = ensureVecReady();
  const db = getDb();

  if (useVec) {
    type VecRow = MetaRow & { distance: number };
    const rows = db
      .query<VecRow, [Buffer, number]>(
        `SELECT m.entity_type, m.entity_id, m.content_hash, m.source_url,
                m.author_handle, m.snippet, m.created_at, m.vec_rowid,
                v.distance AS distance
         FROM vec_embeddings v
         JOIN embedding_meta m ON m.vec_rowid = v.rowid
         WHERE v.embedding MATCH ?
         ORDER BY v.distance
         LIMIT ?`,
      )
      .all(vectorToBlob(queryVec), limit);
    return rows.map((r) => ({
      ...metaRowToMeta(r),
      // vec0 reports L2 distance on unit vectors; cosine sim = 1 - d²/2.
      similarity: Math.max(0, Math.min(1, 1 - (r.distance * r.distance) / 2)),
    }));
  }

  // Fallback: brute-force JS cosine over the whole table.
  type FallbackRow = MetaRow & { vector: Buffer };
  const rows = db
    .query<FallbackRow, []>(
      `SELECT m.entity_type, m.entity_id, m.content_hash, m.source_url,
              m.author_handle, m.snippet, m.created_at, m.vec_rowid,
              v.vector AS vector
       FROM embedding_vectors v
       JOIN embedding_meta m
         ON m.entity_type = v.entity_type AND m.entity_id = v.entity_id`,
    )
    .all();

  const scored: SearchHit[] = rows.map((r) => ({
    ...metaRowToMeta(r),
    similarity: cosineSimilarity(queryVec, blobToVector(r.vector)),
  }));
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/** Total embedded entity count. Used by `cache info`. */
export function embeddingCount(): number {
  return getDb().query<{ c: number }, []>('SELECT COUNT(*) AS c FROM embedding_meta').get()?.c ?? 0;
}

/** Approximate on-disk size of embedding rows + vectors, in bytes. */
export function embeddingStorageBytes(): number {
  // Each fallback vector = 384 * 4 = 1536 bytes. sqlite-vec virtual
  // tables don't expose a row-size query cheaply, so we estimate from
  // meta row count using the same 1536-byte budget regardless of which
  // store backed the rows. Sum with the meta-row overhead (~250 bytes
  // including snippet) to give the user a reasonable ballpark.
  const count = embeddingCount();
  return count * (1536 + 250);
}

/**
 * Wipe every embedding row from both meta and both vector stores.
 * Used by `xray cache clear` (full clear) and by tests that need a
 * clean slate between cases.
 */
export function clearEmbeddings(): void {
  const db = getDb();
  db.exec('DELETE FROM embedding_meta');
  db.exec('DELETE FROM embedding_vectors');
  if (vecVirtualTableReady) {
    try {
      db.exec('DELETE FROM vec_embeddings');
    } catch (err) {
      logger.debug('failed to clear vec_embeddings (continuing)', { err: String(err) });
    }
  }
}
