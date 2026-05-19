/**
 * P3.0 — SQLite-backed article cache.
 *
 * Two tables, both URL-canonical-keyed:
 *   1. `article_bodies(url_canonical → ArticleBody JSON)`
 *   2. `article_summaries((url_canonical, tweet_context_hash) → summary JSON)`
 *
 * The summaries table reserves the `tweet_context_hash` column for P3.2's
 * cross-reference pipeline — same article cross-referenced against
 * different threads gets its own row. P3.0 writes only the empty-string
 * hash since no thread context exists yet.
 *
 * 7-day default TTL — articles rarely change after publication. Override
 * with `XRAY_ARTICLE_CACHE_TTL` or fall back to the global
 * `XRAY_CACHE_TTL` when explicitly set. Pattern mirrors `video/cache.ts`.
 */
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import type { ArticleBody, ArticleSource, ArticleSummary } from '../models/article.ts';

// Lazy-load the bun:sqlite-backed db module so importing this file under
// vitest (Node runtime) doesn't crash at module-load time. Matches the
// pattern in `src/video/cache.ts`.
type DbModule = typeof import('../cache/db.ts');
let dbMod: DbModule | undefined;
function getDb(): ReturnType<DbModule['getDb']> {
  if (!dbMod) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dbMod = require('../cache/db.ts') as DbModule;
  }
  return dbMod.getDb();
}

/** Test seam — inject a stubbed db module so the lazy `require()` never runs. */
export function _setDbModuleForTests(mod: DbModule | undefined): void {
  dbMod = mod;
}

const DEFAULT_ARTICLE_TTL_SECONDS = 7 * 24 * 60 * 60;

function articleTtlSeconds(): number {
  const override = process.env.XRAY_ARTICLE_CACHE_TTL;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const cfg = loadConfig();
  // Treat the config default (86400) as "not user-tuned" → use article default.
  if (cfg.cache.ttlSeconds === 86400) return DEFAULT_ARTICLE_TTL_SECONDS;
  return cfg.cache.ttlSeconds;
}

function isArticleFresh(createdAtMs: number): boolean {
  const ttl = articleTtlSeconds();
  if (ttl === 0) return true;
  return Date.now() - createdAtMs < ttl * 1000;
}

// ─────────────────────────────────────────────────────────────────────────
// Article body cache
// ─────────────────────────────────────────────────────────────────────────

export function getCachedArticleBody(urlCanonical: string): ArticleBody | undefined {
  const row = getDb()
    .query<{ body_json: string; fetched_at: number }, [string]>(
      'SELECT body_json, fetched_at FROM article_bodies WHERE url_canonical = ?',
    )
    .get(urlCanonical);
  if (!row) return undefined;
  if (!isArticleFresh(row.fetched_at)) return undefined;
  try {
    return JSON.parse(row.body_json) as ArticleBody;
  } catch {
    return undefined;
  }
}

export function putCachedArticleBody(args: {
  urlCanonical: string;
  source: ArticleSource;
  body: ArticleBody;
}): void {
  getDb()
    .query(
      `INSERT INTO article_bodies (url_canonical, source, body_json, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(url_canonical) DO UPDATE SET
         source=excluded.source,
         body_json=excluded.body_json,
         fetched_at=excluded.fetched_at`,
    )
    .run(args.urlCanonical, args.source, JSON.stringify(args.body), Date.now());
}

// ─────────────────────────────────────────────────────────────────────────
// Article summary cache
// ─────────────────────────────────────────────────────────────────────────

export function getCachedArticleSummary(args: {
  urlCanonical: string;
  tweetContextHash: string;
}): ArticleSummary | undefined {
  const row = getDb()
    .query<{ summary_json: string; created_at: number }, [string, string]>(
      'SELECT summary_json, created_at FROM article_summaries WHERE url_canonical = ? AND tweet_context_hash = ?',
    )
    .get(args.urlCanonical, args.tweetContextHash);
  if (!row) return undefined;
  if (!isArticleFresh(row.created_at)) return undefined;
  try {
    return JSON.parse(row.summary_json) as ArticleSummary;
  } catch {
    return undefined;
  }
}

export function putCachedArticleSummary(args: {
  urlCanonical: string;
  tweetContextHash: string;
  summary: ArticleSummary;
  model: string;
}): void {
  getDb()
    .query(
      `INSERT INTO article_summaries (url_canonical, tweet_context_hash, summary_json, model, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(url_canonical, tweet_context_hash) DO UPDATE SET
         summary_json=excluded.summary_json,
         model=excluded.model,
         created_at=excluded.created_at`,
    )
    .run(
      args.urlCanonical,
      args.tweetContextHash,
      JSON.stringify(args.summary),
      args.model,
      Date.now(),
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Aggregate info + clear
// ─────────────────────────────────────────────────────────────────────────

export type ArticleCacheInfo = {
  bodyCount: number;
  summaryCount: number;
};

export function articleCacheInfo(): ArticleCacheInfo {
  const db = getDb();
  const bodyCount =
    db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM article_bodies').get()?.c ?? 0;
  const summaryCount =
    db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM article_summaries').get()?.c ?? 0;
  return { bodyCount, summaryCount };
}

export function clearArticleCache(): void {
  const db = getDb();
  db.exec('DELETE FROM article_bodies');
  db.exec('DELETE FROM article_summaries');
  logger.debug('article cache cleared');
}
