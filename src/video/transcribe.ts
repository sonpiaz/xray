import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { FormData as UndiciFormData, request } from 'undici';
import { getCachedKyma, hashPrompt, putCachedKyma } from '../cache/kyma.ts';
import { loadConfig } from '../core/config.ts';
import { KymaError, VideoTranscribeError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { Transcript, TranscriptSegment } from '../models/video-report.ts';

/**
 * Kyma audio transcription endpoint (OpenAI Whisper API compatible). The
 * gateway routes `whisper-v3-turbo` to Groq Whisper Large v3 Turbo
 * (~$0.001/min effective, with 1.35x markup baked in). See
 * /Users/sonpiaz/kyma-api/src/routes/multimodal.ts handler around line 569.
 *
 * verbose_json gives us segment-level timestamps which we surface as
 * TranscriptSegment[]. The Kyma gateway hard-codes verbose_json upstream
 * regardless of what we ask for, so we always get timestamps even though
 * we ask explicitly here too (defensive).
 */
export const DEFAULT_TRANSCRIBE_MODEL = 'whisper-v3-turbo';

/** Approx pricing for cost surfacing (per spec §8.3). */
const COST_PER_MINUTE_USD = 0.001;

export type TranscribeOptions = {
  /** Defaults to whisper-v3-turbo (Groq Whisper-large-v3-turbo). */
  model?: string;
  /** Override Kyma URL base. Defaults to config. */
  kymaUrl?: string;
  /** Override Kyma key. Defaults to config. */
  kymaKey?: string;
  /** Skip cache lookup + write. */
  noCache?: boolean;
  /** Optional language hint (ISO 639-1) — speeds up Whisper if known. */
  language?: string;
};

export type TranscribeResult = {
  transcript: Transcript;
  /** USD cost estimate based on audio duration. */
  estimatedCostUsd: number;
  /** True when result came from cache. */
  cached: boolean;
  /** Provider-reported audio duration in seconds. */
  durationSec: number;
};

/** Minimal subset of the Whisper verbose_json response we depend on. */
type WhisperVerboseJson = {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
  }>;
};

/**
 * Transcribe an audio file via Kyma's OpenAI-compatible
 * /v1/audio/transcriptions endpoint.
 *
 * Caches the verbose_json response by sha256(audioFile + model) using the
 * same kyma_responses table thread analysis uses. P2.2 will split this
 * into a dedicated video_transcripts table for clearer cache UX, but
 * P2.0 reuses what's there to avoid a migration in the walking skeleton.
 */
export async function transcribeAudio(
  audioPath: string,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const cfg = loadConfig();
  const model = opts.model ?? DEFAULT_TRANSCRIBE_MODEL;
  const kymaUrl = opts.kymaUrl ?? cfg.kyma.url;
  const kymaKey = opts.kymaKey ?? cfg.kyma.key;

  if (!kymaKey) {
    throw new KymaError('KYMA_API_KEY is not set. See .env.example.');
  }

  const buf = readFileSync(audioPath);
  const cacheKey = buildTranscribeCacheKey(buf, model);

  if (!opts.noCache) {
    const cached = getCachedKyma(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as WhisperVerboseJson;
        const transcript = parseWhisperResponse(parsed);
        const durationSec = parsed.duration ?? 0;
        logger.debug('transcribe cache hit', { cacheKey, model, durationSec });
        return {
          transcript,
          estimatedCostUsd: estimateTranscribeCostUsd(durationSec),
          cached: true,
          durationSec,
        };
      } catch (err) {
        // Stale / corrupted cache row — fall through to live call.
        logger.debug('transcribe cache parse failed, refetching', { err: String(err) });
      }
    }
  }

  const url = `${kymaUrl.replace(/\/$/, '')}/audio/transcriptions`;
  logger.debug('transcribe request', { url, model, audioPath, sizeBytes: buf.length });

  const form = new UndiciFormData();
  // undici's FormData accepts Blob in append. Filename matters because
  // Kyma's MIME guard checks the extension.
  form.append('file', new Blob([new Uint8Array(buf)]), basename(audioPath) || 'audio.mp3');
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  if (opts.language) form.append('language', opts.language);

  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${kymaKey}` },
      body: form,
      bodyTimeout: 300_000, // long videos can take a while
      headersTimeout: 30_000,
    });
  } catch (err) {
    throw new VideoTranscribeError('Kyma transcribe request failed (network).', {
      transient: true,
      cause: err,
    });
  }

  const text = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new VideoTranscribeError(
      `Kyma /audio/transcriptions returned ${res.statusCode}: ${text.slice(0, 500)}`,
      { transient: res.statusCode >= 500 || res.statusCode === 429 },
    );
  }

  let parsed: WhisperVerboseJson;
  try {
    parsed = JSON.parse(text) as WhisperVerboseJson;
  } catch (err) {
    throw new VideoTranscribeError('Kyma returned invalid JSON.', { cause: err });
  }

  if (!opts.noCache) {
    putCachedKyma({
      cacheKey,
      model,
      promptHash: hashPrompt(`transcribe:${cacheKey}`),
      response: JSON.stringify(parsed),
    });
  }

  const transcript = parseWhisperResponse(parsed);
  const durationSec = parsed.duration ?? 0;
  return {
    transcript,
    estimatedCostUsd: estimateTranscribeCostUsd(durationSec),
    cached: false,
    durationSec,
  };
}

/**
 * Build a cache key from the audio file contents + model. Exported for tests.
 */
export function buildTranscribeCacheKey(audioBytes: Uint8Array | Buffer, model: string): string {
  const hash = createHash('sha256').update(audioBytes).digest('hex');
  return `video:transcribe:${model}:${hash}`;
}

/**
 * Map Kyma's Whisper verbose_json into our TranscriptSegment[] shape.
 * Exported so unit tests can pass fixture JSON without touching the network.
 */
export function parseWhisperResponse(raw: WhisperVerboseJson): Transcript {
  const text = (raw.text ?? '').trim();
  const segments: TranscriptSegment[] = [];
  for (const seg of raw.segments ?? []) {
    const start = typeof seg.start === 'number' ? seg.start : undefined;
    const end = typeof seg.end === 'number' ? seg.end : undefined;
    const segText = typeof seg.text === 'string' ? seg.text.trim() : '';
    if (start === undefined || end === undefined || !segText) continue;
    segments.push({
      startMs: Math.max(0, Math.round(start * 1000)),
      endMs: Math.max(0, Math.round(end * 1000)),
      text: segText,
    });
  }
  const transcript: Transcript = {
    text,
    segments,
    empty: text.length === 0,
  };
  if (raw.language) transcript.language = raw.language;
  return transcript;
}

/**
 * Convert duration seconds → USD using the per-minute rate from spec §8.3.
 * Exported for unit tests + the orchestrator's cost roll-up.
 */
export function estimateTranscribeCostUsd(durationSec: number): number {
  if (durationSec <= 0) return 0;
  const minutes = durationSec / 60;
  return round4(minutes * COST_PER_MINUTE_USD);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
