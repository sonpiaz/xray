/**
 * P3.2 — Article ↔ tweet claim-passage attribution.
 *
 * Single-call cross-referencer: takes an `ArticleBody`, the originating
 * tweet thesis (root + author follow-up text), optionally the already-
 * derived summary, and returns a list of `CrossReference` entries —
 * each one mapping a substantive tweet claim to a verbatim article
 * passage with a `supports | extends | contradicts | unrelated` label
 * and a 0-1 confidence score.
 *
 * The output is purposefully sparse — the model is instructed to skip
 * claims that don't map cleanly rather than emit weak `unrelated`
 * filler. An 8-row hard cap matches the prompt constraint and keeps
 * cost bounded; a defensive validator drops malformed rows (e.g. an
 * unknown `relationship`) rather than failing the whole batch — same
 * lenient-repair philosophy `classify.ts` uses.
 *
 * Cost is computed from real usage when Kyma surfaces it, falling back
 * to a 4-chars-per-token estimate (matches `summarize.ts`).
 */
import { logger } from '../core/logger.ts';
import { chat } from '../kyma/client.ts';
import { type ArticleBody, type CrossReference, CrossReferenceSchema } from '../models/article.ts';

/** Cap article body sent to the LLM so we don't blow a context window. */
const ARTICLE_TEXT_MAX_CHARS = 16_000;
/** Cap tweet thesis separately — guard against thread-text bloat. */
const TWEET_THESIS_MAX_CHARS = 4_000;
/** Optional summary cap — passed in as supplementary context. */
const SUMMARY_MAX_CHARS = 2_000;
/** Max rows we accept from the model after validation. */
export const MAX_CROSS_REFERENCES = 8;

const PRICE_INPUT_USD_PER_1K = 0.0001;
const PRICE_OUTPUT_USD_PER_1K = 0.0003;

/** Cache-key version — bump when the prompt format changes. */
export const CROSS_REFERENCE_PROMPT_VERSION = 'v1';

export type CrossReferenceInput = {
  /** Article body whose passages we map claims into. */
  articleBody: ArticleBody;
  /** Tweet thesis text — root tweet + author follow-ups joined. */
  tweetThesis: string;
  /** Optional summary fed back as context so the model isn't summarizing again. */
  articleSummary?: string;
  /** Override the Kyma chat model. */
  model?: string;
  /** Canonical article URL used to namespace the kyma cache key. */
  urlCanonical: string;
  /** When set, skips the Kyma cache layer. */
  noCache?: boolean;
};

export type CrossReferenceOutput = {
  crossReferences: CrossReference[];
  estimatedCostUsd: number;
  /** True when the Kyma response came from the cache. */
  cached: boolean;
  /** Model that produced the cross-references. */
  model: string;
};

/**
 * Build the system + user prompts. Exported for unit tests so the prompt
 * format can be pinned down without round-tripping through Kyma.
 */
export function buildCrossReferencePrompts(
  articleBody: ArticleBody,
  tweetThesis: string,
  articleSummary?: string,
): { system: string; user: string } {
  const system = [
    'You map specific claims in a tweet to specific passages in a linked article and classify the relationship.',
    '',
    'For each meaningful claim in the tweet, find:',
    '- The strongest passage in the article that addresses it (exact substring, 1-3 sentences)',
    "- The relationship: 'supports' | 'extends' | 'contradicts' | 'unrelated'",
    '- confidence: 0.0-1.0',
    '',
    'Output JSON only:',
    '{',
    '  "crossReferences": [',
    '    { "tweetClaim": "...", "articlePassage": "...", "relationship": "supports", "confidence": 0.85 }',
    '  ]',
    '}',
    '',
    'Constraints:',
    `- Max ${MAX_CROSS_REFERENCES} cross-references per article (cost cap)`,
    "- Skip claims that don't map cleanly to any passage (rather than 'unrelated' filler)",
    '- articlePassage must be a verbatim substring from the article body',
    '- If tweet has <2 substantive claims (e.g., just a link share), output empty crossReferences[]',
  ].join('\n');

  const truncatedArticle =
    articleBody.text.length > ARTICLE_TEXT_MAX_CHARS
      ? `${articleBody.text.slice(0, ARTICLE_TEXT_MAX_CHARS)}\n[truncated — original was ${articleBody.text.length} chars]`
      : articleBody.text;

  const thesisBlock = tweetThesis.slice(0, TWEET_THESIS_MAX_CHARS);

  const summaryLine = articleSummary
    ? `\nARTICLE SUMMARY (for context, do not re-summarize): ${articleSummary.slice(0, SUMMARY_MAX_CHARS)}\n`
    : '';

  const user = [
    'TWEET THESIS:',
    thesisBlock,
    '',
    `ARTICLE TITLE: ${articleBody.title}`,
    `WORD COUNT: ${articleBody.wordCount}`,
    'ARTICLE BODY:',
    truncatedArticle,
    summaryLine,
    'Respond with strict JSON only.',
  ].join('\n');

  return { system, user };
}

