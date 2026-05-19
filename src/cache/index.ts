import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { closeDb, getDb } from './db.ts';

export { closeDb, getDb, isFresh } from './db.ts';
export * from './kyma.ts';
export * from './posts.ts';
export * from './threads.ts';

export type CacheInfo = {
  path: string;
  sizeBytes: number;
  postCount: number;
  threadCount: number;
  kymaCount: number;
};

export function cacheInfo(): CacheInfo {
  const db = getDb();
  const path = join(loadConfig().cache.dir, 'xray.db');
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(path).size;
  } catch {
    sizeBytes = 0;
  }
  const postCount = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM posts').get()?.c ?? 0;
  const threadCount =
    db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM threads').get()?.c ?? 0;
  const kymaCount =
    db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM kyma_responses').get()?.c ?? 0;
  return { path, sizeBytes, postCount, threadCount, kymaCount };
}

export function clearCache(): void {
  const path = join(loadConfig().cache.dir, 'xray.db');
  closeDb();
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      rmSync(f);
    } catch {
      /* ignore */
    }
  }
  logger.info('cache cleared', { path });
}
