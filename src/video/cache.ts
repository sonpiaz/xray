/**
 * P2.2 — URL-keyed video cache layer.
 *
 * Sits ABOVE the content-hash-keyed `kyma_responses` cache used by
 * `transcribe.ts` / `vision.ts`. The point: on a re-run of the same URL,
 * skip the entire pipeline (download → audio → transcribe / frames →
 * vision) instead of just the individual Kyma call.
 *
 * Three persistent stores back this module:
 *   1. `video_transcripts(url_canonical → TranscribeResult-shaped JSON)`
 *   2. `video_vision(url_canonical → AnalyzeFramesResult-shaped JSON)`
 *   3. `video_files(url_canonical → on-disk mp4 path + size + LRU stamp)`
 *
 * The file table is the LRU index that bounds disk usage to ~1 GB per
 * spec §9.4. SQLite rows themselves stay in place even when files are
 * evicted from disk — but `getCachedVideoFile` re-stat's the path on
 * read and returns undefined if the file vanished, keeping cache lookups
 * self-healing.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import type { FrameAnalysis, Transcript, VideoSource } from '../models/video-report.ts';

// Lazy-load the bun:sqlite-backed db module so importing this file under
// vitest (Node runtime) doesn't crash at module-load time. Matches the
// pattern in `src/cache/kyma.ts`. Tests that exercise the cache call
// `_setDbModuleForTests` to inject a stubbed module before any cache
// helper runs.
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

/**
 * 30-day default TTL for video transcripts + vision. Videos are immutable
 * once uploaded, but we still cap age so a stale row from an old model
 * version eventually re-runs against the current model. Falls through to
 * the global `XRAY_CACHE_TTL` when set explicitly to a non-default value.
 *
 * The `XRAY_CACHE_TTL` env var (config.cache.ttlSeconds) defaults to
 * 86400 (24h) for thread caching. For video we want a longer default; if
 * the user has *not* overridden the env var, we use 30 days. If they did
 * set it, we honor that — they explicitly tuned cache age.
 */
const DEFAULT_VIDEO_TTL_SECONDS = 30 * 24 * 60 * 60;

function videoTtlSeconds(): number {
  const cfg = loadConfig();
  // When the user hasn't set XRAY_CACHE_TTL, config defaults to 86400.
  // Treat 86400 as "default" and substitute the video-specific default
  // unless the user explicitly opts in via XRAY_VIDEO_CACHE_TTL.
  const override = process.env.XRAY_VIDEO_CACHE_TTL;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  if (cfg.cache.ttlSeconds === 86400) return DEFAULT_VIDEO_TTL_SECONDS;
  return cfg.cache.ttlSeconds;
}

function isVideoFresh(createdAtMs: number): boolean {
  const ttl = videoTtlSeconds();
  if (ttl === 0) return true;
  return Date.now() - createdAtMs < ttl * 1000;
}

// ─────────────────────────────────────────────────────────────────────────
// Filesystem helpers
// ─────────────────────────────────────────────────────────────────────────

/** Returns the absolute path to the video cache directory rooted at XRAY_HOME. */
export function videoCacheDir(): string {
  const cfg = loadConfig();
  // cfg.cache.dir is `{XRAY_HOME}/cache`. Mirror that one level deeper.
  return join(cfg.cache.dir, 'video');
}

/** Returns the platform-segmented subdirectory for downloaded mp4 files. */
export function videoFileDir(platform: VideoSource): string {
  return join(videoCacheDir(), platform);
}

/**
 * Deterministic per-URL filename: 16-char sha256 prefix of the canonical
 * URL. Keeps filenames short and stable across runs so the LRU index can
 * recover from a crash mid-download.
 */
export function videoFilePathFor(urlCanonical: string, platform: VideoSource): string {
  const hash = createHash('sha256').update(urlCanonical).digest('hex').slice(0, 16);
  return join(videoFileDir(platform), `${hash}.mp4`);
}

// ─────────────────────────────────────────────────────────────────────────
// Transcript cache
// ─────────────────────────────────────────────────────────────────────────

/** Shape stored in `video_transcripts.transcript_json`. */
export type CachedTranscript = {
  transcript: Transcript;
  durationSec: number;
  estimatedCostUsd: number;
};

export function getCachedTranscript(urlCanonical: string): CachedTranscript | undefined {
  const row = getDb()
    .query<{ transcript_json: string; created_at: number }, [string]>(
      'SELECT transcript_json, created_at FROM video_transcripts WHERE url_canonical = ?',
    )
    .get(urlCanonical);
  if (!row) return undefined;
  if (!isVideoFresh(row.created_at)) return undefined;
  try {
    return JSON.parse(row.transcript_json) as CachedTranscript;
  } catch {
    // Corrupt JSON — treat as miss; the caller will overwrite on the next
    // successful run.
    return undefined;
  }
}

