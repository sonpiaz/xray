import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { VideoAudioExtractError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { runProcess } from './proc.ts';

export type AudioExtractResult = {
  /** Path to extracted mp3. Null when the source has no audio track. */
  audioPath: string | null;
  durationMs?: number;
  sizeBytes: number;
  /** True when source had no audio track (silent video). Transcript will be empty. */
  silent: boolean;
};

export type AudioExtractOptions = {
  /** Output directory for the .mp3. Defaults to same dir as input. */
  outDir?: string;
  /** Sample rate in Hz. Default 16000 (Whisper's native rate). */
  sampleRate?: number;
  /** Bitrate string (mp3). Default '64k' — ~600 KB/min, well under 25 MB cap. */
  bitrate?: string;
  /** Override ffmpeg binary. */
  ffmpegPath?: string;
};

/**
 * Extract a downsampled mono mp3 audio track from an mp4 (or any
 * ffmpeg-readable container) for transcription.
 *
 * Per spec §5.2 — 16 kHz mono mp3 keeps the file well under Kyma's 25 MB
 * multipart cap (~600 KB/min, so ~40 min fits). Silent videos return
 * `silent: true` and the orchestrator skips transcription.
 */
export async function extractAudio(
  videoPath: string,
  opts: AudioExtractOptions = {},
): Promise<AudioExtractResult> {
  const outDir = opts.outDir ?? dirname(videoPath);
  const sampleRate = opts.sampleRate ?? 16000;
  const bitrate = opts.bitrate ?? '64k';
  const ffmpegPath = opts.ffmpegPath ?? 'ffmpeg';
  const audioPath = join(outDir, replaceExt(videoPath, '.mp3'));

  // ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 -b:a 64k out.mp3 -y
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    videoPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-b:a',
    bitrate,
    '-y',
    audioPath,
  ];

  logger.debug('audio extract start', { videoPath, audioPath, sampleRate, bitrate });

  let result: Awaited<ReturnType<typeof runProcess>>;
  try {
    result = await runProcess(ffmpegPath, args);
  } catch (err) {
    throw new VideoAudioExtractError(`ffmpeg spawn failed: ${String(err)}`, { cause: err });
  }
  if (result.code !== 0) {
    // Heuristic: ffmpeg emits "Stream map ... matches no streams" or
    // "does not contain any stream" when the source has no audio.
    // Treat that as a non-fatal silent video rather than a hard error.
    if (isNoAudioStreamError(result.stderr)) {
      logger.debug('audio extract: source has no audio track', { videoPath });
      return { audioPath: null, sizeBytes: 0, silent: true };
    }
    throw new VideoAudioExtractError(
      `ffmpeg exited ${result.code}. stderr: ${truncate(result.stderr, 500)}`,
    );
  }

  // Confirm the file exists + has bytes — paranoid because ffmpeg
  // occasionally exits 0 on broken output (rare but documented).
  let sizeBytes = 0;
  try {
    sizeBytes = statSync(audioPath).size;
  } catch {
    throw new VideoAudioExtractError('Audio file missing after ffmpeg exit 0', {});
  }
  if (sizeBytes === 0) {
    throw new VideoAudioExtractError('Audio file is empty after ffmpeg extraction', {});
  }

  logger.debug('audio extract done', { audioPath, sizeBytes });

  return { audioPath, sizeBytes, silent: false };
}

/**
 * Exported for unit tests — pure heuristic with no I/O. ffmpeg's stderr
 * varies across versions, so we check for several common phrases.
 */
export function isNoAudioStreamError(stderr: string): boolean {
  const s = stderr.toLowerCase();
  return (
    s.includes('does not contain any stream') ||
    s.includes('stream map') ||
    s.includes('output file does not contain any stream') ||
    s.includes('no audio')
  );
}

export function replaceExt(filePath: string, newExt: string): string {
  const idx = filePath.lastIndexOf('/');
  const base = idx === -1 ? filePath : filePath.slice(idx + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot === -1 ? base : base.slice(0, dot);
  return `${stem}${newExt}`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}...` : s;
}
