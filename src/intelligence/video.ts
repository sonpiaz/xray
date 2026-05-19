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
  type VideoSource,
} from '../models/video-report.ts';
import { extractAudio } from '../video/audio.ts';
import {
  type CachedVision,
  evictVideoFilesLRU,
  getCachedTranscript,
  getCachedVideoFile,
  getCachedVision,
  putCachedTranscript,
  putCachedVision,
  recordVideoFile,
  videoFilePathFor,
} from '../video/cache.ts';
import { downloadVideo } from '../video/download.ts';
import { type ExtractFramesResult, type ExtractedFrame, extractFrames } from '../video/frames.ts';
import { canonicalizeVideoUrl, detectPlatform } from '../video/platforms.ts';
import {
  DEFAULT_TRANSCRIBE_MODEL,
  type TranscribeResult,
  transcribeAudio,
} from '../video/transcribe.ts';
import { type AnalyzeFramesResult, DEFAULT_VISION_MODEL, analyzeFrames } from '../video/vision.ts';

const SYNTHESIS_COST_USD = 0.02;
/** Spec §8.2 — WARN when video duration exceeds this threshold. */
const LONG_VIDEO_THRESHOLD_MS = 10 * 60 * 1000;

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
 * P2.2 layers URL-level caching on top: before any work, look up the
 * canonical URL in `video_transcripts` + `video_vision`. A double-hit
 * skips download/audio/transcribe/frames/vision and goes straight to
 * synthesis. A transcript-only hit downloads + extracts frames but
 * skips the transcribe call. Both writes happen on the success path so
 * the next run benefits even when this run was a partial miss.
 *
 * Backward compatibility: existing callers that pass an `XMedia` object
 * still work — we synthesize a `{ url, mediaHint }` from it.
 */
export type AnalyzeVideoInput = XMedia | string | { url: string; mediaHint?: XMedia };

/**
 * Test seam — mirrors `_orchestratorDeps` in `fetcher/thread.ts`. Tests
 * monkey-patch these to stub out network / disk work without touching the
 * orchestrator's control flow. Production callers should never reach in.
 */
