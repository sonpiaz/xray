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
 *
 * P3.1 — Adds `canonicalizeArticleUrl()` (sync) and
 * `resolveCanonicalArticleUrl()` (async — resolves t.co shortlinks via
 * HEAD redirect). Different URLs that point at the same article share a
 * cache row when callers use the resolver before put/get.
 */
import { request } from 'undici';
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
// P3.1 — URL canonicalization
// ─────────────────────────────────────────────────────────────────────────

/**
 * Tracking + analytics params we strip during canonicalization. Kept
 * static so the function is deterministic (no env/locale dependency).
 * Mirrors the spirit of `video/platforms.ts` TRACKING_PARAM_KEYS but
 * tuned for the publishing/newsletter ecosystem (utm_*, mc_*, etc.).
 *
 * Also stripped: any key starting with `utm_` (broad sweep) and any key
 * starting with `mc_` (Mailchimp). See the prefix matcher below.
 */
const ARTICLE_TRACKING_PARAM_KEYS = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'ref',
  'ref_src',
  'ref_url',
  'source',
  'ck_subscriber_id',
  '__s',
  '_gl',
  's',
  'shared',
  'sharing',
  'share',
  'share_id',
  'rdt',
  'igshid',
  'mkt_tok',
  'yclid',
  'amp',
]);

/** Param-name prefixes we strip wholesale (catches `utm_*`, `mc_*`, etc.). */
const ARTICLE_TRACKING_PREFIXES = ['utm_', 'mc_', 'pk_', 'mtm_', 'hsa_', '__hs'];

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (ARTICLE_TRACKING_PARAM_KEYS.has(lower)) return true;
  for (const prefix of ARTICLE_TRACKING_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Sync canonicalization for an article URL. Used as the cache key so
 * `?utm_source=x` and `?utm_campaign=y` versions of the same article
 * collapse into one row.
 *
 * Rules:
 *   - Lowercase host (`Example.COM/Post` → `example.com/Post`).
 *   - Strip tracking params (utm_*, fbclid, ref, source, mc_*, etc.).
 *   - Sort remaining query params alphabetically.
 *   - Strip trailing slash from path (except bare `/`).
 *   - Drop fragment `#...`.
 *   - Drop the `www.` subdomain prefix (host equivalence).
 *
 * Does NOT expand t.co shortlinks — that needs network I/O (see
 * `resolveCanonicalArticleUrl`). Returns the original string if URL
 * parsing fails.
 */
export function canonicalizeArticleUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('www.')) host = host.slice(4);

  const canonical = new URL(`${parsed.protocol}//${host}${parsed.pathname}${parsed.search}`);

  // Sweep tracking params off the new URL's searchParams in-place.
  for (const key of Array.from(canonical.searchParams.keys())) {
    if (isTrackingParam(key)) canonical.searchParams.delete(key);
  }

  // Sort params for stability (?a=1&b=2 ≡ ?b=2&a=1).
  const sorted = new URLSearchParams();
  const keys = Array.from(canonical.searchParams.keys()).sort();
  for (const k of keys) {
    const v = canonical.searchParams.get(k);
    if (v !== null) sorted.set(k, v);
  }
  canonical.search = sorted.toString();

  // Drop trailing slash on the path (but keep root "/" as-is).
  if (canonical.pathname.length > 1 && canonical.pathname.endsWith('/')) {
    canonical.pathname = canonical.pathname.replace(/\/+$/, '');
  }

  canonical.hash = '';
  const s = canonical.toString();
  return s.endsWith('?') ? s.slice(0, -1) : s;
}

/** Hosts whose shortlinks we attempt to expand via HEAD. */
const SHORTLINK_HOSTS = new Set([
  't.co',
  'bit.ly',
  'buff.ly',
  'tinyurl.com',
  'ow.ly',
  'lnkd.in',
  'goo.gl',
]);

/** Test seam — injected to skip real network I/O during unit tests. */
type HeadResolver = (url: string, timeoutMs: number) => Promise<string | undefined>;
let headResolverImpl: HeadResolver = defaultHeadResolver;

export function _setHeadResolverForTests(impl: HeadResolver | undefined): void {
  headResolverImpl = impl ?? defaultHeadResolver;
}

/**
 * Default HEAD-redirect resolver. Follows up to 5 hops manually via undici
 * with the given per-hop timeout. Returns the final URL, or `undefined`
 * when no redirect was emitted (the input wasn't a shortlink) or the
 * request failed (timeout, DNS, non-2xx-or-3xx). Callers MUST treat
 * undefined as "use the original URL".
 *
 * Manual follow chosen over undici v7's redirect interceptor because the
 * interceptor pattern needs a Dispatcher.compose() setup that's overkill
 * for a 5-hop chain. Stays simple, no extra modules.
 */
async function defaultHeadResolver(url: string, timeoutMs: number): Promise<string | undefined> {
  const MAX_HOPS = 5;
  let current = url;
  let lastLocation: string | undefined;
  try {
    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const res = await request(current, {
        method: 'HEAD',
        bodyTimeout: timeoutMs,
        headersTimeout: timeoutMs,
      });
      // Drain the body even on HEAD — undici still holds the socket.
      await res.body.dump();
      const status = res.statusCode;
      if (status >= 300 && status < 400) {
        const loc = res.headers.location;
        const next = Array.isArray(loc) ? loc[0] : loc;
        if (!next) break;
        // Resolve relative redirects against the current URL.
        const resolved = new URL(next, current).toString();
        lastLocation = resolved;
        current = resolved;
        continue;
      }
      // 2xx (or 4xx/5xx — treat both as terminal). If we ever followed
      // a redirect, return the final URL; otherwise undefined (no expand).
      if (lastLocation) return lastLocation;
      return undefined;
    }
    return lastLocation;
  } catch (err) {
    logger.debug('article head resolve failed', { url, err: String(err) });
    return undefined;
  }
}

/**
 * Async canonicalization. Resolves t.co (and friends) shortlinks via HEAD
 * redirect, THEN applies `canonicalizeArticleUrl()` to the resolved URL.
 * Use this as the cache key when the input may be a shortlink.
 *
 * Falls back to sync canonicalization on any HEAD failure — the cache
 * just won't deduplicate across the un-expanded form. Better than
 * throwing on transient network errors.
 */
export async function resolveCanonicalArticleUrl(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
  if (!SHORTLINK_HOSTS.has(host)) return canonicalizeArticleUrl(url);

  const resolved = await headResolverImpl(url, timeoutMs);
  if (!resolved) {
    // Shortlink couldn't be expanded — canonicalize the original. The
    // cache row will be keyed on the shortlink, which is suboptimal but
    // still correct (next call with the same shortlink hits).
    return canonicalizeArticleUrl(url);
  }
  return canonicalizeArticleUrl(resolved);
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
