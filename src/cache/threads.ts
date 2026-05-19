import { type XThread, XThreadSchema } from '../models/thread.ts';
import { getDb, isFresh } from './db.ts';

export function getCachedThread(rootId: string): XThread | undefined {
  const row = getDb()
    .query<{ json: string; fetched_at: number }, [string]>(
      'SELECT json, fetched_at FROM threads WHERE root_id = ?',
    )
    .get(rootId);
  if (!row) return undefined;
  if (!isFresh(row.fetched_at)) return undefined;
  try {
    return XThreadSchema.parse(JSON.parse(row.json));
  } catch {
    return undefined;
  }
}

export function putCachedThread(thread: XThread): void {
  getDb()
    .query(
      `INSERT INTO threads (root_id, url, json, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(root_id) DO UPDATE SET url=excluded.url, json=excluded.json, fetched_at=excluded.fetched_at`,
    )
    .run(thread.rootPost.id, thread.rootPost.url, JSON.stringify(thread), Date.now());
}
