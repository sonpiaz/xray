import { logger } from '../core/logger.ts';
/**
 * P3.0 — Article summarization via Kyma chat.
 *
 * Single-call summarizer: takes an `ArticleBody`, optionally augmented
 * with the originating tweet's text for context, and returns a structured
 * `{ summary, keyPoints[] }` plus an estimated USD cost.
 *
 * Cost is computed from the post-call token usage when the upstream
 * surfaced it (`res.usage.promptTokens` / `completionTokens`). When usage
 * is missing — older Kyma deployments, or cached responses that don't
 * carry usage — we fall back to a token estimate of ~1 token per 4
 * characters, which matches OpenAI's published rule of thumb.
 *
 * Pricing constants below approximate Gemini Flash through Kyma
 * (~$0.0001 / 1K input tokens, ~$0.0003 / 1K output tokens). They're
 * deliberately rough — the figure is informational, not billing.
 */
import { chat } from '../kyma/client.ts';
import type { ArticleBody } from '../models/article.ts';

/** Cap article body sent to the LLM so we don't blow a context window. */
const ARTICLE_TEXT_MAX_CHARS = 100_000;
/** Cap tweet context separately — usually tiny, but stay defensive. */
const TWEET_CONTEXT_MAX_CHARS = 4_000;

const PRICE_INPUT_USD_PER_1K = 0.0001;
const PRICE_OUTPUT_USD_PER_1K = 0.0003;

/** Cache-key version — bump when the prompt format changes. */
export const SUMMARIZE_PROMPT_VERSION = 'v1';

export type SummarizeArticleOptions = {
  /** Optional originating tweet context — improves summary framing. */
  tweetContext?: { text: string; postId?: string };
  /** Override the Kyma chat model. */
  model?: string;
  /** Canonical article URL used to namespace the kyma cache key. */
  urlCanonical: string;
  /** When set, skips the Kyma cache layer. */
  noCache?: boolean;
};

export type SummarizeArticleResult = {
  summary: string;
  keyPoints: string[];
  wordCount: number;
  estimatedCostUsd: number;
  /** True when the Kyma response came from the kyma_responses cache. */
  cached: boolean;
  /** Model that produced the summary (resolved from chat result). */
  model: string;
};

type SummaryJson = { summary?: string; keyPoints?: string[] };

/**
 * Build the system + user prompts. Exported for unit tests so the prompt
 * format can be pinned down without round-tripping through Kyma.
 */
export function buildSummarizePrompts(
  body: ArticleBody,
  tweetContext?: SummarizeArticleOptions['tweetContext'],
): { system: string; user: string } {
  const system = [
    'You are an article summarizer. Given an article and (optionally) the',
    'tweet that linked to it, produce:',
    '- summary: a 3-5 sentence narrative summary capturing the main argument',
    '- keyPoints: 3-7 bullet-point takeaways quoting or paraphrasing specific claims',
    '',
    'Be specific and evidence-based. Avoid vague platitudes.',
    'Output JSON ONLY in the shape: { "summary": "...", "keyPoints": ["...", ...] }.',
  ].join('\n');

  const truncatedText =
    body.text.length > ARTICLE_TEXT_MAX_CHARS
      ? `${body.text.slice(0, ARTICLE_TEXT_MAX_CHARS)}\n[truncated — original was ${body.text.length} chars]`
      : body.text;

  const tweetBlock = tweetContext?.text
    ? `TWEET CONTEXT:\n${tweetContext.text.slice(0, TWEET_CONTEXT_MAX_CHARS)}\n\n`
    : '';

  const bylineLine = body.byline ? `BYLINE: ${body.byline}\n` : '';
  const publishedLine = body.publishedAt ? `PUBLISHED: ${body.publishedAt}\n` : '';

  const user = [
    `${tweetBlock}ARTICLE TITLE: ${body.title}`,
    `${bylineLine + publishedLine}WORD COUNT: ${body.wordCount}`,
    '',
    'ARTICLE BODY:',
    truncatedText,
    '',
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
export function estimateSummarizeCost(promptTokens: number, completionTokens: number): number {
  const inputUsd = (promptTokens / 1000) * PRICE_INPUT_USD_PER_1K;
  const outputUsd = (completionTokens / 1000) * PRICE_OUTPUT_USD_PER_1K;
  return Math.round((inputUsd + outputUsd) * 1_000_000) / 1_000_000;
}

/** Hash a tweet context to a short string for cache-key namespacing. */
function hashContext(text: string | undefined): string {
  if (!text) return '';
  // Cheap djb2 hash — collisions are fine; the cache layer is keyed on
  // URL canonical + this hash, so a collision only causes a stale-summary
  // hit on a different thread context, which is well within tolerance.
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Summarize an article body via Kyma chat. Returns a `SummarizeArticleResult`
 * with the LLM output + an estimated USD cost.
 *
 * Throws when Kyma returns invalid JSON or an empty summary — the caller
 * (orchestrator) catches and degrades to a body-only `ArticleSummary`.
 */
export async function summarizeArticle(
  body: ArticleBody,
  opts: SummarizeArticleOptions,
): Promise<SummarizeArticleResult> {
  const { system, user } = buildSummarizePrompts(body, opts.tweetContext);
  const ctxHash = hashContext(opts.tweetContext?.text);
  const cacheKey = `article-summarize:${opts.urlCanonical}:${ctxHash}:${SUMMARIZE_PROMPT_VERSION}`;

  const chatOpts: Parameters<typeof chat>[0] = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    jsonMode: true,
    cacheKey,
  };
  if (opts.model !== undefined) chatOpts.model = opts.model;
  // The chat layer uses `cacheKey` as the row key. To bypass we'd need to
  // skip the read — easiest path: salt the key with a random suffix so
  // every call misses but still writes a new row (cheap, prevents reuse).
  if (opts.noCache) {
    chatOpts.cacheKey = `${cacheKey}:${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const res = await chat(chatOpts);

  let parsed: SummaryJson;
  try {
    parsed = JSON.parse(res.content) as SummaryJson;
  } catch (err) {
    throw new Error(`article summarize JSON parse failed: ${String(err)}`);
  }

  const summary = (parsed.summary ?? '').trim();
  if (!summary) {
    throw new Error('article summarize returned empty summary');
  }
  const keyPoints = Array.isArray(parsed.keyPoints)
    ? parsed.keyPoints
        .filter((kp): kp is string => typeof kp === 'string')
        .map((kp) => kp.trim())
        .filter(Boolean)
    : [];

  // Cost. Prefer the real usage figures; fall back to estimates when the
  // upstream omitted them (which Kyma cached rows always do).
  const promptTokens = res.usage?.promptTokens ?? estimateTokens(system.length + user.length);
  const completionTokens = res.usage?.completionTokens ?? estimateTokens(res.content.length);
  const estimatedCostUsd = res.cached ? 0 : estimateSummarizeCost(promptTokens, completionTokens);

  logger.debug('article cost', {
    stage: 'summarize',
    costUsd: estimatedCostUsd,
    promptTokens,
    completionTokens,
    cached: res.cached,
    model: res.model,
  });

  return {
    summary,
    keyPoints,
    wordCount: body.wordCount,
    estimatedCostUsd,
    cached: res.cached,
    model: res.model,
  };
}
