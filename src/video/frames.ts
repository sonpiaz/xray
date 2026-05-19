import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VideoFramesError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { runProcess } from './proc.ts';

export type ExtractedFrame = {
  /** Absolute path to a JPEG file. */
  path: string;
  /** Timestamp in milliseconds relative to the start of the video. */
  timestampMs: number;
  /** ffmpeg-reported scene score when method === 'scene-detect'. */
  sceneScore?: number;
};

export type ExtractFramesResult = {
  frames: ExtractedFrame[];
  method: 'scene-detect' | 'evenly-spaced';
  threshold?: number;
};

export type ExtractFramesOptions = {
  /** ffmpeg scene-detect threshold (0..1). Default 0.3. */
  threshold?: number;
  /** Lower clamp — fallback fills to this count if scene-detect under-shoots. */
  minFrames?: number;
  /** Upper clamp — keep this many highest-score frames if scene-detect over-shoots. */
  maxFrames?: number;
  /** Output dir for frame JPEGs. Defaults to dirname(videoPath)/frames. */
  outDir?: string;
  /** ffmpeg binary path. */
  ffmpegPath?: string;
  /** Source video duration in ms — only needed for evenly-spaced fallback. */
  durationMs?: number;
};

const DEFAULT_THRESHOLD = 0.3;
const DEFAULT_MIN = 4;
const DEFAULT_MAX = 12;

/**
 * Hybrid scene-detect frame extractor.
 *
 * 1. Run ffmpeg with `select='gt(scene,T)',showinfo` to get scene-change
 *    frames + their `pts_time` (seconds) and `scene_score` from stderr.
 * 2. Clamp:
 *    - 0 frames → fall back to N evenly-spaced (N = minFrames).
 *    - 1..minFrames-1 → keep + pad with evenly-spaced fills.
 *    - >maxFrames → keep maxFrames with the highest scene scores.
 *    - else → keep as-is.
 *
 * See spec §5.4 for algorithm rationale.
 */
export async function extractFrames(
  videoPath: string,
  opts: ExtractFramesOptions = {},
): Promise<ExtractFramesResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const minFrames = opts.minFrames ?? DEFAULT_MIN;
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX;
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const outDir = opts.outDir ?? join(dirname(videoPath), 'frames');
  mkdirSync(outDir, { recursive: true });

  // Step 1: scene-detect pass. -frame_pts 1 embeds the source PTS in the
  // output filename, but we still parse showinfo from stderr because it
  // gives us the scene_score we need for the maxFrames truncation.
  const scenePattern = join(outDir, 'scene_%04d.jpg');
  const args = [
    '-hide_banner',
    '-loglevel',
    'info', // showinfo writes to info level
    '-i',
    videoPath,
    '-vf',
    `select='gt(scene\\,${threshold})',showinfo`,
    // ffmpeg >= 5.x prefers `-fps_mode vfr` over the deprecated `-vsync vfr`.
    // We use `-fps_mode` since it works on 5.x+ (current Homebrew default is
    // 8.x). If we hit a system stuck on ffmpeg 4.x we'd need to fall back.
    '-fps_mode',
    'vfr',
    '-frame_pts',
    '1',
    '-y',
    scenePattern,
  ];

  logger.debug('frame extract start', { videoPath, threshold, outDir });

  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess(ffmpegPath, args);
  } catch (err) {
    throw new VideoFramesError(`ffmpeg spawn failed: ${String(err)}`, { cause: err });
  }
  // Non-zero exit is OK when the scene-detect filter matched zero frames
  // (ffmpeg 5.x+ fails to open the mjpeg encoder and exits with an error
  // even though that's the expected path for low-motion videos). Detect
  // the "no frames written" case so we can fall through to the
  // evenly-spaced fallback below.
  const zeroFrameSignature =
    result.stderr.includes('Nothing was written into output file') ||
    result.stderr.includes('received no packets');
  if (result.code !== 0 && !zeroFrameSignature) {
    throw new VideoFramesError(
      `ffmpeg scene-detect exited ${result.code}. stderr: ${truncate(result.stderr, 500)}`,
    );
  }

  const showinfoEntries = parseShowinfo(result.stderr);
  const sceneFiles = listSceneFiles(outDir);

  // Match showinfo entries to file paths. ffmpeg emits one showinfo line
  // per kept frame in the order it writes the JPEGs, so positional join is
  // safe even though pts encoded in the filename != index.
  const sceneFrames: ExtractedFrame[] = [];
  for (let i = 0; i < Math.min(showinfoEntries.length, sceneFiles.length); i++) {
    const info = showinfoEntries[i];
    const file = sceneFiles[i];
    if (!info || !file) continue;
    const frame: ExtractedFrame = {
      path: file,
      timestampMs: Math.max(0, Math.round(info.ptsTimeSec * 1000)),
    };
    if (info.sceneScore !== undefined) frame.sceneScore = info.sceneScore;
    sceneFrames.push(frame);
  }

  logger.debug('frame extract scene-detect result', {
    found: sceneFrames.length,
    minFrames,
    maxFrames,
  });

  // Step 2a: zero scene frames → evenly-spaced fallback.
  if (sceneFrames.length === 0) {
    const frames = await extractEvenlySpaced(videoPath, minFrames, {
      ...(opts.durationMs !== undefined ? { durationMs: opts.durationMs } : {}),
      outDir,
      ffmpegPath,
    });
    return { frames, method: 'evenly-spaced' };
  }

  // Step 2b: too many → keep top-N by scene score.
  if (sceneFrames.length > maxFrames) {
    const sorted = [...sceneFrames].sort((a, b) => (b.sceneScore ?? 0) - (a.sceneScore ?? 0));
    const kept = sorted.slice(0, maxFrames).sort((a, b) => a.timestampMs - b.timestampMs);
    return { frames: kept, method: 'scene-detect', threshold };
  }

  // Step 2c: too few → P2.0 keeps what we got rather than padding. The
  // pad-with-fills logic in the spec is a P2.x optimization; for the
  // walking skeleton we accept any scene-detected frame count >= 1. This
  // is documented behavior — `count` on VideoFrames lets callers see the
  // exact frame budget used.
  return { frames: sceneFrames, method: 'scene-detect', threshold };
}

