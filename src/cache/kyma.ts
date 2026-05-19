import { createHash } from 'node:crypto';
import { getDb, isFresh } from './db.ts';

export function hashPrompt(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function getCachedKyma(cacheKey: string): string | undefined {
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
  getDb()
    .query(
      `INSERT INTO kyma_responses (cache_key, model, prompt_hash, response, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(cache_key) DO UPDATE SET response=excluded.response, created_at=excluded.created_at`,
    )
    .run(args.cacheKey, args.model, args.promptHash, args.response, Date.now());
}
