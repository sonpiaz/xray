/**
 * P2.1 — yt-dlp subprocess wrapper.
 *
 * Why a dedicated module? `download.ts` is already the platform router
 * (X-native vs everything-else). Keeping the yt-dlp specifics here means
 * the router stays a small switch and the yt-dlp flags live alongside the
 * parsing logic that depends on them.
 *
 * Future enhancement (deliberately out of scope for P2.1):
 *   `--cookies-from-browser chrome` would unlock LinkedIn / age-walled
 *   YouTube content by reusing the Chromium cookie pattern from P1.5.
 *   Skipped because (a) it requires an extra Keychain prompt on macOS
 *   which we can't ask for invisibly, and (b) the cookie-decryption code
 *   path is a separate dependency surface. Tracked for a later sub-phase.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { VideoDownloadError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { VideoSource } from '../models/video-report.ts';
import { runProcess } from './proc.ts';

export type YtDlpDownloadOptions = {
  /** Directory to write the downloaded mp4 + intermediate files into. */
  outputDir: string;
  /** Platform tag — used only for logging + error context. */
  platform: VideoSource;
  /** Hard wall-clock cap. yt-dlp's own --socket-timeout governs per-chunk. */
  timeoutMs?: number;
  /** Override the binary path. Default: 'yt-dlp' (resolved from PATH). */
  binary?: string;
  /** Test seam — inject a fake `runProcess` so we don't actually spawn. */
  spawn?: typeof runProcess;
};

export type YtDlpDownloadResult = {
  filePath: string;
  sizeBytes: number;
  durationMs?: number;
  title?: string;
  videoId?: string;
};

/** Default ceiling on download time. 5 minutes covers most short-form content. */
export const DEFAULT_YT_DLP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Build the argv yt-dlp is invoked with. Exported for unit testing so we
 * can assert flag construction without spawning a real process.
 *
 * - `-f` caps quality at 720p to keep download size + downstream
 *   transcription cost bounded; the trailing `/best` is the fallback when
 *   720p is unavailable (some short TikToks are vertical-only at higher
 *   resolutions).
 * - `--merge-output-format mp4` forces a single mp4 out so downstream
 *   ffmpeg can treat every source identically.
 * - `-o` uses `%(id)s` (universal across platforms) so we know the
 *   output filename ahead of time without listing the dir.
 * - `--print-json` emits a metadata blob to stdout AFTER the download —
 *   we parse it for duration / title / id. The shape varies wildly
 *   across platforms; we only depend on `id`, `duration`, `title` which
 *   are universal.
 */
export function buildYtDlpArgs(url: string, outputDir: string): string[] {
  return [
    '--no-playlist',
    '--no-warnings',
    '--no-progress',
    '-f',
    'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    '--merge-output-format',
    'mp4',
    '-o',
    `${outputDir}/%(id)s.%(ext)s`,
    '--print-json',
    '--socket-timeout',
    '30',
    url,
  ];
}

/**
 * Parse yt-dlp's `--print-json` stdout. yt-dlp emits one JSON object per
 * downloaded video (we use `--no-playlist` so always exactly one). The
 * blob can be quite large (full format metadata + thumbnails) — we only
 * extract the universal fields. Returns `null` when no JSON object can be
 * parsed (TikTok in some failure modes emits warnings to stdout before
 * the JSON — strip leading non-JSON noise).
 */
export function parseYtDlpJson(stdout: string): {
  id?: string;
  title?: string;
  duration?: number;
  filename?: string;
} | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  // Find the first '{' — yt-dlp sometimes prefixes the JSON with progress
  // dots ("..." or "[download] Destination: ..."). The `--no-progress`
  // flag should suppress this, but defensive parsing costs nothing.
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  const candidate = trimmed.slice(start);
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    const result: { id?: string; title?: string; duration?: number; filename?: string } = {};
    if (typeof parsed.id === 'string') result.id = parsed.id;
    if (typeof parsed.title === 'string') result.title = parsed.title;
    if (typeof parsed.duration === 'number' && Number.isFinite(parsed.duration)) {
      result.duration = parsed.duration;
    }
    // yt-dlp sometimes provides the merged filename via `_filename` or
    // `filename` depending on version. Try both.
    if (typeof parsed.filename === 'string') {
      result.filename = parsed.filename;
    } else if (typeof parsed._filename === 'string') {
      result.filename = parsed._filename;
    }
    return result;
  } catch (err) {
    logger.debug('yt-dlp json parse failed', { err: String(err) });
    return null;
  }
}

/**
 * Pattern-match yt-dlp's stderr against common failure modes so we can
 * throw a structured error instead of dumping raw stderr to the user.
 *
 * Returns one of: 'login-required' | 'unavailable' | 'rate-limited' |
 * 'generic'.
 */