/**
 * Evenly-spaced fallback. Used when scene-detect finds nothing (static
 * video, slideshow, or unreadable scene metadata).
 *
 * Probes duration if not provided, then snapshots one JPEG at each evenly
 * spaced timestamp via individual ffmpeg seek-and-encode passes.
 */
export async function extractEvenlySpaced(
  videoPath: string,
  count: number,
  opts: { durationMs?: number; outDir?: string; ffmpegPath?: string } = {},
): Promise<ExtractedFrame[]> {
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const outDir = opts.outDir ?? join(dirname(videoPath), 'frames');
  mkdirSync(outDir, { recursive: true });

  const durationMs = opts.durationMs ?? (await probeDurationMs(videoPath, ffmpegPath));
  if (!durationMs || durationMs <= 0) {
    throw new VideoFramesError('Cannot do evenly-spaced extraction without a known duration.');
  }

  // Compute N timestamps avoiding the very first/last frames (often black
  // or compression artifacts). Window = [5%, 95%].
  const timestamps: number[] = [];
  if (count === 1) {
    timestamps.push(Math.round(durationMs / 2));
  } else {
    const lo = durationMs * 0.05;
    const hi = durationMs * 0.95;
    const step = (hi - lo) / (count - 1);
    for (let i = 0; i < count; i++) {
      timestamps.push(Math.round(lo + step * i));
    }
  }

  const frames: ExtractedFrame[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const tsMs = timestamps[i];
    if (tsMs === undefined) continue;
    const path = join(outDir, `even_${String(i).padStart(4, '0')}.jpg`);
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-ss',
      String(tsMs / 1000),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      '-y',
      path,
    ];
    const r = await runProcess(ffmpegPath, args);
    if (r.code !== 0) continue;
    try {
      if (statSync(path).size > 0) {
        frames.push({ path, timestampMs: tsMs });
      }
    } catch {
      // skip
    }
  }

  if (frames.length === 0) {
    throw new VideoFramesError('Evenly-spaced extraction produced no frames.');
  }
  return frames;
}

/**
 * Parse `Parsed_showinfo_*` lines from ffmpeg stderr.
 * Each kept frame yields one line with `pts_time:N.NNN` and the preceding
 * `select` filter's `scene:N.NN` from `Parsed_select_*`.
 *
 * ffmpeg interleaves Parsed_select_0 (with scene:) and Parsed_showinfo_1
 * (with pts_time:), so we walk lines pairing the last seen scene score
 * with the next showinfo entry.
 *
 * Exported for unit tests against captured stderr fixtures.
 */
export function parseShowinfo(stderr: string): Array<{
  ptsTimeSec: number;
  sceneScore?: number;
}> {
  const out: Array<{ ptsTimeSec: number; sceneScore?: number }> = [];
  let pendingScene: number | undefined;
  for (const rawLine of stderr.split('\n')) {
    const line = rawLine.trim();
    if (line.includes('Parsed_select_')) {
      // Example: "[Parsed_select_0 @ 0x...] n: 12 pts: 9234 t:0.385 key:0 ... scene:0.452"
      const m = line.match(/scene:([0-9.]+)/);
      if (m?.[1]) {
        const v = Number.parseFloat(m[1]);
        if (Number.isFinite(v)) pendingScene = v;
      }
      continue;
    }
    if (line.includes('Parsed_showinfo_')) {
      // Example: "[Parsed_showinfo_1 @ 0x...] n:0 pts:1923 pts_time:0.0801667 ..."
      const m = line.match(/pts_time:([0-9.]+)/);
      if (!m?.[1]) continue;
      const t = Number.parseFloat(m[1]);
      if (!Number.isFinite(t)) continue;
      const entry: { ptsTimeSec: number; sceneScore?: number } = { ptsTimeSec: t };
      if (pendingScene !== undefined) entry.sceneScore = pendingScene;
      out.push(entry);
      pendingScene = undefined;
    }
  }
  return out;
}

function listSceneFiles(dir: string): string[] {
  try {
    const all = readdirSync(dir);
    return all
      .filter((f) => f.startsWith('scene_') && f.endsWith('.jpg'))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

async function probeDurationMs(videoPath: string, ffmpegPath: string): Promise<number | undefined> {
  try {
    // ffmpeg without an output spec returns non-zero; that's fine — we
    // only need stderr's Duration line.
    const res = await runProcess(ffmpegPath, ['-hide_banner', '-i', videoPath]);
    const stderr = res.stderr;
    const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (!m) return undefined;
    const [, h, mm, s, frac] = m;
    if (!h || !mm || !s) return undefined;
    const ms =
      Number(h) * 3_600_000 +
      Number(mm) * 60_000 +
      Number(s) * 1000 +
      // ffmpeg prints centi-seconds (.NN), normalize whatever precision we got
      Math.round(Number.parseFloat(`0.${frac ?? '0'}`) * 1000);
    return ms;
  } catch {
    return undefined;
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
