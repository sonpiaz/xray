import { type XPost, XPostSchema } from '../models/post.ts';
import { getDb, isFresh } from './db.ts';

export function getCachedPost(id: string): XPost | undefined {
  const row = getDb()
    .query<{ json: string; fetched_at: number }, [string]>(
      'SELECT json, fetched_at FROM posts WHERE id = ?',
    )
    .get(id);
  if (!row) return undefined;
  if (!isFresh(row.fetched_at)) return undefined;
  try {
    return XPostSchema.parse(JSON.parse(row.json));
  } catch {
    return undefined;
  }
}

export function putCachedPost(post: XPost): void {
  getDb()
    .query(
      `INSERT INTO posts (id, url, json, fetched_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET url=excluded.url, json=excluded.json, fetched_at=excluded.fetched_at`,
    )
    .run(post.id, post.url, JSON.stringify(post), Date.now());
}
