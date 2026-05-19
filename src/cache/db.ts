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
