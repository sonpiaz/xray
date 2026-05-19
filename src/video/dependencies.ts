import { DependencyError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { runProcess } from './proc.ts';

export type DependencyAvailable = { available: true; path: string; version?: string };
export type DependencyMissing = { available: false };
export type DependencyState = DependencyAvailable | DependencyMissing;

export type DependencyCheck = {
  ffmpeg: DependencyState;
  ffprobe: DependencyState;
  /** Only checked when `needYtDlp` was set; otherwise omitted. */
  ytdlp?: DependencyState;
};

/**
 * Best-effort lookup of a binary on PATH. We avoid `which`'s shell magic so
 * the check works under Bun without spawning an extra subprocess every time.
 * Returns absolute path string or undefined.
 */
export async function whichBinary(name: string): Promise<string | undefined> {
  try {
    const res = await runProcess('/usr/bin/env', ['which', name]);
    if (res.code !== 0) return undefined;
    const out = res.stdout.trim();
    if (!out) return undefined;
    return out.split('\n')[0]?.trim() || undefined;
  } catch (err) {
    logger.debug('whichBinary failed', { name, err: String(err) });
    return undefined;
  }
}

/**
 * Read `<bin> -version` and parse the first line as a coarse version string.
 * Used for debug-level logging only — XRay does not enforce minimum versions
 * (ffmpeg and yt-dlp are generally backward-compatible enough for our use).
 */
async function probeVersion(path: string): Promise<string | undefined> {
  try {
    const res = await runProcess(path, ['-version']);
    const first = res.stdout.split('\n')[0]?.trim();
    return first || undefined;
  } catch {
    return undefined;
  }
}

export async function checkDependencies(
  opts: { needYtDlp?: boolean } = {},
): Promise<DependencyCheck> {
  const [ffmpegPath, ffprobePath, ytdlpPath] = await Promise.all([
    whichBinary('ffmpeg'),
    whichBinary('ffprobe'),
    opts.needYtDlp ? whichBinary('yt-dlp') : Promise.resolve(undefined),
  ]);

  const ffmpeg: DependencyState = ffmpegPath
    ? { available: true, path: ffmpegPath, ...(await maybeVersion(ffmpegPath)) }
    : { available: false };
  const ffprobe: DependencyState = ffprobePath
    ? { available: true, path: ffprobePath, ...(await maybeVersion(ffprobePath)) }
    : { available: false };

  const check: DependencyCheck = { ffmpeg, ffprobe };
  if (opts.needYtDlp) {
    check.ytdlp = ytdlpPath
      ? { available: true, path: ytdlpPath, ...(await maybeVersion(ytdlpPath)) }
      : { available: false };
  }

  logger.debug('video deps', {
    ffmpeg: ffmpeg.available,
    ffprobe: ffprobe.available,
    ...(check.ytdlp ? { ytdlp: check.ytdlp.available } : {}),
  });

  return check;
}

async function maybeVersion(path: string): Promise<{ version?: string }> {
  const v = await probeVersion(path);
  return v ? { version: v } : {};
}

/**
 * P2.0 needs ffmpeg + ffprobe. ffprobe ships with ffmpeg in Homebrew /
 * apt packages so a missing ffprobe usually means a broken install rather
 * than a separate dependency — surface the same install hint.
 */
export function assertFfmpeg(check: DependencyCheck): void {
  if (!check.ffmpeg.available) {
    throw new DependencyError(
      'ffmpeg is not installed. Install: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux).',
    );
  }
  if (!check.ffprobe.available) {
    throw new DependencyError(
      'ffprobe is not available (usually shipped with ffmpeg). Reinstall ffmpeg.',
    );
  }
}

/**
 * P2.1 — Multi-line install hint for missing yt-dlp. Kept as a constant so
 * test assertions can match exact substrings.
 */
export const YT_DLP_INSTALL_HINT = [
  'yt-dlp is required for external video platforms (YouTube, TikTok, Vimeo, LinkedIn).',
  'Install:',
  '  macOS:    brew install yt-dlp',
  '  pipx:     pipx install yt-dlp',
  '  download: https://github.com/yt-dlp/yt-dlp#installation',
].join('\n');

/**
 * Throw a `DependencyError` with the canonical install hint if yt-dlp is
 * not present. Used by the platform router before invoking the yt-dlp
 * subprocess so we fail fast with an actionable message.
 */
export function assertYtDlp(check: DependencyCheck): void {
  if (!check.ytdlp || !check.ytdlp.available) {
    throw new DependencyError(YT_DLP_INSTALL_HINT);
  }
}

/**
 * Convenience wrapper around `checkDependencies({ needYtDlp: true })`
 * that returns just the yt-dlp state. Used by callers that only care
 * about yt-dlp presence (e.g. `xray video <url>` for an external URL).
 *
 * Returns `{ available: false }` when yt-dlp is not on PATH or its
 * `--version` invocation fails (ENOENT or non-zero exit).
 */
export async function checkYtDlp(): Promise<DependencyState> {
  const ytdlpPath = await whichBinary('yt-dlp');
  if (!ytdlpPath) return { available: false };
  return { available: true, path: ytdlpPath, ...(await maybeVersion(ytdlpPath)) };
}
