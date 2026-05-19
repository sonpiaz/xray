import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';

let db: Database | undefined;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS posts (
     id TEXT PRIMARY KEY,
     url TEXT NOT NULL,
     json TEXT NOT NULL,
     fetched_at INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS threads (
     root_id TEXT PRIMARY KEY,
     url TEXT NOT NULL,
     json TEXT NOT NULL,
     fetched_at INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS kyma_responses (
     cache_key TEXT PRIMARY KEY,
     model TEXT NOT NULL,
     prompt_hash TEXT NOT NULL,
     response TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  'CREATE INDEX IF NOT EXISTS idx_posts_url ON posts(url);',
  'CREATE INDEX IF NOT EXISTS idx_threads_url ON threads(url);',
  // ── P2.2 — Video caching tables ─────────────────────────────────────
  // URL-canonical-keyed transcript + vision caches. Saves the entire
  // downstream pipeline (download → audio → transcribe / frames → vision)
  // on a cache hit. The kyma_responses table stays in place for content-
  // hash-keyed caching of individual Kyma calls — these tables sit one
  // level higher and key by the canonical video URL.
  `CREATE TABLE IF NOT EXISTS video_transcripts (
     url_canonical TEXT PRIMARY KEY,
     platform TEXT NOT NULL,
     transcript_json TEXT NOT NULL,
     model TEXT NOT NULL,
     duration_ms INTEGER,
     created_at INTEGER NOT NULL
   );`,
  `CREATE TABLE IF NOT EXISTS video_vision (
     url_canonical TEXT PRIMARY KEY,
     platform TEXT NOT NULL,
     vision_json TEXT NOT NULL,
     frame_count INTEGER NOT NULL,
     model TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  // Tracks downloaded mp4 files on disk for 1GB LRU eviction (spec §9.4).
  // Rows are evicted oldest-first by last_accessed_at when the rolling
  // total exceeds the configured budget after a fresh download.
  `CREATE TABLE IF NOT EXISTS video_files (
     url_canonical TEXT PRIMARY KEY,
     file_path TEXT NOT NULL,
     size_bytes INTEGER NOT NULL,
     platform TEXT NOT NULL,
     last_accessed_at INTEGER NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  'CREATE INDEX IF NOT EXISTS idx_video_files_last_accessed ON video_files(last_accessed_at);',
];

export function getDb(): Database {
  if (db) return db;
  const cfg = loadConfig();
  mkdirSync(cfg.cache.dir, { recursive: true });
  const path = join(cfg.cache.dir, 'xray.db');
  db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const m of MIGRATIONS) db.exec(m);
  logger.debug('cache opened', { path });
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

export function isFresh(fetchedAtMs: number): boolean {
  const ttl = loadConfig().cache.ttlSeconds;
  if (ttl === 0) return true;
  return Date.now() - fetchedAtMs < ttl * 1000;
}
