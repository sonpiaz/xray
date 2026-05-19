/**
 * P2.2 — Video cache tests.
 *
 * The cache module talks to `bun:sqlite` via a lazy-loaded db handle. To
 * keep the tests runnable under vitest (Node, no bun:sqlite), we inject
 * an in-memory shim via the exported `_setDbModuleForTests` seam. The
 * shim implements just enough of the bun:sqlite `Database` surface for
 * the cache module's exact SQL statements; if the SQL ever drifts the
 * shim must drift with it.
 *
 * Orchestrator tests use the `_orchestratorDeps` test seam from
 * `src/intelligence/video.ts` (same pattern as `escalation.test.ts`) to
 * stub download / extract / transcribe / vision without touching the
 * network or filesystem.
 */
import { existsSync, statSync as fsStatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ──────────────────────────────────────────────────────────────────────
// In-memory db shim — implements just enough of `bun:sqlite`'s Database
// for the video cache module to round-trip rows. The cache module only
// uses these SQL patterns:
//   SELECT ... FROM video_transcripts WHERE url_canonical = ?
//   SELECT ... FROM video_vision      WHERE url_canonical = ?
//   SELECT ... FROM video_files       WHERE url_canonical = ?
//   SELECT ... FROM video_files       ORDER BY last_accessed_at ASC
//   INSERT INTO ... ON CONFLICT(url_canonical) DO UPDATE ...
//   UPDATE video_files SET last_accessed_at = ? WHERE url_canonical = ?
//   DELETE FROM ...
//   SELECT COUNT(*) AS c FROM ...
//   SELECT size_bytes FROM video_files
//   exec('DELETE FROM ...')
// ──────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type TableName = 'video_transcripts' | 'video_vision' | 'video_files';

const tables: Record<TableName, Map<string, Row>> = {
  video_transcripts: new Map(),
  video_vision: new Map(),
  video_files: new Map(),
};

function resetTables(): void {
  for (const t of Object.keys(tables) as TableName[]) tables[t].clear();
}

function pickTable(sql: string): TableName {
  for (const name of Object.keys(tables) as TableName[]) {
    if (sql.includes(name)) return name;
  }
  throw new Error(`shim: unknown table in SQL: ${sql.slice(0, 80)}`);
}

function fakeQuery(sql: string) {
  const lower = sql.toLowerCase().trim();
  return {
    get(...params: unknown[]) {
      if (lower.startsWith('select')) {
        const table = pickTable(sql);
        if (lower.includes('count(*)')) {
          return { c: tables[table]!.size };
        }
        const key = String(params[0]);
        const row = tables[table]!.get(key);
        return row;
      }
      return undefined;
    },
    all(...params: unknown[]) {
      const table = pickTable(sql);
      if (lower.includes('order by last_accessed_at asc')) {
        return Array.from(tables[table]!.values()).sort(
          (a, b) => (a.last_accessed_at as number) - (b.last_accessed_at as number),
        );
      }
      if (lower.includes('select size_bytes from video_files')) {
        return Array.from(tables[table]!.values()).map((r) => ({ size_bytes: r.size_bytes }));
      }
      // Generic "all rows" fallback (unused by cache module currently).
      void params;
      return Array.from(tables[table]!.values());
    },
    run(...params: unknown[]) {
      const table = pickTable(sql);
      if (lower.startsWith('insert')) {
        if (table === 'video_transcripts') {
          const [url_canonical, platform, transcript_json, model, duration_ms, created_at] =
            params as [string, string, string, string, number, number];
          tables[table]!.set(url_canonical, {
            url_canonical,
            platform,
            transcript_json,
            model,
            duration_ms,
            created_at,
          });
        } else if (table === 'video_vision') {
          const [url_canonical, platform, vision_json, frame_count, model, created_at] = params as [
            string,
            string,
            string,
            number,
            string,
            number,
          ];
          tables[table]!.set(url_canonical, {
            url_canonical,
            platform,
            vision_json,
            frame_count,
            model,
            created_at,
          });
        } else if (table === 'video_files') {
          const [url_canonical, file_path, size_bytes, platform, last_accessed_at, created_at] =
            params as [string, string, number, string, number, number];
          tables[table]!.set(url_canonical, {
            url_canonical,
            file_path,
            size_bytes,
            platform,
            last_accessed_at,
            created_at,
          });
        }
      } else if (lower.startsWith('update')) {
        // UPDATE video_files SET last_accessed_at = ? WHERE url_canonical = ?
        const [last_accessed_at, url_canonical] = params as [number, string];
        const row = tables[table]!.get(url_canonical);
        if (row) row.last_accessed_at = last_accessed_at;
      } else if (lower.startsWith('delete')) {
        const url_canonical = String(params[0]);
        tables[table]!.delete(url_canonical);
      }
    },
  };
}

function fakeExec(sql: string): void {
  const lower = sql.toLowerCase().trim();
  if (lower.startsWith('delete from')) {
    const table = pickTable(sql);
    tables[table]!.clear();
  }
  // Migrations / pragmas are silent no-ops in the shim.
}

const fakeDb = {
  query: fakeQuery,
  exec: fakeExec,
};

const fakeDbModule = {
  getDb: () => fakeDb,
  closeDb: () => {
    /* noop */
  },
  isFresh: (ms: number) => Date.now() - ms < 86400 * 1000,
};

// ──────────────────────────────────────────────────────────────────────
// Imports happen after the shim is constructed. We inject the shim into
// the lazy db handle in `beforeAll` so the cache module never invokes
// its require('../cache/db.ts') fallback.
// ──────────────────────────────────────────────────────────────────────
import { resetConfigForTests } from '../../src/core/config.ts';
import { _orchestratorDeps, analyzeVideo } from '../../src/intelligence/video.ts';
import type { Transcript } from '../../src/models/video-report.ts';
import {
  _setDbModuleForTests,
  clearVideoCache,
  defaultVideoCacheMaxBytes,
  evictVideoFilesLRU,
  getCachedTranscript,
  getCachedVideoFile,
  getCachedVision,
  putCachedTranscript,
  putCachedVision,
  recordVideoFile,
  videoCacheDir,
  videoCacheInfo,
  videoFileDir,
  videoFilePathFor,
} from '../../src/video/cache.ts';

// Isolate XRAY_HOME to a per-test tempdir so videoCacheDir() is sandboxed.
const TMP_XRAY_HOME = join(tmpdir(), `xray-p22-${Date.now()}-${process.pid}`);
const ORIG_XRAY_HOME = process.env.XRAY_HOME;

beforeAll(() => {
  process.env.XRAY_HOME = TMP_XRAY_HOME;
  mkdirSync(TMP_XRAY_HOME, { recursive: true });
  // Reset cached config so XRAY_HOME takes effect.
  resetConfigForTests();
  // Inject the in-memory shim BEFORE the cache module's first call.
  _setDbModuleForTests(fakeDbModule as unknown as typeof import('../../src/cache/db.ts'));
});

afterAll(() => {
  // biome-ignore lint/performance/noDelete: process.env coerces undefined to "undefined"; delete is the correct way to unset
  if (ORIG_XRAY_HOME === undefined) delete process.env.XRAY_HOME;
  else process.env.XRAY_HOME = ORIG_XRAY_HOME;
  resetConfigForTests();
  _setDbModuleForTests(undefined);
  try {
    rmSync(TMP_XRAY_HOME, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

beforeEach(() => {
  resetTables();
});

// ──────────────────────────────────────────────────────────────────────
// 1. Path helpers
// ──────────────────────────────────────────────────────────────────────

describe('video cache path helpers', () => {
  it('videoCacheDir is rooted at {XRAY_HOME}/cache/video', () => {
    expect(videoCacheDir()).toBe(join(TMP_XRAY_HOME, 'cache', 'video'));
  });

  it('videoFileDir nests per platform', () => {
    expect(videoFileDir('youtube')).toBe(join(TMP_XRAY_HOME, 'cache', 'video', 'youtube'));
    expect(videoFileDir('x-native')).toBe(join(TMP_XRAY_HOME, 'cache', 'video', 'x-native'));
  });

  it('videoFilePathFor is deterministic per canonical URL + platform', () => {
    const a = videoFilePathFor('https://youtube.com/watch?v=abc', 'youtube');
    const b = videoFilePathFor('https://youtube.com/watch?v=abc', 'youtube');
    const c = videoFilePathFor('https://youtube.com/watch?v=def', 'youtube');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.endsWith('.mp4')).toBe(true);
    expect(a.includes('/youtube/')).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 2. Transcript cache round-trip + TTL
// ──────────────────────────────────────────────────────────────────────

describe('transcript cache', () => {
  const url = 'https://youtube.com/watch?v=abc';
  const transcript: Transcript = {
    text: 'hello world',
    segments: [{ startMs: 0, endMs: 1500, text: 'hello world' }],
    language: 'en',
    empty: false,
  };

  it('returns undefined on miss', () => {
    expect(getCachedTranscript(url)).toBeUndefined();
  });

  it('round-trips a put/get', () => {
    putCachedTranscript({
      urlCanonical: url,
      platform: 'youtube',
      transcript,
      model: 'whisper-v3-turbo',
      durationSec: 12.5,
      estimatedCostUsd: 0.001,
    });
    const got = getCachedTranscript(url);
    expect(got?.transcript.text).toBe('hello world');
    expect(got?.transcript.segments).toHaveLength(1);
    expect(got?.durationSec).toBe(12.5);
    expect(got?.estimatedCostUsd).toBe(0.001);
  });

  it('UPSERTs on duplicate URL (latest write wins)', () => {
    putCachedTranscript({
      urlCanonical: url,
      platform: 'youtube',
      transcript,
      model: 'whisper-v3-turbo',
    });
    const updated: Transcript = { ...transcript, text: 'updated text', empty: false };
    putCachedTranscript({
      urlCanonical: url,
      platform: 'youtube',
      transcript: updated,
      model: 'whisper-v3-turbo',
    });
    expect(getCachedTranscript(url)?.transcript.text).toBe('updated text');
  });

  it('returns undefined for stale rows (TTL expired)', () => {
    // Insert directly with a created_at far in the past — shim stores ms.
    tables.video_transcripts.set(url, {
      url_canonical: url,
      platform: 'youtube',
      transcript_json: JSON.stringify({ transcript, durationSec: 0, estimatedCostUsd: 0 }),
      model: 'whisper-v3-turbo',
      duration_ms: 0,
      created_at: Date.now() - 365 * 24 * 60 * 60 * 1000, // 1 year old
    });
    expect(getCachedTranscript(url)).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 3. Vision cache round-trip
// ──────────────────────────────────────────────────────────────────────

describe('vision cache', () => {
  const url = 'https://youtube.com/watch?v=visioned';

  it('round-trips a put/get with visualSummary', () => {
    putCachedVision({
      urlCanonical: url,
      platform: 'youtube',
      vision: {
        analyses: [
          { timestampMs: 0, description: 'opening' },
          { timestampMs: 5000, description: 'mid-frame' },
        ],
        visualSummary: 'A short demo.',
        estimatedCostUsd: 0.02,
      },
      frameCount: 2,
      model: 'gemini-2.5-flash',
    });
    const got = getCachedVision(url);
    expect(got?.analyses).toHaveLength(2);
    expect(got?.visualSummary).toBe('A short demo.');
    expect(got?.estimatedCostUsd).toBe(0.02);
  });

  it('missing visualSummary stays optional', () => {
    putCachedVision({
      urlCanonical: url,
      platform: 'youtube',
      vision: {
        analyses: [{ timestampMs: 0, description: 'x' }],
        estimatedCostUsd: 0.005,
      },
      frameCount: 1,
      model: 'gemini-2.5-flash',
    });
    const got = getCachedVision(url);
    expect(got?.visualSummary).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────────
// 4. Video file cache + LRU eviction
// ──────────────────────────────────────────────────────────────────────

describe('video file cache + LRU eviction', () => {
  const SCRATCH = join(TMP_XRAY_HOME, 'scratch-files');

  beforeEach(() => {
    mkdirSync(SCRATCH, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(SCRATCH, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function makeFile(name: string, size: number): string {
    const p = join(SCRATCH, name);
    writeFileSync(p, Buffer.alloc(size, 0));
    return p;
  }

  it('returns undefined on miss', () => {
    expect(getCachedVideoFile('https://youtube.com/watch?v=miss')).toBeUndefined();
  });

  it('record + get returns the path and bumps last_accessed_at (UPSERT)', async () => {
    const url = 'https://youtube.com/watch?v=upsert';
    const file = makeFile('upsert.mp4', 100);

    recordVideoFile({
      urlCanonical: url,
      filePath: file,
      sizeBytes: 100,
      platform: 'youtube',
    });
    const first = tables.video_files.get(url)?.last_accessed_at as number;
    expect(typeof first).toBe('number');

    // Wait a couple ms so the touch produces a strictly newer timestamp.
    await new Promise((r) => setTimeout(r, 5));

    const cached = getCachedVideoFile(url);
    expect(cached?.filePath).toBe(file);
    expect(cached?.sizeBytes).toBe(100);

    const second = tables.video_files.get(url)?.last_accessed_at as number;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('returns undefined and drops the row when the file vanished out of band', () => {
    const url = 'https://youtube.com/watch?v=ghost';
    recordVideoFile({
      urlCanonical: url,
      filePath: join(SCRATCH, 'never-existed.mp4'),
      sizeBytes: 10,
      platform: 'youtube',
    });
    expect(tables.video_files.has(url)).toBe(true);
    expect(getCachedVideoFile(url)).toBeUndefined();
    expect(tables.video_files.has(url)).toBe(false);
  });

  it('evictVideoFilesLRU is a no-op when total ≤ maxBytes', () => {
    const url = 'https://youtube.com/watch?v=under';
    const file = makeFile('under.mp4', 10);
    recordVideoFile({ urlCanonical: url, filePath: file, sizeBytes: 10, platform: 'youtube' });
    expect(evictVideoFilesLRU(1_000_000_000)).toEqual({ evicted: 0, freedBytes: 0 });
    expect(existsSync(file)).toBe(true);
  });

  it('evicts oldest-first until under budget', async () => {
    // 5 files at 300MB each = 1.5GB; budget 1GB → must evict 2 oldest.
    const SIZE = 300_000_000;
    const urls: string[] = [];
    for (let i = 0; i < 5; i++) {
      const u = `https://youtube.com/watch?v=lru-${i}`;
      urls.push(u);
      // Use a small real file (10 bytes); the LRU index uses the
      // reported sizeBytes, not the actual file size.
      const f = makeFile(`lru-${i}.mp4`, 10);
      recordVideoFile({ urlCanonical: u, filePath: f, sizeBytes: SIZE, platform: 'youtube' });
      // Stagger writes so last_accessed_at strictly differs.
      await new Promise((r) => setTimeout(r, 2));
    }

    const res = evictVideoFilesLRU(1_000_000_000);
    // 1.5GB - 1.0GB = 500MB to free; 2 oldest @ 300MB = 600MB freed.
    expect(res.evicted).toBe(2);
    expect(res.freedBytes).toBe(2 * SIZE);

    // The 3 newest should still be present.
    expect(tables.video_files.has(urls[0]!)).toBe(false);
    expect(tables.video_files.has(urls[1]!)).toBe(false);
    expect(tables.video_files.has(urls[2]!)).toBe(true);
    expect(tables.video_files.has(urls[3]!)).toBe(true);
    expect(tables.video_files.has(urls[4]!)).toBe(true);
  });

  it('eviction swallows ENOENT on missing files', () => {
    const url = 'https://youtube.com/watch?v=enoent';
    // Record a row whose file_path doesn't exist on disk. Eviction should
    // still delete the row (not throw).
    tables.video_files.set(url, {
      url_canonical: url,
      file_path: '/nonexistent/path/x.mp4',
      size_bytes: 2_000_000_000,
      platform: 'youtube',
      last_accessed_at: Date.now() - 1000,
      created_at: Date.now() - 1000,
    });
    const res = evictVideoFilesLRU(1_000_000_000);
    expect(res.evicted).toBe(1);
    expect(tables.video_files.has(url)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5. clearVideoCache + videoCacheInfo
// ──────────────────────────────────────────────────────────────────────

describe('clearVideoCache + videoCacheInfo', () => {
  it('clearVideoCache empties all 3 tables + removes the dir', () => {
    const url = 'https://youtube.com/watch?v=clear';
    putCachedTranscript({
      urlCanonical: url,
      platform: 'youtube',
      transcript: { text: 'x', segments: [], empty: false },
      model: 'whisper-v3-turbo',
    });
    putCachedVision({
      urlCanonical: url,
      platform: 'youtube',
      vision: { analyses: [], estimatedCostUsd: 0 },
      frameCount: 0,
      model: 'gemini-2.5-flash',
    });
    // Seed the dir so we can confirm it disappears.
    mkdirSync(videoCacheDir(), { recursive: true });
    const dummy = join(videoCacheDir(), 'something.txt');
    writeFileSync(dummy, 'x');

    clearVideoCache();

    expect(tables.video_transcripts.size).toBe(0);
    expect(tables.video_vision.size).toBe(0);
    expect(tables.video_files.size).toBe(0);
    // clearVideoCache recreates an empty dir afterward.
    expect(existsSync(videoCacheDir())).toBe(true);
    expect(existsSync(dummy)).toBe(false);
  });

  it('videoCacheInfo reports counts + totalBytes', () => {
    putCachedTranscript({
      urlCanonical: 'a',
      platform: 'youtube',
      transcript: { text: 'x', segments: [], empty: false },
      model: 'm',
    });
    putCachedTranscript({
      urlCanonical: 'b',
      platform: 'youtube',
      transcript: { text: 'y', segments: [], empty: false },
      model: 'm',
    });
    putCachedVision({
      urlCanonical: 'a',
      platform: 'youtube',
      vision: { analyses: [], estimatedCostUsd: 0 },
      frameCount: 0,
      model: 'm',
    });
    tables.video_files.set('a', {
      url_canonical: 'a',
      file_path: '/x',
      size_bytes: 1234,
      platform: 'youtube',
      last_accessed_at: Date.now(),
      created_at: Date.now(),
    });
    const info = videoCacheInfo();
    expect(info.transcriptCount).toBe(2);
    expect(info.visionCount).toBe(1);
    expect(info.fileCount).toBe(1);
    expect(info.totalBytes).toBe(1234);
    expect(info.dir).toContain('video');
  });
});

// ──────────────────────────────────────────────────────────────────────
// 6. Orchestrator-level cache hits + bypass
// ──────────────────────────────────────────────────────────────────────

describe('analyzeVideo URL-level cache integration', () => {
  const url = 'https://youtube.com/watch?v=orchestrator';

  const SCRATCH = join(TMP_XRAY_HOME, 'orch-scratch');
  let restore: Array<() => void>;

  beforeEach(() => {
    restore = [];
    mkdirSync(SCRATCH, { recursive: true });
    // Re-init the dep seam from defaults — vitest's vi.spyOn handles
    // restoration but we want explicit overrides so each test is fully
    // isolated from network/disk side effects.
  });

  afterEach(() => {
    for (const r of restore.splice(0)) r();
    try {
      rmSync(SCRATCH, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  function patch<K extends keyof typeof _orchestratorDeps>(
    key: K,
    impl: (typeof _orchestratorDeps)[K],
  ): void {
    const orig = _orchestratorDeps[key];
    _orchestratorDeps[key] = impl;
    restore.push(() => {
      _orchestratorDeps[key] = orig;
    });
  }

  function stubChat() {
    // Synthesis goes through kyma client.chat — bypass it by stubbing
    // runSynthesis on the seam (no kyma key in test env anyway).
    patch(
      'runSynthesis',
      vi.fn(async () => ({})),
    );
  }

  it('hits both caches → skips download / extract / transcribe / vision entirely', async () => {
    // Seed both caches.
    putCachedTranscript({
      urlCanonical: url,
      platform: 'youtube',
      transcript: { text: 'cached transcript', segments: [], empty: false },
      model: 'whisper-v3-turbo',
      durationSec: 60,
      estimatedCostUsd: 0.001,
    });
    putCachedVision({
      urlCanonical: url,
      platform: 'youtube',
      vision: {
        analyses: [{ timestampMs: 0, description: 'cached frame' }],
        visualSummary: 'cached summary',
        estimatedCostUsd: 0.005,
      },
      frameCount: 1,
      model: 'gemini-2.5-flash',
    });

    const downloadSpy = vi.fn(async () => {
      throw new Error('downloadVideo should not be called on a full cache hit');
    });
    const audioSpy = vi.fn(async () => {
      throw new Error('extractAudio should not be called on a full cache hit');
    });
    const framesSpy = vi.fn(async () => {
      throw new Error('extractFrames should not be called on a full cache hit');
    });
    const transcribeSpy = vi.fn(async () => {
      throw new Error('transcribeAudio should not be called on a full cache hit');
    });
    const visionSpy = vi.fn(async () => {
      throw new Error('analyzeFrames should not be called on a full cache hit');
    });

    patch('downloadVideo', downloadSpy as unknown as typeof _orchestratorDeps.downloadVideo);
    patch('extractAudio', audioSpy as unknown as typeof _orchestratorDeps.extractAudio);
    patch('extractFrames', framesSpy as unknown as typeof _orchestratorDeps.extractFrames);
    patch('transcribeAudio', transcribeSpy as unknown as typeof _orchestratorDeps.transcribeAudio);
    patch('analyzeFrames', visionSpy as unknown as typeof _orchestratorDeps.analyzeFrames);
    stubChat();

    const report = await analyzeVideo(url, { cleanup: false });
    expect(report.url).toBe(url);
    expect(report.transcript?.text).toBe('cached transcript');
    expect(report.frames?.analyses[0]?.description).toBe('cached frame');

    expect(downloadSpy).not.toHaveBeenCalled();
    expect(audioSpy).not.toHaveBeenCalled();
    expect(framesSpy).not.toHaveBeenCalled();
    expect(transcribeSpy).not.toHaveBeenCalled();
    expect(visionSpy).not.toHaveBeenCalled();
  });

  it('noCache: true bypasses the cache even when both are populated', async () => {
    // Pre-seed cache (which should be ignored).
    putCachedTranscript({
      urlCanonical: url,
      platform: 'youtube',
      transcript: { text: 'cached', segments: [], empty: false },
      model: 'whisper-v3-turbo',
    });
    putCachedVision({
      urlCanonical: url,
      platform: 'youtube',
      vision: {
        analyses: [{ timestampMs: 0, description: 'cached' }],
        estimatedCostUsd: 0,
      },
      frameCount: 1,
      model: 'gemini-2.5-flash',
    });

    const downloadSpy = vi.fn(async () => {
      const filePath = join(SCRATCH, 'noCache.mp4');
      writeFileSync(filePath, Buffer.alloc(200, 0));
      return {
        filePath,
        source: 'youtube' as const,
        platform: 'youtube' as const,
        sizeBytes: 200,
        durationMs: 5000,
        sourceUrl: url,
      };
    });

    // Audio extraction can return null (no audio) — orchestrator handles
    // this without invoking transcribe.
    const audioSpy = vi.fn(async () => ({
      audioPath: null,
      durationMs: 5000,
      sizeBytes: 0,
      silent: true,
    }));

    const framesSpy = vi.fn(async () => ({
      frames: [],
      method: 'evenly-spaced' as const,
      threshold: undefined,
    }));

    const transcribeSpy = vi.fn(async () => {
      throw new Error('should not be called (silent audio)');
    });
    const visionSpy = vi.fn(async () => {
      throw new Error('should not be called (no frames)');
    });

    patch('downloadVideo', downloadSpy as unknown as typeof _orchestratorDeps.downloadVideo);
    patch('extractAudio', audioSpy as unknown as typeof _orchestratorDeps.extractAudio);
    patch('extractFrames', framesSpy as unknown as typeof _orchestratorDeps.extractFrames);
    patch('transcribeAudio', transcribeSpy as unknown as typeof _orchestratorDeps.transcribeAudio);
    patch('analyzeFrames', visionSpy as unknown as typeof _orchestratorDeps.analyzeFrames);
    stubChat();

    const report = await analyzeVideo(url, { noCache: true, cleanup: false });
    expect(downloadSpy).toHaveBeenCalledTimes(1);
    expect(audioSpy).toHaveBeenCalledTimes(1);
    expect(framesSpy).toHaveBeenCalledTimes(1);
    // Silent audio → transcript becomes empty; vision spy untouched.
    expect(report.transcript?.empty).toBe(true);
  });

  it('transcript-only cache hit still downloads + extracts frames + runs vision', async () => {
    // Vision branch requires a Kyma key; set it for the duration.
    const origKey = process.env.KYMA_API_KEY;
    process.env.KYMA_API_KEY = 'test-key';
    resetConfigForTests();

    try {
      putCachedTranscript({
        urlCanonical: url,
        platform: 'youtube',
        transcript: { text: 'previously transcribed', segments: [], empty: false },
        model: 'whisper-v3-turbo',
        durationSec: 30,
        estimatedCostUsd: 0.001,
      });
      // Vision NOT cached.

      const filePath = join(SCRATCH, 'tx-only.mp4');
      const downloadSpy = vi.fn(async () => {
        writeFileSync(filePath, Buffer.alloc(100, 0));
        return {
          filePath,
          source: 'youtube' as const,
          platform: 'youtube' as const,
          sizeBytes: 100,
          durationMs: 30_000,
          sourceUrl: url,
        };
      });

      const audioSpy = vi.fn(async () => {
        throw new Error('extractAudio should NOT run when transcript is cached');
      });

      const frameJpeg = join(SCRATCH, 'frame.jpg');
      writeFileSync(frameJpeg, Buffer.alloc(50, 0));
      const framesSpy = vi.fn(async () => ({
        frames: [{ path: frameJpeg, timestampMs: 0 }],
        method: 'scene-detect' as const,
        threshold: 0.3,
      }));

      const transcribeSpy = vi.fn(async () => {
        throw new Error('transcribe should NOT run when transcript is cached');
      });

      const visionSpy = vi.fn(async () => ({
        analyses: [{ timestampMs: 0, description: 'fresh vision' }],
        visualSummary: 'fresh',
        estimatedCostUsd: 0.005,
        cached: false,
      }));

      patch('downloadVideo', downloadSpy as unknown as typeof _orchestratorDeps.downloadVideo);
      patch('extractAudio', audioSpy as unknown as typeof _orchestratorDeps.extractAudio);
      patch('extractFrames', framesSpy as unknown as typeof _orchestratorDeps.extractFrames);
      patch(
        'transcribeAudio',
        transcribeSpy as unknown as typeof _orchestratorDeps.transcribeAudio,
      );
      patch('analyzeFrames', visionSpy as unknown as typeof _orchestratorDeps.analyzeFrames);
      stubChat();

      const report = await analyzeVideo(url, { cleanup: false });

      expect(downloadSpy).toHaveBeenCalledTimes(1);
      expect(audioSpy).not.toHaveBeenCalled();
      expect(framesSpy).toHaveBeenCalledTimes(1);
      expect(transcribeSpy).not.toHaveBeenCalled();
      expect(visionSpy).toHaveBeenCalledTimes(1);

      expect(report.transcript?.text).toBe('previously transcribed');
      expect(report.frames?.analyses[0]?.description).toBe('fresh vision');

      // Vision was just freshly computed → should now be in the cache.
      expect(getCachedVision(url)).toBeDefined();

      // Use real fs to confirm download was recorded into the LRU index.
      expect(tables.video_files.has(url)).toBe(true);
    } finally {
      // biome-ignore lint/performance/noDelete: process.env coerces undefined to "undefined"; delete is the correct way to unset
      if (origKey === undefined) delete process.env.KYMA_API_KEY;
      else process.env.KYMA_API_KEY = origKey;
      resetConfigForTests();
    }
  });

  it('writes both caches on a full miss success', async () => {
    const filePath = join(SCRATCH, 'fresh.mp4');
    const downloadSpy = vi.fn(async () => {
      writeFileSync(filePath, Buffer.alloc(100, 0));
      return {
        filePath,
        source: 'youtube' as const,
        platform: 'youtube' as const,
        sizeBytes: 100,
        durationMs: 30_000,
        sourceUrl: url,
      };
    });

    const audioFile = join(SCRATCH, 'fresh.mp3');
    writeFileSync(audioFile, Buffer.alloc(20, 0));
    const audioSpy = vi.fn(async () => ({
      audioPath: audioFile,
      durationMs: 30_000,
      sizeBytes: 20,
      silent: false,
    }));

    const frameJpeg = join(SCRATCH, 'fresh-frame.jpg');
    writeFileSync(frameJpeg, Buffer.alloc(50, 0));
    const framesSpy = vi.fn(async () => ({
      frames: [{ path: frameJpeg, timestampMs: 0 }],
      method: 'scene-detect' as const,
      threshold: 0.3,
    }));

    const transcribeSpy = vi.fn(async () => ({
      transcript: { text: 'fresh transcript', segments: [], empty: false },
      estimatedCostUsd: 0.001,
      cached: false,
      durationSec: 30,
    }));

    const visionSpy = vi.fn(async () => ({
      analyses: [{ timestampMs: 0, description: 'fresh visual' }],
      estimatedCostUsd: 0.005,
      cached: false,
    }));

    patch('downloadVideo', downloadSpy as unknown as typeof _orchestratorDeps.downloadVideo);
    patch('extractAudio', audioSpy as unknown as typeof _orchestratorDeps.extractAudio);
    patch('extractFrames', framesSpy as unknown as typeof _orchestratorDeps.extractFrames);
    patch('transcribeAudio', transcribeSpy as unknown as typeof _orchestratorDeps.transcribeAudio);
    patch('analyzeFrames', visionSpy as unknown as typeof _orchestratorDeps.analyzeFrames);
    stubChat();

    // Need to bridge cfg.kyma.key so the transcribe + vision branches run.
    const origKey = process.env.KYMA_API_KEY;
    process.env.KYMA_API_KEY = 'test-key';
    resetConfigForTests();

    try {
      await analyzeVideo(url, { cleanup: false });
      expect(getCachedTranscript(url)?.transcript.text).toBe('fresh transcript');
      expect(getCachedVision(url)?.analyses[0]?.description).toBe('fresh visual');
      expect(tables.video_files.has(url)).toBe(true);
    } finally {
      // biome-ignore lint/performance/noDelete: process.env coerces undefined to "undefined"; delete is the correct way to unset
      if (origKey === undefined) delete process.env.KYMA_API_KEY;
      else process.env.KYMA_API_KEY = origKey;
      resetConfigForTests();
    }
  });

  it('reuses an LRU-cached mp4 instead of re-downloading', async () => {
    // Pre-warm the file cache with an existing mp4 + a stale transcript
    // entry (so we still hit the "needDownload" path).
    const filePath = join(SCRATCH, 'cached.mp4');
    writeFileSync(filePath, Buffer.alloc(64, 0));
    recordVideoFile({
      urlCanonical: url,
      filePath,
      sizeBytes: 64,
      platform: 'youtube',
    });

    const downloadSpy = vi.fn(async () => {
      throw new Error('should not download when the file is LRU-cached');
    });
    const audioSpy = vi.fn(async () => ({
      audioPath: null,
      durationMs: 0,
      sizeBytes: 0,
      silent: true,
    }));
    const framesSpy = vi.fn(async () => ({
      frames: [],
      method: 'evenly-spaced' as const,
    }));
    const transcribeSpy = vi.fn(async () => ({
      transcript: { text: '', segments: [], empty: true },
      estimatedCostUsd: 0,
      cached: false,
      durationSec: 0,
    }));
    const visionSpy = vi.fn(async () => ({
      analyses: [],
      estimatedCostUsd: 0,
      cached: false,
    }));

    patch('downloadVideo', downloadSpy as unknown as typeof _orchestratorDeps.downloadVideo);
    patch('extractAudio', audioSpy as unknown as typeof _orchestratorDeps.extractAudio);
    patch('extractFrames', framesSpy as unknown as typeof _orchestratorDeps.extractFrames);
    patch('transcribeAudio', transcribeSpy as unknown as typeof _orchestratorDeps.transcribeAudio);
    patch('analyzeFrames', visionSpy as unknown as typeof _orchestratorDeps.analyzeFrames);
    stubChat();

    await analyzeVideo(url, { cleanup: false });
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(existsSync(filePath)).toBe(true);
  });
});

describe('defaultVideoCacheMaxBytes (XRAY_VIDEO_CACHE_MAX_GB env var)', () => {
  const ORIG = process.env.XRAY_VIDEO_CACHE_MAX_GB;
  const unset = () => {
    // biome-ignore lint/performance/noDelete: env var unset != empty string for test isolation
    delete process.env.XRAY_VIDEO_CACHE_MAX_GB;
  };
  afterEach(() => {
    if (ORIG === undefined) unset();
    else process.env.XRAY_VIDEO_CACHE_MAX_GB = ORIG;
  });

  it('returns 5 GB when env var unset', () => {
    unset();
    expect(defaultVideoCacheMaxBytes()).toBe(5 * 1_000_000_000);
  });

  it('honours valid override', () => {
    process.env.XRAY_VIDEO_CACHE_MAX_GB = '20';
    expect(defaultVideoCacheMaxBytes()).toBe(20 * 1_000_000_000);
  });

  it('accepts fractional gigabytes', () => {
    process.env.XRAY_VIDEO_CACHE_MAX_GB = '2.5';
    expect(defaultVideoCacheMaxBytes()).toBe(2_500_000_000);
  });

  it('falls back to 5 GB on unparseable input', () => {
    process.env.XRAY_VIDEO_CACHE_MAX_GB = 'wat';
    expect(defaultVideoCacheMaxBytes()).toBe(5 * 1_000_000_000);
  });

  it('falls back to 5 GB on non-positive numbers', () => {
    process.env.XRAY_VIDEO_CACHE_MAX_GB = '0';
    expect(defaultVideoCacheMaxBytes()).toBe(5 * 1_000_000_000);
    process.env.XRAY_VIDEO_CACHE_MAX_GB = '-3';
    expect(defaultVideoCacheMaxBytes()).toBe(5 * 1_000_000_000);
  });
});

// Reference: silence unused-import false positives in editors.
void fsStatSync;
