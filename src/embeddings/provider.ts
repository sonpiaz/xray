/**
 * P4.0 — Local MiniLM-L6-v2 embedding provider.
 *
 * Wraps `@xenova/transformers` feature-extraction pipeline as a lazy
 * singleton. First call triggers the ONNX/WASM model download (~23MB
 * quantized variant); subsequent calls hit the @xenova on-disk cache
 * and load in ~600ms. Each `embed()` call runs locally on CPU — $0
 * cost, ~5-15ms per short text on Apple Silicon.
 *
 * The 384-dim normalized output is suitable for direct cosine
 * similarity (no further L2 normalization needed). We store the
 * `EMBEDDING_MODEL_VERSION` on every meta row so a future model
 * upgrade can detect drift and trigger a re-embed.
 *
 * Cache location: @xenova writes to `node_modules/@xenova/transformers/
 * .cache/<repo>/<file>` by default. The XRAY_MODEL_DIR env var
 * overrides via `env.cacheDir` on the transformers module (see
 * https://huggingface.co/docs/transformers.js/api/env). We respect it
 * if set so installs into a packaged dist still work.
 */
import { logger } from '../core/logger.ts';

// `@xenova/transformers` is a heavy ESM-first module — lazy-import it
// the first time `getEmbedder()` runs so test files that never touch
// real embeddings (everything in P4.0 uses the test seam below) don't
// pay the ~250ms cold-import cost.
//
// The `pipeline()` return type is a giant union covering every task —
// for feature-extraction we get back a callable that returns a Tensor
// with a `.data` Float32Array. The transformers types model that as
// `FeatureExtractionPipeline` but it's not directly exported, so we
// describe the shape we actually use with a narrow callable type.
type ExtractorResult = { data: Float32Array };
type Extractor = (
  text: string,
  options: { pooling: 'mean' | 'cls' | 'none'; normalize: boolean },
) => Promise<ExtractorResult>;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
export const EMBEDDING_DIMS = 384;
export const EMBEDDING_MODEL = MODEL_NAME;
export const EMBEDDING_MODEL_VERSION = 'minilm-l6-v2-onnx-quantized';

let pipelineSingleton: Extractor | undefined;
let pipelinePromise: Promise<Extractor> | undefined;

async function loadPipeline(): Promise<Extractor> {
  const mod = await import('@xenova/transformers');
  const modelDir = process.env.XRAY_MODEL_DIR?.trim();
  if (modelDir) {
    // Re-point @xenova's on-disk cache so first-run downloads land in
    // the user-chosen dir instead of node_modules.
    mod.env.cacheDir = modelDir;
  }

  logger.debug('embedding model bootstrap starting', {
    model: MODEL_NAME,
    cacheDir: mod.env.cacheDir,
  });

  let lastProgress = -1;
  const extractor = (await mod.pipeline('feature-extraction', MODEL_NAME, {
    progress_callback: (data: unknown) => {
      // Surface download progress to stderr at info level — only when the
      // model is actually being downloaded for the first time. Throttle
      // to whole-percent jumps so we don't spam the log on every chunk.
      if (typeof data !== 'object' || data === null) return;
      const obj = data as Record<string, unknown>;
      const status = obj.status;
      if (status === 'progress' && typeof obj.progress === 'number') {
        const pct = Math.floor(obj.progress);
        if (pct !== lastProgress && pct % 10 === 0) {
          lastProgress = pct;
          logger.info('embedding model download', {
            file: obj.file,
            progress: `${pct}%`,
          });
        }
        return;
      }
      if (status === 'done' || status === 'ready') {
        logger.debug('embedding model bootstrap stage', obj);
      }
    },
  })) as unknown as Extractor;
  return extractor;
}

/**
 * Return the singleton embedding pipeline, downloading the model on
 * first call. Concurrent callers share a single in-flight promise so
 * we never fire the download twice.
 */
export async function getEmbedder(): Promise<Extractor> {
  if (pipelineSingleton) return pipelineSingleton;
  if (!pipelinePromise) {
    pipelinePromise = loadPipeline()
      .then((p) => {
        pipelineSingleton = p;
        return p;
      })
      .catch((err) => {
        pipelinePromise = undefined;
        throw err;
      });
  }
  return pipelinePromise;
}

/**
 * Embed a batch of texts. Returns one Float32Array per input. We loop
 * sequentially rather than feeding the whole batch in one call because
 * the ONNX runtime under WASM in Bun doesn't benefit much from batch
 * tensor packing at this model size, and looping keeps memory flat —
 * matters when `embedAllCached()` walks thousands of items.
 */
export async function embed(texts: string[]): Promise<Float32Array[]> {
  const extractor = await getEmbedder();
  const out: Float32Array[] = [];
  for (const text of texts) {
    const result = await extractor(text, { pooling: 'mean', normalize: true });
    // @xenova returns a Tensor; .data is a Float32Array of length 384.
    out.push(new Float32Array(result.data));
  }
  return out;
}

/**
 * Test seam — swap the embed function used by `embedAllCached()` and
 * other orchestrators so unit tests don't trigger the real model load.
 * Reset to the real `embed` by re-assigning `embedFn`.
 */
export const _depsForTests: { embedFn: typeof embed } = { embedFn: embed };