/** Estimate token usage from a character count using the 4-chars-per-token rule. */
function estimateTokens(chars: number): number {
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * Convert a (promptTokens, completionTokens) pair to a USD cost using the
 * module-level price constants. Exported for unit tests so the price
 * formula can be asserted directly.
 */
export function estimateCrossReferenceCost(promptTokens: number, completionTokens: number): number {
  const inputUsd = (promptTokens / 1000) * PRICE_INPUT_USD_PER_1K;
  const outputUsd = (completionTokens / 1000) * PRICE_OUTPUT_USD_PER_1K;
  return Math.round((inputUsd + outputUsd) * 1_000_000) / 1_000_000;
}

const VALID_RELATIONSHIPS = new Set(['supports', 'extends', 'contradicts', 'unrelated']);

/** Known relationship synonyms the model occasionally emits — map to canonical. */
const RELATIONSHIP_REPAIRS: Record<string, string> = {
  related: 'extends',
  agrees: 'supports',
  agree: 'supports',
  agreement: 'supports',
  support: 'supports',
  supporting: 'supports',
  evidence: 'supports',
  confirms: 'supports',
  expands: 'extends',
  expand: 'extends',
  extending: 'extends',
  extension: 'extends',
  elaborates: 'extends',
  nuance: 'extends',
  context: 'extends',
  contradict: 'contradicts',
  contradicting: 'contradicts',
  disagrees: 'contradicts',
  disagree: 'contradicts',
  disagreement: 'contradicts',
  refutes: 'contradicts',
  opposes: 'contradicts',
  unrelated_to: 'unrelated',
  none: 'unrelated',
  irrelevant: 'unrelated',
};

/**
 * Repair common model output shapes before Zod sees them. The model
 * occasionally emits `relationship: 'related'` or a confidence > 1
 * (e.g., 85 instead of 0.85). We coerce known-fixable shapes; unfixable
 * rows are dropped (rather than failing the whole batch) by the
 * downstream Zod parse + filter.
 *
 * Mirrors the `repairClassificationResponse` philosophy in
 * `intelligence/classify.ts`.
 */
export function repairCrossReferenceResponse(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const obj = payload as Record<string, unknown>;
  const list = obj.crossReferences;
  if (!Array.isArray(list)) return payload;
  let repaired = 0;
  const out = list.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const item = { ...(raw as Record<string, unknown>) };

    // Coerce relationship.
    const rel = typeof item.relationship === 'string' ? item.relationship.toLowerCase() : undefined;
    if (rel && !VALID_RELATIONSHIPS.has(rel)) {
      const mapped = RELATIONSHIP_REPAIRS[rel];
      if (mapped) {
        item.relationship = mapped;
        repaired += 1;
      }
    } else if (rel) {
      // Lowercase normalization counts as a repair only if it changed something.
      if (rel !== item.relationship) {
        item.relationship = rel;
        repaired += 1;
      }
    }

    // Coerce confidence. Some models return 0-100 instead of 0-1.
    if (typeof item.confidence === 'number' && item.confidence > 1 && item.confidence <= 100) {
      item.confidence = item.confidence / 100;
      repaired += 1;
    }
    // Stringly-typed numbers ("0.85") → number.
    if (typeof item.confidence === 'string') {
      const n = Number.parseFloat(item.confidence);
      if (Number.isFinite(n)) {
        item.confidence = n > 1 && n <= 100 ? n / 100 : n;
        repaired += 1;
      }
    }

    return item;
  });
  if (repaired > 0) {
    logger.debug('cross-reference response repaired', { repaired, total: list.length });
  }
  return { ...obj, crossReferences: out };
}

