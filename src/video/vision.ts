import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { request } from 'undici';
import { getCachedKyma, hashPrompt, putCachedKyma } from '../cache/kyma.ts';
import { loadConfig } from '../core/config.ts';
import { KymaError, VideoVisionError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { FrameAnalysis, Transcript } from '../models/video-report.ts';
import type { ExtractedFrame } from './frames.ts';

/**
 * Kyma multimodal vision via /v1/chat/completions. We send all extracted
 * frames as data-URL image_url parts in a single user message. Gemini-2.5
 * -flash is the cheapest vision-capable Kyma model that handles 4-12
 * images in one call without hitting context limits.
 */
export const DEFAULT_VISION_MODEL = 'gemini-2.5-flash';

/**
 * ~$0.005 per frame from spec §5.5 (gemini-2.5-flash via Kyma).
 */
const COST_PER_FRAME_USD = 0.005;

export type AnalyzeFramesOptions = {
  model?: string;
  kymaUrl?: string;
  kymaKey?: string;
  noCache?: boolean;
  /** Transcript text used as context — Gemini reads what the speaker said
   *  to ground frame descriptions. Optional; vision still runs without it. */
  transcript?: Transcript | string;
};

export type AnalyzeFramesResult = {
  /** Per-frame descriptions in input order. May be empty on partial failure. */
  analyses: FrameAnalysis[];
  /** Cross-frame visual summary — used by the synthesis step. */
  visualSummary?: string;
  estimatedCostUsd: number;
  cached: boolean;
};

type ChatChoiceMessage = { content?: string };
type ChatCompletionResponse = {
  choices?: Array<{ message?: ChatChoiceMessage }>;
};

type VisionJsonPayload = {
  frames?: Array<{ timestampMs?: number; description?: string }>;
  visualSummary?: string;
};

const SYSTEM_PROMPT = [
  'You are a frame-by-frame video describer.',
  'You will receive N images extracted from a video, with timestamps in milliseconds.',
  'For each image, output one concise description (1-2 sentences) focused on what is happening visually: people, text on screen, UI elements, diagrams, code, products, environment.',
  'Use the audio transcript provided as context but do not repeat the transcript — describe what the image *shows* that the audio does not.',
  'Respond with strict JSON in this shape:',
  '{ "frames": [{"timestampMs": <number>, "description": "<text>"}, ...], "visualSummary": "<one-paragraph overall visual summary>" }',
  'Do not include any text outside the JSON.',
].join('\n');

/**
 * Run a single batched multimodal request against Kyma's chat completions
 * endpoint. On any failure the orchestrator catches `VideoVisionError` and
 * proceeds with transcript-only synthesis (see §10).
 */
export async function analyzeFrames(
  frames: ExtractedFrame[],
  opts: AnalyzeFramesOptions = {},
): Promise<AnalyzeFramesResult> {
  if (frames.length === 0) {
    return { analyses: [], estimatedCostUsd: 0, cached: false };
  }

  const cfg = loadConfig();
  const model = opts.model ?? DEFAULT_VISION_MODEL;
  const kymaUrl = opts.kymaUrl ?? cfg.kyma.url;
  const kymaKey = opts.kymaKey ?? cfg.kyma.key;

  if (!kymaKey) {
    throw new KymaError('KYMA_API_KEY is not set. See .env.example.');
  }

  // Load + encode all frames. We hash the combined bytes for the cache key
  // so the same frame set on a re-run hits the cache.
  const encoded = frames.map((f) => ({
    timestampMs: f.timestampMs,
    base64: encodeFileAsBase64Jpeg(f.path),
  }));

  const cacheKey = buildVisionCacheKey(encoded, model);
  if (!opts.noCache) {
    const cached = getCachedKyma(cacheKey);
    if (cached) {
      try {
        const parsed = parseVisionResponse(cached, frames);
        logger.debug('vision cache hit', { cacheKey, model, frames: frames.length });
        return {
          analyses: parsed.analyses,
          ...(parsed.visualSummary !== undefined ? { visualSummary: parsed.visualSummary } : {}),
          estimatedCostUsd: estimateVisionCostUsd(frames.length),
          cached: true,
        };
      } catch (err) {
        logger.debug('vision cache parse failed, refetching', { err: String(err) });
      }
    }
  }

  const transcriptText =
    typeof opts.transcript === 'string' ? opts.transcript : (opts.transcript?.text ?? '');

  const userParts: Array<Record<string, unknown>> = [
    {
      type: 'text',
      text: [
        'Describe the following frames. Audio transcript follows (may be empty for silent videos).',
        '',
        'Transcript:',
        transcriptText || '(no transcript)',
        '',
        'Frames:',
        ...encoded.map((f, i) => `Frame ${i + 1} — timestamp ${f.timestampMs} ms`),
      ].join('\n'),
    },
    ...encoded.map((f) => ({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${f.base64}` },
    })),
  ];

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userParts },
    ],
    response_format: { type: 'json_object' },
  };

  const url = `${kymaUrl.replace(/\/$/, '')}/chat/completions`;
  logger.debug('vision request', { url, model, frames: frames.length });

  let res: Awaited<ReturnType<typeof request>>;
  try {
    res = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${kymaKey}`,
      },
      body: JSON.stringify(body),
      bodyTimeout: 300_000,
      headersTimeout: 30_000,
    });
  } catch (err) {
    throw new VideoVisionError('Kyma vision request failed (network).', {
      transient: true,
      cause: err,
    });
  }

  const raw = await res.body.text();
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new VideoVisionError(
      `Kyma /chat/completions returned ${res.statusCode}: ${raw.slice(0, 500)}`,
      { transient: res.statusCode >= 500 || res.statusCode === 429 },
    );
  }

  let parsedChat: ChatCompletionResponse;
  try {
    parsedChat = JSON.parse(raw) as ChatCompletionResponse;
  } catch (err) {
    throw new VideoVisionError('Kyma vision returned invalid JSON envelope.', { cause: err });
  }

  const content = parsedChat.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new VideoVisionError('Kyma vision returned empty content.');
  }

  if (!opts.noCache) {
    putCachedKyma({
      cacheKey,
      model,
      promptHash: hashPrompt(`vision:${cacheKey}`),
      response: content,
    });
  }

  const parsed = parseVisionResponse(content, frames);
  return {
    analyses: parsed.analyses,
    ...(parsed.visualSummary !== undefined ? { visualSummary: parsed.visualSummary } : {}),
    estimatedCostUsd: estimateVisionCostUsd(frames.length),
    cached: false,
  };
}

