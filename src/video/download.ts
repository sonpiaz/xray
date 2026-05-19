import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'undici';
import { VideoDownloadError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { XMedia } from '../models/media.ts';
import type { VideoSource } from '../models/video-report.ts';
import { assertFfmpeg, assertYtDlp, checkDependencies } from './dependencies.ts';
import { SUPPORTED_PLATFORMS_LABEL, detectPlatform } from './platforms.ts';
import { runProcess } from './proc.ts';
import { type YtDlpDownloadOptions, downloadViaYtDlp } from './ytdlp.ts';

/**
 * P2.0 — X-native only. P2.1 will extend this module with platform
 * detection + yt-dlp wrapper.
 *
 * Result shape mirrors what the orchestrator needs to drive the rest of
 * the pipeline without re-reading the file.
 */
export type DownloadResult = {
  filePath: string;
  sizeBytes: number;
  durationMs?: number;
  platform: VideoSource;
  sourceUrl: string;
};

export type DownloadOptions = {
  /** Override temp dir. Defaults to {tmpdir}/xray-video. */
  tmpDir?: string;
  /** Hard wall-clock timeout for the download. Defaults to 120s. */
  timeoutMs?: number;
  /** User-Agent string. X CDN serves mp4 to any standard browser UA. */
  userAgent?: string;
};

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';

/**
 * Download an X-native video (mp4 already parsed from GraphQL
 * video_info.variants — see fetcher/parser.ts) to a local file.
 *
 * P2.0 writes to /tmp; P2.2 will swap this for ~/.xray/cache/video/ with
 * LRU. The orchestrator deletes the file after processing — only the
 * derived analyses are cached (per spec §9.4).
 */
export async function downloadXNativeVideo(
  media: XMedia,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  if (media.type !== 'video') {
    throw new VideoDownloadError(`Expected media.type === 'video', got '${media.type}'`);
  }

  const deps = await checkDependencies();
  assertFfmpeg(deps);

  const tmpRoot = opts.tmpDir ?? join(tmpdir(), 'xray-video');
  mkdirSync(tmpRoot, { recursive: true });

  // Stable-ish filename keyed by URL hash so concurrent calls on the same
  // video don't clobber each other. We don't reuse across runs in P2.0 —
  // caching is P2.2's job.
  const urlHash = createHash('sha256').update(media.url).digest('hex').slice(0, 16);
  const filePath = join(tmpRoot, `xray-video-${urlHash}.mp4`);

  const timeoutMs = opts.timeoutMs ?? 120_000;
  const ua = opts.userAgent ?? DEFAULT_UA;

  logger.debug('video download start', { url: media.url, filePath });

  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(media.url, {
      method: 'GET',
      headers: {
        'user-agent': ua,
        accept: 'video/mp4,video/*;q=0.9,*/*;q=0.5',
      },
      bodyTimeout: timeoutMs,
      headersTimeout: 30_000,
    });
  } catch (err) {
    throw new VideoDownloadError(`Network error downloading video: ${String(err)}`, {
      transient: true,
      cause: err,
    });
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new VideoDownloadError(`X CDN returned ${res.statusCode} for ${media.url}`, {
      transient: res.statusCode >= 500 || res.statusCode === 429,
    });
  }

  const buf = Buffer.from(await res.body.arrayBuffer());
  writeFileSync(filePath, buf);

  // Probe duration for ground truth — XMedia.durationMs comes from X's
  // GraphQL response and is usually correct, but defensively double-check
  // so frame extraction has reliable timing.
  const durationMs =
    media.durationMs ??
    (await probeDurationMs(
      filePath,
      deps.ffprobe.available ? (deps.ffprobe as { path: string }).path : 'ffprobe',
    ));

  logger.debug('video download done', {
    filePath,
    sizeBytes: buf.length,
    durationMs,
  });

  return {
    filePath,
    sizeBytes: buf.length,
    ...(durationMs !== undefined ? { durationMs } : {}),
    platform: 'x-native',
    sourceUrl: media.url,
  };
}

/**
 * P2.1 — Top-level platform-routing download entry point.
 *
 * Routing decisions (in order):
 *  1. URL is an X post AND a parsed `mediaHint` of type 'video' is
 *     provided → direct undici fetch of the CDN mp4 (fastest, no yt-dlp).
 *  2. URL is an X post WITHOUT a mediaHint (SSR fallback) → yt-dlp.
 *  3. URL is YouTube / TikTok / Vimeo / LinkedIn → yt-dlp.
 *  4. Host is unknown → throw `VideoDownloadError` listing supported
 *     platforms.
 *
 * The X-native + mediaHint shortcut is important because it avoids a yt-dlp
 * dependency for the most common case (X threads with native video). The
 * orchestrator in `intelligence/video.ts` should always pass `mediaHint`
 * when it has one from `parser.ts`.
 */