export function putCachedTranscript(args: {
  urlCanonical: string;
  platform: VideoSource;
  transcript: Transcript;
  model: string;
  durationSec?: number;
  durationMs?: number;
  estimatedCostUsd?: number;
}): void {
  const payload: CachedTranscript = {
    transcript: args.transcript,
    durationSec: args.durationSec ?? (args.durationMs ? args.durationMs / 1000 : 0),
    estimatedCostUsd: args.estimatedCostUsd ?? 0,
  };
  const durationMs =
    args.durationMs ?? (args.durationSec ? Math.round(args.durationSec * 1000) : 0);
  getDb()
    .query(
      `INSERT INTO video_transcripts (url_canonical, platform, transcript_json, model, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url_canonical) DO UPDATE SET
         platform=excluded.platform,
         transcript_json=excluded.transcript_json,
         model=excluded.model,
         duration_ms=excluded.duration_ms,
         created_at=excluded.created_at`,
    )
    .run(
      args.urlCanonical,
      args.platform,
      JSON.stringify(payload),
      args.model,
      durationMs,
      Date.now(),
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Vision cache
// ─────────────────────────────────────────────────────────────────────────

/** Shape stored in `video_vision.vision_json`. */
export type CachedVision = {
  analyses: FrameAnalysis[];
  visualSummary?: string;
  estimatedCostUsd: number;
};

export function getCachedVision(urlCanonical: string): CachedVision | undefined {
  const row = getDb()
    .query<{ vision_json: string; created_at: number }, [string]>(
      'SELECT vision_json, created_at FROM video_vision WHERE url_canonical = ?',
    )
    .get(urlCanonical);
  if (!row) return undefined;
  if (!isVideoFresh(row.created_at)) return undefined;
  try {
    return JSON.parse(row.vision_json) as CachedVision;
  } catch {
    return undefined;
  }
}

export function putCachedVision(args: {
  urlCanonical: string;
  platform: VideoSource;
  vision: CachedVision;
  frameCount: number;
  model: string;
}): void {
  getDb()
    .query(
      `INSERT INTO video_vision (url_canonical, platform, vision_json, frame_count, model, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url_canonical) DO UPDATE SET
         platform=excluded.platform,
         vision_json=excluded.vision_json,
         frame_count=excluded.frame_count,
         model=excluded.model,
         created_at=excluded.created_at`,
    )
    .run(
      args.urlCanonical,
      args.platform,
      JSON.stringify(args.vision),
      args.frameCount,
      args.model,
      Date.now(),
    );
}

// ─────────────────────────────────────────────────────────────────────────
// Video file (mp4) cache + LRU eviction
// ─────────────────────────────────────────────────────────────────────────

export type CachedVideoFile = {
  filePath: string;
  sizeBytes: number;
};

/**
 * Look up a previously-downloaded mp4 by canonical URL. Verifies the file
 * still exists on disk before returning (a successful look-up touches
 * `last_accessed_at` so the LRU index reflects actual use). If the file
 * has vanished out-of-band, the row is removed and `undefined` is
 * returned — the caller will re-download into the same deterministic
 * path on the next invocation.
 */
export function getCachedVideoFile(urlCanonical: string): CachedVideoFile | undefined {
  const db = getDb();
  const row = db
    .query<{ file_path: string; size_bytes: number }, [string]>(
      'SELECT file_path, size_bytes FROM video_files WHERE url_canonical = ?',
    )
    .get(urlCanonical);
  if (!row) return undefined;
  if (!existsSync(row.file_path)) {
    // File evicted out of band — clean up the orphan row.
    db.query('DELETE FROM video_files WHERE url_canonical = ?').run(urlCanonical);
    return undefined;
  }
  // Touch LRU stamp — every hit is "recently used".
  db.query('UPDATE video_files SET last_accessed_at = ? WHERE url_canonical = ?').run(
    Date.now(),
    urlCanonical,
  );
  return { filePath: row.file_path, sizeBytes: row.size_bytes };
}

/**
 * Record (or refresh) a downloaded video file in the LRU index. UPSERT
 * semantics: re-downloading the same URL updates size + LRU stamp
 * without leaving a stale row.
 */
export function recordVideoFile(args: {
  urlCanonical: string;
  filePath: string;
  sizeBytes: number;
  platform: VideoSource;
}): void {
  const now = Date.now();
  getDb()
    .query(
      `INSERT INTO video_files (url_canonical, file_path, size_bytes, platform, last_accessed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(url_canonical) DO UPDATE SET
         file_path=excluded.file_path,
         size_bytes=excluded.size_bytes,
         platform=excluded.platform,
         last_accessed_at=excluded.last_accessed_at`,
    )
    .run(args.urlCanonical, args.filePath, args.sizeBytes, args.platform, now, now);
}

/**
 * Default cache cap = 5 GB. Covers power users analyzing 50-150 videos
 * before churn kicks in; small enough to stay polite on consumer Macs.
 *
 * Override with `XRAY_VIDEO_CACHE_MAX_GB` env var (any positive number,
 * e.g. `XRAY_VIDEO_CACHE_MAX_GB=20` for 20 GB). Falls back to 5 if unset
 * or unparseable. Bumped from the original arbitrary 1 GB after Son
 * pushed back on 2026-05-19: 1 GB ≈ 10-30 mp4s which is too tight for
 * a research tool. Note: mp4 files are recoverable (download is
 * reversible) but transcript + vision results live in SQLite separately
 * and survive eviction — so a larger cap just means fewer re-downloads
 * on hot URLs.
 */
export function defaultVideoCacheMaxBytes(): number {
  const raw = process.env.XRAY_VIDEO_CACHE_MAX_GB?.trim();
  if (!raw) return 5 * 1_000_000_000;
  const gb = Number.parseFloat(raw);
  if (!Number.isFinite(gb) || gb <= 0) return 5 * 1_000_000_000;
  return Math.floor(gb * 1_000_000_000);
}

/**
 * LRU eviction — delete the oldest-accessed video files until the total
 * on-disk byte count is ≤ `maxBytes`. Returns the count + bytes freed.
 *
 * Default cap reads `XRAY_VIDEO_CACHE_MAX_GB` env var (default 5 GB).
 * Callers invoke this immediately after a successful download.
 *
 * **Concurrency note:** Two concurrent `xray video` runs racing on the
 * same machine could each evict files the other just wrote (TOCTOU on
 * the file_path). For an OSS CLI this is acceptable — concurrent runs
 * are rare and the worst-case is one extra re-download. A real fix
 * would require per-machine SQLite advisory locks (BEGIN IMMEDIATE).
 */
export function evictVideoFilesLRU(maxBytes = defaultVideoCacheMaxBytes()): {
  evicted: number;
  freedBytes: number;
} {
  const db = getDb();
  const rows = db
    .query<{ url_canonical: string; file_path: string; size_bytes: number }, []>(
      'SELECT url_canonical, file_path, size_bytes FROM video_files ORDER BY last_accessed_at ASC',
    )
    .all();

  const total = rows.reduce((acc, r) => acc + r.size_bytes, 0);
  if (total <= maxBytes) return { evicted: 0, freedBytes: 0 };

  let toFree = total - maxBytes;
  let evicted = 0;
  let freedBytes = 0;

  for (const row of rows) {
    if (toFree <= 0) break;
    try {
      unlinkSync(row.file_path);
    } catch (err) {
      // ENOENT is fine — file was already gone. Anything else is logged
      // at debug and we still drop the row so the index stays accurate.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('ENOENT')) {
        logger.debug('video LRU evict unlink failed', { path: row.file_path, err: msg });
      }
    }
    db.query('DELETE FROM video_files WHERE url_canonical = ?').run(row.url_canonical);
    evicted += 1;
    freedBytes += row.size_bytes;
    toFree -= row.size_bytes;
  }

  if (evicted > 0) {
    logger.debug('video LRU evicted', { evicted, freedBytes, budgetBytes: maxBytes });
  }
  return { evicted, freedBytes };
}

// ─────────────────────────────────────────────────────────────────────────
// Aggregate info + clear
// ─────────────────────────────────────────────────────────────────────────

export type VideoCacheInfo = {
  transcriptCount: number;
  visionCount: number;
  fileCount: number;
  totalBytes: number;
  dir: string;
};

export function videoCacheInfo(): VideoCacheInfo {
  const db = getDb();
  const transcriptCount =
    db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM video_transcripts').get()?.c ?? 0;
  const visionCount =
    db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM video_vision').get()?.c ?? 0;
  const fileRows = db.query<{ size_bytes: number }, []>('SELECT size_bytes FROM video_files').all();
  const fileCount = fileRows.length;
  const totalBytes = fileRows.reduce((acc, r) => acc + r.size_bytes, 0);
  return { transcriptCount, visionCount, fileCount, totalBytes, dir: videoCacheDir() };
}

/**
 * Wipes both the SQLite rows and the on-disk mp4 cache directory. Safe
 * to call when the directory doesn't exist yet.
 */
export function clearVideoCache(): void {
  const db = getDb();
  db.exec('DELETE FROM video_transcripts');
  db.exec('DELETE FROM video_vision');
  db.exec('DELETE FROM video_files');
  const dir = videoCacheDir();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  // Recreate the empty dir so future downloads have somewhere to land
  // without an extra mkdirSync everywhere.
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  logger.debug('video cache cleared', { dir });
}