export const _orchestratorDeps = {
  downloadVideo,
  extractAudio,
  extractFrames,
  transcribeAudio,
  analyzeFrames,
  runSynthesis,
  getCachedTranscript,
  putCachedTranscript,
  getCachedVision,
  putCachedVision,
  getCachedVideoFile,
  recordVideoFile,
  evictVideoFilesLRU,
};

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
  // Best-effort detected platform — used for cache keys + the final report.
  // Falls back to 'x-native' when an XMedia is supplied; otherwise computed
  // from the URL via `detectPlatform`. Re-confirmed from the actual
  // download result post-Stage 1.
  let detectedPlatform: VideoSource = detectPlatform(url) ?? 'x-native';
  if (mediaHint) detectedPlatform = 'x-native';

  // ─── P2.2 — URL-level cache lookup (before any work) ──────────────
  // Compute the canonical URL once; it's the key for all three video
  // cache tables. `noCache: true` skips reads (still does writes so the
  // next run benefits).
  const urlCanonical = canonicalizeVideoUrl(url, detectedPlatform);

  let cachedTranscriptHit = false;
  let cachedVisionHit = false;
  let cachedVision: CachedVision | undefined;

  if (opts.noCache) {
    logger.debug('video cache bypass', { url, urlCanonical });
  } else {
    const ct = _orchestratorDeps.getCachedTranscript(urlCanonical);
    if (ct) {
      cachedTranscriptHit = true;
      transcript = ct.transcript;
      cost.transcription = ct.estimatedCostUsd ?? 0;
      if (ct.durationSec > 0) durationMs = Math.round(ct.durationSec * 1000);
      logger.debug('video cache hit: transcript', { urlCanonical });
    }
    const cv = _orchestratorDeps.getCachedVision(urlCanonical);
    if (cv) {
      cachedVisionHit = true;
      cachedVision = cv;
      cost.vision = cv.estimatedCostUsd ?? 0;
      visualSummary = cv.visualSummary;
      framesOut = {
        count: cv.analyses.length,
        method: 'scene-detect',
        analyses: cv.analyses,
      };
      logger.debug('video cache hit: vision', { urlCanonical });
    }
    if (!cachedTranscriptHit && !cachedVisionHit) {
      logger.debug('video cache miss', { urlCanonical });
    } else if (!cachedVisionHit) {
      logger.debug('video cache miss: vision', { urlCanonical });
    } else if (!cachedTranscriptHit) {
      logger.debug('video cache miss: transcript', { urlCanonical });
    }
  }

  // The pipeline runs the stages it still needs. If both caches hit, we
  // skip everything and jump to synthesis with cached data. If only one
  // hit, we run the missing branch (download + extract is required for
  // any uncached branch since both branches read the local mp4).
  const needDownload = !(cachedTranscriptHit && cachedVisionHit);
  const needTranscribe = !cachedTranscriptHit;
  const needVision = !cachedVisionHit;

  try {
    if (needDownload) {
      // ─── Stage 1: download (X-native direct OR yt-dlp by platform) ──
      // Reuse an LRU-cached mp4 if the file exists on disk. The cache
      // refresh-hits `last_accessed_at` so the file moves to the front
      // of the LRU queue.
      const cachedFile = opts.noCache
        ? undefined
        : _orchestratorDeps.getCachedVideoFile(urlCanonical);

      if (cachedFile) {
        downloadedPath = cachedFile.filePath;
        logger.debug('video file cache hit', { urlCanonical, filePath: cachedFile.filePath });
      } else {
        const downloadOpts: Parameters<typeof downloadVideo>[0] = {
          url,
          // Pin the destination to the canonical-URL-hashed path so the
          // LRU index can find this file on the next run.
          destPath: videoFilePathFor(urlCanonical, detectedPlatform),
        };
        if (mediaHint) downloadOpts.mediaHint = mediaHint;
        const download = await _orchestratorDeps.downloadVideo(downloadOpts);
        downloadedPath = download.filePath;
        durationMs ??= download.durationMs;
        detectedPlatform = download.platform;
        // Spec §8.2: WARN on long videos. Informational only — pipeline
        // continues. Threshold is 10 minutes per the spec.
        if (durationMs !== undefined && durationMs > LONG_VIDEO_THRESHOLD_MS) {
          logger.warn('large video detected', {
            durationMs,
            durationFormatted: formatDuration(durationMs),
            url,
          });
        }
        _orchestratorDeps.recordVideoFile({
          urlCanonical,
          filePath: download.filePath,
          sizeBytes: download.sizeBytes,
          platform: download.platform,
        });
        // Enforce the 1 GB LRU budget AFTER recording so the row we just
        // inserted carries the freshest `last_accessed_at` and won't be
        // the first to evict.
        _orchestratorDeps.evictVideoFilesLRU();
      }
    }

    // ─── Stage 2 + 4 in parallel: audio extract + frame extract ────
    // Each is conditional: skip audio when transcript is cached, skip
    // frames when vision is cached. When neither needs to run we have
    // nothing to do here — synthesis follows.
    let audioResult: Awaited<ReturnType<typeof extractAudio>> | null = null;
    let framesResult: ExtractFramesResult | null = null;

    if (needDownload && downloadedPath) {
      const audioPromise: Promise<Awaited<ReturnType<typeof extractAudio>> | null> = needTranscribe
        ? _orchestratorDeps.extractAudio(downloadedPath).catch((err) => {
            errors.push(`audio: ${String(err)}`);
            partial = true;
            logger.warn('video audio stage failed', { err: String(err) });
            return null;
          })
        : Promise.resolve(null);

      const framesPromise: Promise<ExtractFramesResult | null> = needVision
        ? _orchestratorDeps
            .extractFrames(downloadedPath, {
              ...(opts.sceneThreshold !== undefined ? { threshold: opts.sceneThreshold } : {}),
              ...(opts.minFrames !== undefined ? { minFrames: opts.minFrames } : {}),
              ...(opts.maxFrames !== undefined ? { maxFrames: opts.maxFrames } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            })
            .catch<ExtractFramesResult | null>((err) => {
              errors.push(`frames: ${String(err)}`);
              partial = true;
              logger.warn('video frames stage failed', { err: String(err) });
              return null;
            })
        : Promise.resolve(null);

      [audioResult, framesResult] = await Promise.all([audioPromise, framesPromise]);
    }

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
    if (needTranscribe) {
      if (!transcript && audioPath && cfg.kyma.key) {
        try {
          const tx: TranscribeResult = await _orchestratorDeps.transcribeAudio(audioPath, {
            ...(opts.transcribeModel !== undefined ? { model: opts.transcribeModel } : {}),
            ...(opts.noCache !== undefined ? { noCache: opts.noCache } : {}),
          });
          transcript = tx.transcript;
          cost.transcription = tx.estimatedCostUsd;
          logger.debug('video cost', {
            stage: 'transcribe',
            costUsd: tx.estimatedCostUsd,
            durationSec: tx.durationSec,
            cached: tx.cached,
          });
          if (tx.transcript.empty) {
            errors.push('Transcription returned empty text (non-speech audio)');
            partial = true;
          } else {
            // Cache write — only when we have real transcript text. Empty
            // / silent results aren't worth saving (we'd just refetch).
            try {
              _orchestratorDeps.putCachedTranscript({
                urlCanonical,
                platform: detectedPlatform,
                transcript: tx.transcript,
                model: opts.transcribeModel ?? DEFAULT_TRANSCRIBE_MODEL,
                durationSec: tx.durationSec,
                ...(durationMs !== undefined ? { durationMs } : {}),
                estimatedCostUsd: tx.estimatedCostUsd,
              });
            } catch (err) {
              logger.debug('video transcript cache write failed', { err: String(err) });
            }
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
    }

    // ─── Stage 5: vision ───────────────────────────────────────────
    let visionResult: AnalyzeFramesResult | null = null;
    if (needVision) {
      if (extractedFrames.length > 0 && cfg.kyma.key) {
        try {
          visionResult = await _orchestratorDeps.analyzeFrames(extractedFrames, {
            ...(opts.visionModel !== undefined ? { model: opts.visionModel } : {}),
            ...(opts.noCache !== undefined ? { noCache: opts.noCache } : {}),
            ...(transcript ? { transcript } : {}),
          });
          cost.vision = visionResult.estimatedCostUsd;
          logger.debug('video cost', {
            stage: 'vision',
            costUsd: visionResult.estimatedCostUsd,
            frames: visionResult.analyses.length,
            cached: visionResult.cached,
          });
          if (framesOut) {
            framesOut.analyses = visionResult.analyses;
          }
          visualSummary = visionResult.visualSummary;
          if (visionResult.analyses.length > 0) {
            try {
              const payload: CachedVision = {
                analyses: visionResult.analyses,
                estimatedCostUsd: visionResult.estimatedCostUsd,
                ...(visionResult.visualSummary !== undefined
                  ? { visualSummary: visionResult.visualSummary }
                  : {}),
              };
              _orchestratorDeps.putCachedVision({
                urlCanonical,
                platform: detectedPlatform,
                vision: payload,
                frameCount: visionResult.analyses.length,
                model: opts.visionModel ?? DEFAULT_VISION_MODEL,
              });
            } catch (err) {
              logger.debug('video vision cache write failed', { err: String(err) });
            }
          }
        } catch (err) {
          errors.push(`vision: ${String(err)}`);
          partial = true;
          logger.warn('video vision stage failed', { err: String(err) });
        }
      } else if (extractedFrames.length > 0 && !cfg.kyma.key) {
        errors.push('KYMA_API_KEY not set — vision analysis skipped');
        partial = true;
      }
    } else if (cachedVision) {
      // Vision came from cache — promote to visionResult so the synthesis
      // step sees the analyses array.
      visionResult = {
        analyses: cachedVision.analyses,
        ...(cachedVision.visualSummary !== undefined
          ? { visualSummary: cachedVision.visualSummary }
          : {}),
        estimatedCostUsd: cachedVision.estimatedCostUsd ?? 0,
        cached: true,
      };
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
        synthesis = await _orchestratorDeps.runSynthesis({
          transcript,
          visionAnalyses: visionResult?.analyses ?? [],
          visualSummary,
          durationMs,
          model: opts.synthesisModel,
        });
        cost.synthesis = SYNTHESIS_COST_USD;
        logger.debug('video cost', {
          stage: 'synthesis',
          costUsd: SYNTHESIS_COST_USD,
          model: opts.synthesisModel ?? cfg.kyma.model,
        });
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
    logger.debug('video cost', { stage: 'total', costUsd: estimatedCostUsd, breakdown: cost });

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

/**
 * Pure helper — assembles the user prompt sent to the synthesis chat
 * call. Exported so unit tests can pin the prompt format down without
 * making a network round-trip. Keep this in lock-step with the JSON
 * shape `runSynthesis()` expects back.
 */
export function buildSynthesisPrompt(input: {
  transcript: Transcript;
  visionAnalyses: Array<{ timestampMs: number; description: string }>;
  visualSummary?: string;
  durationMs?: number;
}): string {
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

  return [
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
}

/**
 * Synthesis stage — combines transcript + frame descriptions into a
 * structured JSON analysis via Kyma chat. Exported so unit tests can
 * verify prompt assembly without round-tripping through `analyzeVideo`.
 */
export async function runSynthesis(input: {
  transcript: Transcript;
  visionAnalyses: Array<{ timestampMs: number; description: string }>;
  visualSummary?: string;
  durationMs?: number;
  model?: string | undefined;
}): Promise<SynthesisJson> {
  const userPrompt = buildSynthesisPrompt(input);

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
