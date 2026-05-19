import { rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { embeddingCount, embeddingStorageBytes } from '../embeddings/store.ts';
import {
  type VideoCacheInfo,
  clearVideoCache,
  videoCacheDir,
  videoCacheInfo,
} from '../video/cache.ts';
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
  /** P2.2 — video cache stats (separate disk + SQLite footprint). */
  video: Pick<VideoCacheInfo, 'transcriptCount' | 'visionCount' | 'fileCount' | 'totalBytes'>;
  /** P4.0 — embedded entity count + approximate footprint. */
  embeddings: {
    count: number;
    storageBytes: number;
  };
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
  const video = videoCacheInfo();
  return {
    path,
    sizeBytes,
    postCount,
    threadCount,
    kymaCount,
    video: {
      transcriptCount: video.transcriptCount,
      visionCount: video.visionCount,
      fileCount: video.fileCount,
      totalBytes: video.totalBytes,
    },
    embeddings: {
      count: embeddingCount(),
      storageBytes: embeddingStorageBytes(),
    },
  };
}

export function clearCache(): void {
  const path = join(loadConfig().cache.dir, 'xray.db');
  // Clear the video tables + on-disk mp4 dir BEFORE closing the db,
  // otherwise the lazy db module reopens after closeDb() and leaves a
  // dangling handle on the deleted file.
  try {
    clearVideoCache();
  } catch (err) {
    logger.debug('clearVideoCache failed (continuing)', { err: String(err) });
  }
  closeDb();
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      rmSync(f);
    } catch {
      /* ignore */
    }
  }
  // Also drop the video cache dir entirely (clearVideoCache recreated it
  // empty above; we want a totally clean slate when the user runs
  // `xray cache clear`).
  try {
    rmSync(videoCacheDir(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  logger.info('cache cleared', { path });
}