export function classifyYtDlpStderr(
  stderr: string,
): 'login-required' | 'unavailable' | 'rate-limited' | 'generic' {
  const lower = stderr.toLowerCase();
  if (
    lower.includes('sign in to confirm your age') ||
    lower.includes('login required') ||
    lower.includes('private video') ||
    lower.includes('this video is only available for') ||
    lower.includes('confirm your age') ||
    lower.includes('cookies are required')
  ) {
    return 'login-required';
  }
  if (
    lower.includes('video unavailable') ||
    lower.includes('removed by the uploader') ||
    lower.includes('this video has been removed') ||
    lower.includes('does not exist') ||
    lower.includes('not available in your country')
  ) {
    return 'unavailable';
  }
  if (
    lower.includes('http error 429') ||
    lower.includes('too many requests') ||
    lower.includes('rate-limited')
  ) {
    return 'rate-limited';
  }
  return 'generic';
}

/**
 * Resolve the path of the downloaded mp4. yt-dlp writes to
 * `{outputDir}/{id}.{ext}` and after `--merge-output-format mp4` the
 * extension is almost always `.mp4` — but some platforms (silent TikToks)
 * end up as `.m4a` or `.webm`. We scan the directory for any file matching
 * the video id.
 */
export function resolveDownloadedFile(outputDir: string, id: string | undefined): string | null {
  if (!existsSync(outputDir)) return null;

  // Prefer the {id}.mp4 path first — cheapest check.
  if (id) {
    const direct = join(outputDir, `${id}.mp4`);
    if (existsSync(direct)) return direct;
  }

  // Fallback: scan the dir for any file starting with `{id}.`
  try {
    const entries = readdirSync(outputDir);
    if (id) {
      const match = entries.find((name) => name.startsWith(`${id}.`) && !name.endsWith('.part'));
      if (match) return join(outputDir, match);
    }
    // Last resort: any single mp4 in the dir (only safe if dir is per-download).
    const mp4 = entries.find((name) => name.endsWith('.mp4'));
    if (mp4) return join(outputDir, mp4);
  } catch (err) {
    logger.debug('resolveDownloadedFile readdir failed', { err: String(err) });
  }
  return null;
}

/**
 * Spawn yt-dlp, wait for it to complete, parse the JSON metadata and
 * resolve the output file path. Throws a typed `VideoDownloadError` on
 * any failure with the failure mode preserved in the message.
 */
export async function downloadViaYtDlp(
  url: string,
  opts: YtDlpDownloadOptions,
): Promise<YtDlpDownloadResult> {
  const spawn = opts.spawn ?? runProcess;
  const binary = opts.binary ?? 'yt-dlp';
  const args = buildYtDlpArgs(url, opts.outputDir);

  logger.debug('yt-dlp invoke', { url, platform: opts.platform, args });

  // Timeout enforcement — we race against the subprocess promise. If the
  // timer wins, we'd ideally kill the process but `runProcess` doesn't
  // expose the child. Surface the timeout as a transient VideoDownloadError;
  // the orphan process will get GC'd when the test/CLI exits. Acceptable
  // tradeoff to keep proc.ts narrow.
  const timeoutMs = opts.timeoutMs ?? DEFAULT_YT_DLP_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new VideoDownloadError(`yt-dlp timed out after ${timeoutMs}ms for ${url}`, {
          transient: true,
        }),
      );
    }, timeoutMs);
  });

  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await Promise.race([spawn(binary, args), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (result.code !== 0) {
    const mode = classifyYtDlpStderr(result.stderr);
    const stderrTail = result.stderr.split('\n').slice(-5).join('\n').trim();
    const msg = `yt-dlp failed (${mode}) for ${url}: ${stderrTail || `exit ${result.code}`}`;
    throw new VideoDownloadError(msg, { transient: mode === 'rate-limited' });
  }

  const meta = parseYtDlpJson(result.stdout);
  const filePath = resolveDownloadedFile(opts.outputDir, meta?.id ?? undefined);
  if (!filePath) {
    throw new VideoDownloadError(
      `yt-dlp reported success but no output file found in ${opts.outputDir}`,
      { transient: false },
    );
  }

  let sizeBytes = 0;
  try {
    const { statSync } = await import('node:fs');
    sizeBytes = statSync(filePath).size;
  } catch {
    // best-effort — the caller can re-stat if it needs an exact size.
  }

  const out: YtDlpDownloadResult = {
    filePath,
    sizeBytes,
  };
  if (meta?.duration !== undefined) out.durationMs = Math.round(meta.duration * 1000);
  if (meta?.title !== undefined) out.title = meta.title;
  if (meta?.id !== undefined) out.videoId = meta.id;

  logger.debug('yt-dlp done', {
    filePath,
    sizeBytes,
    ...(out.durationMs !== undefined ? { durationMs: out.durationMs } : {}),
    ...(out.title !== undefined ? { title: out.title } : {}),
  });

  return out;
}
