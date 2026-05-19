import { rmSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { chat } from '../kyma/client.ts';
import type { XMedia } from '../models/media.ts';
import {
  type KeyMoment,
  type Transcript,
  type VideoCostBreakdown,
  type VideoFrames,
  type VideoReport,
  VideoReportSchema,
} from '../models/video-report.ts';
import { extractAudio } from '../video/audio.ts';
import { type VideoDownloadResult, downloadVideo } from '../video/download.ts';
import { type ExtractFramesResult, type ExtractedFrame, extractFrames } from '../video/frames.ts';
import { type TranscribeResult, transcribeAudio } from '../video/transcribe.ts';
import { type AnalyzeFramesResult, analyzeFrames } from '../video/vision.ts';

const SYNTHESIS_COST_USD = 0.02;

/**
 * Options surface mirrors the spec §3 CLI surface so P2.3 can pipe flags
 * straight through. P2.0 only honors `raw` and `noCache` — the rest are
 * reserved for later sub-phases.
 */
export type VideoAnalyzeOptions = {
  /** Skip the LLM synthesis call — return transcript + frames only. */
  raw?: boolean;
  /** Skip cache reads + writes across all sub-stages. */
  noCache?: boolean;
  /** Override transcription model (default whisper-v3-turbo). */
  transcribeModel?: string;
  /** Override vision model (default gemini-2.5-flash). */
  visionModel?: string;
  /** Override synthesis chat model (default config.kyma.model). */
  synthesisModel?: string;
  /** Frame extractor min/max clamps (defaults 4 / 12). */
  minFrames?: number;
  maxFrames?: number;
  /** Frame scene-detect threshold (default 0.3). */
  sceneThreshold?: number;
  /** Delete intermediate files (mp4, mp3, frame JPEGs) after analysis. Default true. */
  cleanup?: boolean;
};

type SynthesisJson = {
  topic?: string;
  summary?: string;
  visualContext?: string[];
  keyMoments?: Array<{
    startMs?: number;
    endMs?: number;
    description?: string;
    type?: string;
  }>;
};

/**
 * Drive the full video pipeline: download → audio + frames →
 * transcribe + vision → synthesis. Each stage's failure is captured into
 * the partial report rather than thrown — the caller always gets a
 * `VideoReport` they can render.
 *
 * P2.0 took an `XMedia`. P2.1 widens the input to also accept a raw URL
 * string (or `{ url, mediaHint }`) so the standalone `xray video <url>`
 * code path can drive the pipeline without an XMedia. Platform detection
 * + yt-dlp routing happens inside `downloadVideo()`.
 *
 * Backward compatibility: existing callers that pass an `XMedia` object
 * still work — we synthesize a `{ url, mediaHint }` from it.
 */
export type AnalyzeVideoInput = XMedia | string | { url: string; mediaHint?: XMedia };

export async function analyzeVideo(
  input: AnalyzeVideoInput,
  opts: VideoAnalyzeOptions = {},
): Promise<VideoReport> {
  const { url, mediaHint } = normalizeAnalyzeInput(input);

  const cfg = loadConfig();
  const cleanup = opts.cleanup ?? true;
  const errors: string[] = [];
  let partial = false;
  const cost: VideoCostBreakdown = {};

  // Files we create and may need to clean up at the end.
  let downloadedPath: string | undefined;
  let audioPath: string | undefined;
  let framesDir: string | undefined;

  let durationMs: number | undefined;
  let transcript: Transcript | undefined;
  let framesOut: VideoFrames | undefined;
  let extractedFrames: ExtractedFrame[] = [];
  let visualSummary: string | undefined;
  let detectedPlatform: VideoDownloadResult['platform'] = 'x-native';

  try {
    // ─── Stage 1: download (X-native direct OR yt-dlp by platform) ──
    const downloadOpts: Parameters<typeof downloadVideo>[0] = { url };
    if (mediaHint) downloadOpts.mediaHint = mediaHint;
    const download = await downloadVideo(downloadOpts);
    downloadedPath = download.filePath;
    durationMs = download.durationMs;
    detectedPlatform = download.platform;

    // ─── Stage 2 + 4 in parallel: audio extract + frame extract ────
    const audioPromise = extractAudio(download.filePath).catch((err) => {
      errors.push(`audio: ${String(err)}`);
      partial = true;
      logger.warn('video audio stage failed', { err: String(err) });
      return null;
    });
    const framesPromise = extractFrames(download.filePath, {
      ...(opts.sceneThreshold !== undefined ? { threshold: opts.sceneThreshold } : {}),
      ...(opts.minFrames !== undefined ? { minFrames: opts.minFrames } : {}),
      ...(opts.maxFrames !== undefined ? { maxFrames: opts.maxFrames } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    }).catch<ExtractFramesResult | null>((err) => {
      errors.push(`frames: ${String(err)}`);
      partial = true;
      logger.warn('video frames stage failed', { err: String(err) });
      return null;
    });

    const [audioResult, framesResult] = await Promise.all([audioPromise, framesPromise]);

    if (audioResult) {
      audioPath = audioResult.audioPath ?? undefined;
      if (audioResult.silent) {
        transcript = { text: '', segments: [], empty: true };
        errors.push('No audio track detected — transcript unavailable');
        partial = true;
      }
    }

    if (framesResult) {
      extractedFrames = framesResult.frames;
      if (extractedFrames[0]) framesDir = dirname(extractedFrames[0].path);
      framesOut = {
        count: framesResult.frames.length,
        method: framesResult.method,
        analyses: [],
        ...(framesResult.threshold !== undefined ? { threshold: framesResult.threshold } : {}),
      };
    }

    // ─── Stage 3: transcribe ───────────────────────────────────────
    if (!transcript && audioPath && cfg.kyma.key) {
      try {
        const tx: TranscribeResult = await transcribeAudio(audioPath, {
          ...(opts.transcribeModel !== undefined ? { model: opts.transcribeModel } : {}),
          ...(opts.noCache !== undefined ? { noCache: opts.noCache } : {}),
        });
        transcript = tx.transcript;
        cost.transcription = tx.estimatedCostUsd;
        if (tx.transcript.empty) {
          errors.push('Transcription returned empty text (non-speech audio)');
          partial = true;
        }
      } catch (err) {
        errors.push(`transcribe: ${String(err)}`);
        partial = true;
        logger.warn('video transcribe stage failed', { err: String(err) });
        transcript = { text: '', segments: [], empty: true };
      }
    } else if (!cfg.kyma.key) {
      errors.push('KYMA_API_KEY not set — transcription skipped');
      partial = true;
      if (!transcript) transcript = { text: '', segments: [], empty: true };
    }

    // ─── Stage 5: vision ───────────────────────────────────────────
    let visionResult: AnalyzeFramesResult | null = null;
    if (extractedFrames.length > 0 && cfg.kyma.key) {
      try {
        visionResult = await analyzeFrames(extractedFrames, {
          ...(opts.visionModel !== undefined ? { model: opts.visionModel } : {}),
          ...(opts.noCache !== undefined ? { noCache: opts.noCache } : {}),
          ...(transcript ? { transcript } : {}),
        });
        cost.vision = visionResult.estimatedCostUsd;
        if (framesOut) {
          framesOut.analyses = visionResult.analyses;
        }
        visualSummary = visionResult.visualSummary;
      } catch (err) {
        errors.push(`vision: ${String(err)}`);
        partial = true;
        logger.warn('video vision stage failed', { err: String(err) });
      }
    } else if (extractedFrames.length > 0 && !cfg.kyma.key) {
      errors.push('KYMA_API_KEY not set — vision analysis skipped');
      partial = true;
    }

    // ─── Stage 6: synthesis ────────────────────────────────────────
    let synthesis: SynthesisJson | undefined;
    if (
      !opts.raw &&
      cfg.kyma.key &&
      transcript &&
      (transcript.text.length > 0 || (visionResult && visionResult.analyses.length > 0))
    ) {
      try {
        synthesis = await runSynthesis({
          transcript,
          visionAnalyses: visionResult?.analyses ?? [],
          visualSummary,
          durationMs,
          model: opts.synthesisModel,
        });
        cost.synthesis = SYNTHESIS_COST_USD;
      } catch (err) {
        errors.push(`synthesis: ${String(err)}`);
        partial = true;
        logger.warn('video synthesis stage failed', { err: String(err) });
      }
    } else if (opts.raw) {
      logger.debug('video synthesis skipped (raw mode)');
    } else if (!cfg.kyma.key) {
      errors.push('KYMA_API_KEY not set — synthesis skipped');
      partial = true;
    }

    const estimatedCostUsd = round4(
      (cost.transcription ?? 0) + (cost.vision ?? 0) + (cost.synthesis ?? 0),
    );

    const report: VideoReport = {
      url,
      platform: detectedPlatform,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(durationMs !== undefined ? { durationFormatted: formatDuration(durationMs) } : {}),
      ...(transcript ? { transcript } : {}),
      ...(framesOut ? { frames: framesOut } : {}),
      ...(synthesis?.topic ? { topic: synthesis.topic } : {}),
      ...(synthesis?.summary ? { summary: synthesis.summary } : {}),
      ...(synthesis?.visualContext ? { visualContext: synthesis.visualContext } : {}),
      ...(synthesis?.keyMoments
        ? {
            keyMoments: synthesis.keyMoments
              .map(normalizeKeyMoment)
              .filter((k): k is KeyMoment => !!k),
          }
        : {}),
      estimatedCostUsd,
      costBreakdown: cost,
      partial,
      errors,
      generatedAt: new Date().toISOString(),
    };

    // Validate against the schema before returning so a bug here surfaces
    // at the boundary, not deep in a markdown renderer downstream.
    return VideoReportSchema.parse(report);
  } finally {
    if (cleanup) {
      cleanupArtifacts({ downloadedPath, audioPath, framesDir });
    }
  }
}

type SynthesisInput = {
  transcript: Transcript;
  visionAnalyses: ReturnType<typeof Array<unknown>>;
  visualSummary?: string;
  durationMs?: number;
  model?: string;
};

async function runSynthesis(input: {
  transcript: Transcript;
  visionAnalyses: Array<{ timestampMs: number; description: string }>;
  visualSummary?: string;
  durationMs?: number;
  model?: string | undefined;
}): Promise<SynthesisJson> {
  const transcriptBlock = input.transcript.segments.length
    ? input.transcript.segments
        .map((s) => `[${formatTime(s.startMs)}-${formatTime(s.endMs)}] ${s.text}`)
        .join('\n')
    : input.transcript.text || '(no transcript)';

  const framesBlock = input.visionAnalyses.length
    ? input.visionAnalyses
        .map((f) => `- ${formatTime(f.timestampMs)} — ${f.description}`)
        .join('\n')
    : '(no frame descriptions)';

  const userPrompt = [
    '## Transcript',
    transcriptBlock,
    '',
    '## Frame Descriptions',
    framesBlock,
    '',
    ...(input.visualSummary
      ? ['## Visual Summary (from vision model)', input.visualSummary, '']
      : []),
    `## Video Duration: ${input.durationMs ? formatDuration(input.durationMs) : 'unknown'}`,
    '',
    'Synthesize the video into structured JSON with this exact shape:',
    '{',
    '  "topic": "<one short phrase naming the subject>",',
    '  "summary": "<one paragraph synthesizing audio + visual context>",',
    '  "keyMoments": [',
    '    { "startMs": <number>, "endMs": <number>, "description": "<text>", "type": "introduction|key-point|demonstration|transition|conclusion|highlight" }',
    '  ],',
    '  "visualContext": ["<bullet 1 — what the frames revealed that the transcript did not>", "..."]',
    '}',
    'Produce 3-8 keyMoments. Use millisecond timestamps consistent with the transcript segments above.',
    'Respond with strict JSON only.',
  ].join('\n');

  const chatOpts: Parameters<typeof chat>[0] = {
    messages: [
      {
        role: 'system',
        content:
          'You are analyzing a video. Combine transcript and frame descriptions into a structured JSON analysis. Be specific. Use timestamps from the transcript.',
      },
      { role: 'user', content: userPrompt },
    ],
    jsonMode: true,
  };
  if (input.model !== undefined) chatOpts.model = input.model;

  const res = await chat(chatOpts);

  try {
    return JSON.parse(res.content) as SynthesisJson;
  } catch (err) {
    throw new Error(`synthesis JSON parse failed: ${String(err)}`);
  }
}

/**
 * Pure helper — accept either an `XMedia`, a raw URL string, or a struct
 * with `url` + optional `mediaHint`, and return a normalized
 * `{ url, mediaHint }` for the download stage. Exported for unit tests.
 */
export function normalizeAnalyzeInput(input: AnalyzeVideoInput): {
  url: string;
  mediaHint?: XMedia;
} {
  if (typeof input === 'string') {
    return { url: input };
  }
  // XMedia has `type` + `url`; the option struct has only `url`.
  if ('type' in input) {
    if (input.type !== 'video') {
      throw new Error(`analyzeVideo requires media.type === 'video', got '${input.type}'`);
    }
    return { url: input.url, mediaHint: input };
  }
  const out: { url: string; mediaHint?: XMedia } = { url: input.url };
  if (input.mediaHint) out.mediaHint = input.mediaHint;
  return out;
}

/** Pure helper — exported for unit tests. */
export function normalizeKeyMoment(raw: {
  startMs?: number;
  endMs?: number;
  description?: string;
  type?: string;
}): KeyMoment | null {
  const startMs =
    typeof raw.startMs === 'number' ? Math.max(0, Math.round(raw.startMs)) : undefined;
  const endMs = typeof raw.endMs === 'number' ? Math.max(0, Math.round(raw.endMs)) : undefined;
  const description = (raw.description ?? '').trim();
  if (startMs === undefined || endMs === undefined || !description) return null;
  const validTypes = new Set([
    'introduction',
    'key-point',
    'demonstration',
    'transition',
    'conclusion',
    'highlight',
  ]);
  const moment: KeyMoment = { startMs, endMs, description };
  if (raw.type && validTypes.has(raw.type)) {
    moment.type = raw.type as KeyMoment['type'];
  }
  return moment;
}

/** Format a duration in ms as "Hh Mm Ss" or "Mm Ss" or "Ss". Pure helper. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m${String(s).padStart(2, '0')}s`;
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** "1:23.456" style timestamp for prompts. */
function formatTime(ms: number): string {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60);
  const s = totalSec - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function cleanupArtifacts(args: {
  downloadedPath?: string;
  audioPath?: string;
  framesDir?: string;
}): void {
  for (const p of [args.downloadedPath, args.audioPath]) {
    if (!p) continue;
    try {
      unlinkSync(p);
    } catch {
      // best-effort
    }
  }
  if (args.framesDir) {
    try {
      rmSync(args.framesDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

// Silence unused type warning — kept for documentation purposes.
export type _SynthesisInput = SynthesisInput;
