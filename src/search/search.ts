/**
 * P4.1 — Semantic search orchestrator.
 *
 * Pipeline (per PHASE_4_PLAN §4.1):
 *
 *   1. Embed the query string with the local MiniLM provider (free).
 *   2. Pull a candidate pool from the embedding store (oversample so
 *      type filter + threshold don't drop us below `limit`).
 *   3. Apply `typeFilter` + `threshold` post-hoc on the candidate set.
 *   4. Take the top `limit` by cosine similarity.
 *   5. Optional: LLM rerank top candidates via Kyma chat (~$0.005).
 *      On JSON-parse failure or any rerank error, fall back to semantic
 *      order with `reranked: false` — never explode the response.
 *   6. Map each `SearchHit` (`EmbeddingMeta` + similarity) into the
 *      narrower `SearchResult.source` shape and truncate the snippet to
 *      a display-friendly width.
 *
 * Cost: $0 by default (embedding is local). ~$0.005 when `rerank: true`.
 * Surfaced via `SearchResponse.estimatedCostUsd`.
 *
 * Test seam: `_depsForTests.embedFn` (provider) + `_depsForTests.chatFn`
 * (here) let unit tests swap in deterministic fakes without monkey-
 * patching modules. The store is swapped via
 * `_setDbModuleForTests()` on the embeddings module.
 */
import { logger } from '../core/logger.ts';
import { _depsForTests as providerDeps } from '../embeddings/provider.ts';
import { searchSimilar } from '../embeddings/store.ts';
import { chat as defaultChat } from '../kyma/client.ts';
import type { EmbeddingMeta } from '../models/embedding.ts';
import type {
  SearchEntityType,
  SearchResponse,
  SearchResult,
  SearchSource,
} from '../models/search.ts';

/** Max chars of EmbeddingMeta.snippet to include in the returned SearchResult. */
const SNIPPET_DISPLAY_CHARS = 200;
/** Candidate-pool multiplier so type filter + threshold rarely starve `limit`. */
const CANDIDATE_OVERSAMPLE = 3;
/** Floor on candidate pool — relevant when limit is 1 or 2. */
const CANDIDATE_FLOOR = 10;
/** Cap on rerank candidate count to keep the chat prompt bounded. */
const RERANK_MAX_CANDIDATES = 20;
/** Per-snippet cap inside the rerank prompt so we don't blow the context window. */
const RERANK_SNIPPET_CHARS = 280;
/** Flat cost surface for rerank (mirrors PHASE_4_PLAN §13 acceptance). */
const RERANK_FLAT_COST_USD = 0.005;

export type SearchOptions = {
  query: string;
  /** Max results returned. Default 10. */
  limit?: number;
  /** Minimum cosine similarity. Results below this are dropped. Default: no filter. */
  threshold?: number;
  /** Restrict results to a single entity type. */
  typeFilter?: SearchEntityType;
  /** When true, call Kyma chat to rerank the top candidates. ~$0.005. */
  rerank?: boolean;
  /** Override the Kyma model used for rerank. */
  rerankModel?: string;
};

/**
 * Test seam — replace `embedFn` to skip the real MiniLM call, or
 * `chatFn` to skip the Kyma call. Provider-side `embedFn` lives in
 * `embeddings/provider.ts`; we wrap it so we always go through the
 * latest test override.
 */
export const _depsForTests: {
  chatFn: typeof defaultChat;
} = {
  chatFn: defaultChat,
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Derive the public `SearchSource` from the stored `EmbeddingMeta`.
 *
 * Conventions baked in by P4.0 (`src/embeddings/index.ts`):
 *   - posts + comments use the raw X id as `entityId`
 *   - article passages use `article:{urlCanonical}:chunk:{idx}` and
 *     leave `authorHandle` unset
 *
 * For posts + comments, we can synthesize a tweet URL from
 * `handle + postId` when the meta row didn't carry `sourceUrl`. This
 * matters because the orchestrator only stores `sourceUrl` when the
 * underlying cache row had one — comments scraped without a URL still
 * have a recoverable URL via the handle/id pair.
 */
function metaToSource(hit: EmbeddingMeta): SearchSource {
  const source: SearchSource = {};
  if (hit.authorHandle) source.authorHandle = hit.authorHandle;

  if (hit.entityType === 'post' || hit.entityType === 'comment') {
    // entityId is the raw tweet id (numeric string). Surface it as postId.
    source.postId = hit.entityId;
    if (hit.sourceUrl) {
      source.url = hit.sourceUrl;
    } else if (hit.authorHandle) {
      source.url = `https://x.com/${hit.authorHandle}/status/${hit.entityId}`;
    }
  } else {
    // article-passage / thread / anything else — pass through sourceUrl.
    if (hit.sourceUrl) source.url = hit.sourceUrl;
  }
  return source;
}

// ─── Rerank JSON shape + lenient repair ────────────────────────────

type RerankRow = { entityId: string; rerankScore: number };

/**
 * Parse a rerank chat response leniently — same philosophy as
 * `src/article/cross-reference.ts` and `intelligence/classify.ts`.
 * Drop any row that can't be coerced into `{ entityId: string,
 * rerankScore: number in [0,1] }`; never throw.
 */
function parseRerankResponse(content: string): RerankRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const list = (parsed as { ranked?: unknown }).ranked;
  if (!Array.isArray(list)) return [];

  const out: RerankRow[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const entityId = typeof item.entityId === 'string' ? item.entityId : undefined;
    let score = item.rerankScore;
    if (typeof score === 'string') {
      const n = Number.parseFloat(score);
      if (Number.isFinite(n)) score = n;
    }
    // Model sometimes emits 0-100 instead of 0-1 — normalize.
    if (typeof score === 'number' && score > 1 && score <= 100) score = score / 100;
    if (!entityId || typeof score !== 'number' || !Number.isFinite(score)) continue;
    const clamped = Math.max(0, Math.min(1, score));
    out.push({ entityId, rerankScore: clamped });
  }
  return out;
}