export type DownloadVideoOptions = {
  /** Raw URL the user supplied. Used for platform detection. */
  url: string;
  /**
   * When the caller has already parsed an `XMedia` of type 'video' from a
   * GraphQL response, pass it here to skip yt-dlp entirely. Optional.
   */
  mediaHint?: XMedia;
  /** Output directory for yt-dlp downloads. Defaults to {tmpdir}/xray-video. */
  outputDir?: string;
  /** Override the yt-dlp invocation timeout. */
  timeoutMs?: number;
  /** Test seam — forwarded to the yt-dlp wrapper. */
  ytDlpSpawn?: YtDlpDownloadOptions['spawn'];
};

export type VideoDownloadResult = {
  filePath: string;
  source: VideoSource;
  /** Same as `source` — kept for forward-compat with reports. */
  platform: VideoSource;
  sizeBytes: number;
  durationMs?: number;
  title?: string;
  /** The URL that was actually downloaded from (may differ from the input). */
  sourceUrl: string;
};

export async function downloadVideo(opts: DownloadVideoOptions): Promise<VideoDownloadResult> {
  const platform = detectPlatform(opts.url);

  // Path 1: X-native with a parsed media hint → direct CDN fetch (skip yt-dlp).
  if (platform === 'x-native' && opts.mediaHint && opts.mediaHint.type === 'video') {
    const res = await downloadXNativeVideo(opts.mediaHint, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return {
      filePath: res.filePath,
      source: 'x-native',
      platform: 'x-native',
      sizeBytes: res.sizeBytes,
      ...(res.durationMs !== undefined ? { durationMs: res.durationMs } : {}),
      sourceUrl: res.sourceUrl,
    };
  }

  // Path 4: unknown platform → fail with the supported-list hint.
  if (platform === null) {
    throw new VideoDownloadError(
      `Unsupported video URL: ${opts.url}. Supported platforms: ${SUPPORTED_PLATFORMS_LABEL}.`,
    );
  }

  // Paths 2 + 3: anything left routes through yt-dlp. Check the binary
  // exists before spawning so we can throw a DependencyError (with the
  // canonical install hint) instead of a generic ENOENT.
  const deps = await checkDependencies({ needYtDlp: true });
  assertYtDlp(deps);

  const baseDir = opts.outputDir ?? join(tmpdir(), 'xray-video');
  // Per-download subdir keyed by URL hash so concurrent calls on different
  // URLs don't collide on the same `{id}.mp4` (yt-dlp resolves output
  // by remote id, but the same id can repeat across platforms — e.g.
  // YouTube's 11-char base64 id space).
  const urlHash = createHash('sha256').update(opts.url).digest('hex').slice(0, 16);
  const outDir = join(baseDir, urlHash);
  mkdirSync(outDir, { recursive: true });

  logger.debug('download via yt-dlp', { url: opts.url, platform, outDir });

  const ytOpts: YtDlpDownloadOptions = {
    outputDir: outDir,
    platform,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.ytDlpSpawn !== undefined ? { spawn: opts.ytDlpSpawn } : {}),
  };

  const res = await downloadViaYtDlp(opts.url, ytOpts);
  return {
    filePath: res.filePath,
    source: platform,
    platform,
    sizeBytes: res.sizeBytes,
    ...(res.durationMs !== undefined ? { durationMs: res.durationMs } : {}),
    ...(res.title !== undefined ? { title: res.title } : {}),
    sourceUrl: opts.url,
  };
}

/**
 * Run ffprobe to extract container duration in ms. Returns undefined on
 * parse failure (silent — duration is a nice-to-have, not load-bearing).
 */
export async function probeDurationMs(
  filePath: string,
  ffprobePath = 'ffprobe',
): Promise<number | undefined> {
  try {
    const res = await runProcess(ffprobePath, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    if (res.code !== 0) return undefined;
    const out = res.stdout.trim();
    if (!out) return undefined;
    const seconds = Number.parseFloat(out);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.round(seconds * 1000);
  } catch (err) {
    logger.debug('ffprobe duration failed', { filePath, err: String(err) });
    return undefined;
  }
}
