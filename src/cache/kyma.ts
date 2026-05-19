import { createHash } from 'node:crypto';

// Lazy-import the SQLite-backed db module so callers that never touch the
// cache (e.g. vitest under Node, which can't resolve `bun:sqlite`) don't
// pay the import-time cost. Matches the same pattern used in
// `src/auth/cookie-reader.ts`.
type DbModule = typeof import('./db.ts');
let dbMod: DbModule | undefined;
async function getDbModule(): Promise<DbModule> {
  if (dbMod) return dbMod;
  dbMod = await import('./db.ts');
  return dbMod;
}
// Sync variant for the hot path — uses require under the hood via Bun's
// module cache after the first lazy load. The synchronous accessors below
// fall through to this only after at least one async warm-up call, OR when
// running under Bun (which evaluates require('bun:sqlite') eagerly).
function getDbModuleSync(): DbModule {
  if (dbMod) return dbMod;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  dbMod = require('./db.ts') as DbModule;
  return dbMod;
}

export function hashPrompt(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function getCachedKyma(cacheKey: string): string | undefined {
  const { getDb, isFresh } = getDbModuleSync();
  const row = getDb()
    .query<{ response: string; created_at: number }, [string]>(
      'SELECT response, created_at FROM kyma_responses WHERE cache_key = ?',
    )
    .get(cacheKey);
  if (!row) return undefined;
  if (!isFresh(row.created_at)) return undefined;
  return row.response;
}

export function putCachedKyma(args: {
  cacheKey: string;
  model: string;
  promptHash: string;
  response: string;
}): void {
  const { getDb } = getDbModuleSync();
  getDb()
    .query(
      `INSERT INTO kyma_responses (cache_key, model, prompt_hash, response, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET response=excluded.response, created_at=excluded.created_at`,
    )
    .run(args.cacheKey, args.model, args.promptHash, args.response, Date.now());
}

/**
 * Test helper — pre-warm the db module asynchronously so subsequent
 * synchronous accessors don't hit the require path. Currently unused but
 * exposed for completeness.
 */
export async function ensureDbReady(): Promise<void> {
  await getDbModule();
}