/**
 * Apply rerank scores to the candidate results. Items absent from the
 * model output keep their semantic order at the bottom (with
 * `rerankScore` left undefined). Mutates a copy; returns a fresh array.
 */
function applyRerank(results: SearchResult[], ranked: RerankRow[]): SearchResult[] {
  if (ranked.length === 0) return results;
  const scoreById = new Map<string, number>();
  for (const r of ranked) {
    if (!scoreById.has(r.entityId)) scoreById.set(r.entityId, r.rerankScore);
  }
  const out = results.map((r) => {
    const score = scoreById.get(r.entityId);
    return score === undefined ? r : { ...r, rerankScore: score };
  });
  out.sort((a, b) => {
    const ar = a.rerankScore;
    const br = b.rerankScore;
    if (ar !== undefined && br !== undefined) return br - ar;
    if (ar !== undefined) return -1;
    if (br !== undefined) return 1;
    return b.similarity - a.similarity;
  });
  return out;
}

function buildRerankMessages(
  query: string,
  candidates: SearchResult[],
): { system: string; user: string } {
  const system = [
    "Rerank these snippets by relevance to the user's query.",
    'Return the same items reordered most-relevant first.',
    'For each, include a rerankScore between 0 and 1.',
    '',
    'Output JSON only:',
    '{ "ranked": [ { "entityId": "...", "rerankScore": 0.92 }, ... ] }',
    '',
    'Constraints:',
    '- Include every candidate exactly once.',
    '- Use only entityIds from the CANDIDATES list — do not invent ids.',
    '- Drop nothing; reorder only.',
  ].join('\n');

  const candidateBlock = candidates
    .map((c) => `- [${c.entityId}] ${truncate(c.snippet, RERANK_SNIPPET_CHARS)}`)
    .join('\n');

  const user = [`QUERY: ${query}`, '', 'CANDIDATES:', candidateBlock].join('\n');
  return { system, user };
}

// ─── Main entrypoint ───────────────────────────────────────────────

export async function search(opts: SearchOptions): Promise<SearchResponse> {
  const limit = opts.limit ?? 10;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`search: limit must be a positive integer, got ${limit}`);
  }
  if (opts.threshold !== undefined && (opts.threshold < -1 || opts.threshold > 1)) {
    throw new Error(`search: threshold must be in [-1, 1], got ${opts.threshold}`);
  }

  const startedAt = Date.now();

  // 1. Embed query.
  const embedStart = Date.now();
  const vecs = await providerDeps.embedFn([opts.query]);
  const queryVec = vecs[0];
  if (!queryVec) throw new Error('search: embedder returned no vector for query');
  logger.debug('search', { stage: 'embed', durationMs: Date.now() - embedStart });

  // 2. Oversample candidates so filters don't starve `limit`.
  const candidatePool = Math.max(CANDIDATE_FLOOR, limit * CANDIDATE_OVERSAMPLE);
  const similarStart = Date.now();
  const rawHits = searchSimilar(queryVec, candidatePool);
  logger.debug('search', {
    stage: 'similar',
    durationMs: Date.now() - similarStart,
    candidates: rawHits.length,
  });

  // 3. Filter + map to SearchResult.
  const filtered: SearchResult[] = [];
  for (const hit of rawHits) {
    if (opts.typeFilter && hit.entityType !== opts.typeFilter) continue;
    if (opts.threshold !== undefined && hit.similarity < opts.threshold) continue;
    filtered.push({
      entityType: hit.entityType as SearchEntityType,
      entityId: hit.entityId,
      snippet: truncate(hit.snippet, SNIPPET_DISPLAY_CHARS),
      similarity: hit.similarity,
      source: metaToSource(hit),
    });
  }

  // 4. Take top-limit by similarity (already sorted by store).
  let results = filtered.slice(0, limit);

  // 5. Optional rerank.
  let reranked = false;
  let cost = 0;
  if (opts.rerank && results.length >= 2) {
    const rerankSet = results.slice(0, Math.min(results.length, RERANK_MAX_CANDIDATES));
    const { system, user } = buildRerankMessages(opts.query, rerankSet);
    const chatOpts: Parameters<typeof defaultChat>[0] = {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      jsonMode: true,
      temperature: 0.1,
      maxTokens: 800,
    };
    if (opts.rerankModel) chatOpts.model = opts.rerankModel;

    const rerankStart = Date.now();
    try {
      const res = await _depsForTests.chatFn(chatOpts);
      const ranked = parseRerankResponse(res.content);
      if (ranked.length > 0) {
        results = applyRerank(rerankSet, ranked);
        reranked = true;
        cost = res.cached ? 0 : RERANK_FLAT_COST_USD;
      } else {
        logger.warn('search rerank produced no usable rows — falling back to semantic order');
      }
    } catch (err) {
      logger.warn('search rerank failed — falling back to semantic order', { err: String(err) });
    }
    logger.debug('search', {
      stage: 'rerank',
      durationMs: Date.now() - rerankStart,
      reranked,
    });
  }

  const response: SearchResponse = {
    query: opts.query,
    reranked,
    limit,
    results,
    estimatedCostUsd: cost,
    generatedAt: new Date(startedAt).toISOString(),
  };
  if (opts.threshold !== undefined) response.threshold = opts.threshold;
  if (opts.typeFilter !== undefined) response.typeFilter = opts.typeFilter;

  return response;
}