/**
 * Decode the model's JSON content into FrameAnalysis[] aligned to the
 * original frame order. We trust the model's `frames[].timestampMs` only
 * when it matches one of the timestamps we asked about — otherwise we
 * fall back to positional alignment.
 *
 * Exported so unit tests can pass fixture JSON without network.
 */
export function parseVisionResponse(
  content: string,
  frames: ExtractedFrame[],
): { analyses: FrameAnalysis[]; visualSummary?: string } {
  let json: VisionJsonPayload;
  try {
    json = JSON.parse(content) as VisionJsonPayload;
  } catch (err) {
    throw new VideoVisionError('Vision JSON payload not parseable.', { cause: err });
  }

  const wantTimestamps = new Set(frames.map((f) => f.timestampMs));
  const byTimestamp = new Map<number, string>();
  const positional: string[] = [];
  for (const f of json.frames ?? []) {
    const desc = (f.description ?? '').trim();
    if (!desc) continue;
    if (typeof f.timestampMs === 'number' && wantTimestamps.has(f.timestampMs)) {
      byTimestamp.set(f.timestampMs, desc);
    } else {
      positional.push(desc);
    }
  }

  const analyses: FrameAnalysis[] = [];
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame) continue;
    const byTs = byTimestamp.get(frame.timestampMs);
    const desc = byTs ?? positional[i];
    if (!desc) continue;
    const a: FrameAnalysis = {
      timestampMs: frame.timestampMs,
      description: desc,
    };
    if (frame.sceneScore !== undefined) a.sceneScore = frame.sceneScore;
    analyses.push(a);
  }

  const out: { analyses: FrameAnalysis[]; visualSummary?: string } = { analyses };
  if (typeof json.visualSummary === 'string' && json.visualSummary.trim()) {
    out.visualSummary = json.visualSummary.trim();
  }
  return out;
}

/**
 * Cost roll-up per spec §8.3. Exported so the orchestrator can compose
 * the report's `costBreakdown`.
 */
export function estimateVisionCostUsd(frameCount: number): number {
  if (frameCount <= 0) return 0;
  return round4(frameCount * COST_PER_FRAME_USD);
}

/**
 * Cache key keyed by joined SHA256 of each frame's bytes. Exported for tests.
 */
export function buildVisionCacheKey(
  frames: Array<{ base64: string; timestampMs: number }>,
  model: string,
): string {
  const h = createHash('sha256');
  for (const f of frames) {
    h.update(`${f.timestampMs}:`);
    h.update(f.base64);
    h.update('|');
  }
  return `video:vision:${model}:${h.digest('hex')}`;
}

function encodeFileAsBase64Jpeg(path: string): string {
  try {
    const s = statSync(path);
    if (s.size === 0) {
      throw new VideoVisionError(`Frame file is empty: ${path}`);
    }
  } catch (err) {
    if (err instanceof VideoVisionError) throw err;
    throw new VideoVisionError(`Cannot read frame: ${path}`, { cause: err });
  }
  return readFileSync(path).toString('base64');
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