/**
 * Validate model output into a clean `CrossReference[]`. Drops rows that
 * still fail schema after repair (rather than throwing the whole batch).
 * Enforces the MAX_CROSS_REFERENCES cap as a hard guardrail.
 */
export function parseCrossReferenceResponse(payload: unknown): CrossReference[] {
  const repaired = repairCrossReferenceResponse(payload);
  if (!repaired || typeof repaired !== 'object') return [];
  const list = (repaired as { crossReferences?: unknown }).crossReferences;
  if (!Array.isArray(list)) return [];

  const out: CrossReference[] = [];
  let dropped = 0;
  for (const raw of list) {
    const parsed = CrossReferenceSchema.safeParse(raw);
    if (parsed.success) {
      out.push(parsed.data);
    } else {
      dropped += 1;
    }
    if (out.length >= MAX_CROSS_REFERENCES) break;
  }
  if (dropped > 0) {
    logger.debug('cross-reference rows dropped', { dropped });
  }
  return out;
}

/**
 * Cross-reference an article against a tweet thesis via Kyma chat.
 * Returns the validated mapping list plus an estimated USD cost.
 *
 * Throws when Kyma returns invalid JSON (caller — orchestrator — catches
 * and degrades; the article summary still ships without cross-refs).
 */
export async function crossReferenceArticle(
  input: CrossReferenceInput,
): Promise<CrossReferenceOutput> {
  const { system, user } = buildCrossReferencePrompts(
    input.articleBody,
    input.tweetThesis,
    input.articleSummary,
  );
  const ctxHash = hashContext(input.tweetThesis);
  const cacheKey = `article-crossref:${input.urlCanonical}:${ctxHash}:${CROSS_REFERENCE_PROMPT_VERSION}`;

  const chatOpts: Parameters<typeof chat>[0] = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    jsonMode: true,
    temperature: 0.2,
    maxTokens: 4000,
    cacheKey,
  };
  if (input.model !== undefined) chatOpts.model = input.model;
  // Mirror summarize.ts cache-bypass trick — salt the key so noCache
  // forces a fresh call.
  if (input.noCache) {
    chatOpts.cacheKey = `${cacheKey}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const res = await chat(chatOpts);

  let parsed: unknown;
  try {
    parsed = JSON.parse(res.content);
  } catch (err) {
    throw new Error(`article cross-reference JSON parse failed: ${String(err)}`);
  }

  const crossReferences = parseCrossReferenceResponse(parsed);

  const promptTokens = res.usage?.promptTokens ?? estimateTokens(system.length + user.length);
  const completionTokens = res.usage?.completionTokens ?? estimateTokens(res.content.length);
  const estimatedCostUsd = res.cached
    ? 0
    : estimateCrossReferenceCost(promptTokens, completionTokens);

  logger.debug('article cost', {
    stage: 'cross-reference',
    costUsd: estimatedCostUsd,
    promptTokens,
    completionTokens,
    cached: res.cached,
    model: res.model,
    rows: crossReferences.length,
  });

  return {
    crossReferences,
    estimatedCostUsd,
    cached: res.cached,
    model: res.model,
  };
}

/** Hash a string to a short stable suffix for cache-key namespacing. */
function hashContext(text: string | undefined): string {
  if (!text) return '';
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
