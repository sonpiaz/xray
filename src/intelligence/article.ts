import {
  ArticleError,
  ArticleParseError,
  canonicalizeArticleUrl,
  crossReferenceArticle,
  detectArticleSource,
  fetchExternalArticle,
  getCachedArticleBody,
  getCachedArticleSummary,
  parseXArticle,
  putCachedArticleBody,
  putCachedArticleSummary,
  resolveCanonicalArticleUrl,
  summarizeArticle,
} from '../article/index.ts';
/**
 * P3.0 — Article analysis orchestrator.
 *
 * Pipeline (X Article path only in P3.0):
 *   detect → parse-x-article → cache check → summarize → cache write.
 *
 * The orchestrator surfaces the same shape regardless of which sub-stage
 * failed: an `ArticleSummary` with `partial: true` and human-readable
 * strings in `errors[]`. Throws only on totally unrecoverable input
 * (e.g. URL not classifiable) — every recoverable failure degrades.
 *
 * `external-html` URLs throw `ArticleError` in P3.0 — P3.1 wires the
 * external link fetcher.
 *
 * Card data flow: callers that already have the X Article card payload
 * in hand (e.g. `analyze-thread.ts` after a thread fetch) pass it via
 * `opts.cardData` to skip a redundant Playwright round-trip. Standalone
 * `xray article <url>` runs do a thread fetch via `fetchThread` to
 * harvest the card from the tweet that hosts the article (X Article URLs
 * are anchored under a tweet).
 */
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import {
  type ArticleBody,
  type ArticleCostBreakdown,
  type ArticleSource,
  type ArticleSummary,
  ArticleSummarySchema,
  type CrossReference,
} from '../models/article.ts';
// `fetchThread` is lazy-loaded inside `fetchCardForArticleUrl()` because
// `src/fetcher/thread.ts` transitively imports `bun:sqlite` (via the
// thread cache), which vitest can't resolve under Node. Importing it at
// module top would crash any test that loads this orchestrator.
type FetchThreadFn = typeof import('../fetcher/thread.ts').fetchThread;

/** Spec §8.2 — WARN when article exceeds this word count. */
const LONG_ARTICLE_THRESHOLD_WORDS = 10_000;

export type ArticleAnalyzeOptions = {
  /** Article URL (X Article or external HTML). Required. */
  url: string;
  /** Skip the LLM summarization step — body-only result. */
  raw?: boolean;
  /** Skip cache reads + writes across both stages. */
  noCache?: boolean;
  /** Override the Kyma chat model used for summarization. */
  synthesisModel?: string;
  /**
   * When the caller already has the X Article card payload in hand
   * (e.g. from a parsed thread fetch), passing it here skips the
   * redundant network fetch. Accepts either the raw tweet object or
   * the `tweet.card` sub-object.
   */
  cardData?: unknown;
  /**
   * Optional tweet context to feed into the summary prompt (and to seed
   * the summary cache key). Reserved for P3.2 standalone callers — P3.0
   * orchestrator does not assemble this automatically.
   */
  tweetContext?: { text: string; postId?: string };
};

/**
 * Test seam — same pattern as `intelligence/video.ts`. Tests monkey-patch
 * these to stub out network / disk work without changing the control flow.
 *
 * P3.1 — Adds `fetchExternalArticle` + `resolveCanonicalArticleUrl` so the
 * external-html path can be unit-tested without standing up a real HTTP
 * server or Playwright instance.
 */
export const _orchestratorDeps = {
  parseXArticle,
  summarizeArticle,
  crossReferenceArticle,
  getCachedArticleBody,
  putCachedArticleBody,
  getCachedArticleSummary,
  putCachedArticleSummary,
  fetchExternalArticle,
  resolveCanonicalArticleUrl,
};

/**
 * Orchestrate article analysis.
 *
 * P3.0 — `x-article` path: detect → parseXArticle → summarize.
 * P3.1 — `external-html` path: detect → canonicalize → fetchExternalArticle
 *        → summarize. Same caching layer; the canonical URL doubles as
 *        the cache key so different tracking-param variants of the same
 *        article share a row.
 *
 * Unrecoverable failures throw `ArticleError`. Recoverable failures
 * degrade to a partial `ArticleSummary` with `partial: true` and
 * human-readable strings in `errors[]`.
 */
export async function analyzeArticle(opts: ArticleAnalyzeOptions): Promise<ArticleSummary> {
  const url = opts.url;
  const source = detectArticleSource(url);
  if (!source) {
    throw new ArticleError(`Not a valid article URL: ${url}`);
  }

  const cfg = loadConfig();
  const errors: string[] = [];
  let partial = false;
  const cost: ArticleCostBreakdown = {};

  // ─── Stage 0: canonicalize URL (external path only) ────────────────
  // For external HTML we resolve shortlinks + strip tracking params so
  // the cache row + downstream `canonicalUrl` field reflect the real
  // article identity. X Article URLs are already stable (the article ID
  // path segment is the identity) — no canonicalization needed.
  let cacheKeyUrl = url;
  let canonicalUrl = url;
  if (source === 'external-html') {
    try {
      canonicalUrl = await _orchestratorDeps.resolveCanonicalArticleUrl(url);
      cacheKeyUrl = canonicalUrl;
    } catch (err) {
      // Canonicalization is best-effort — fall back to the raw URL.
      logger.debug('article canonicalize failed, using raw url', { url, err: String(err) });
      canonicalUrl = canonicalizeArticleUrl(url);
      cacheKeyUrl = canonicalUrl;
    }
  }

  // ─── Stage 1: cache check (summary first, body second) ─────────────
  // If a summary exists keyed on (url, tweetContextHash) and we're not
  // bypassing the cache, short-circuit straight to the cached result.
  // Otherwise we still want to know about a cached body so we can skip
  // parse/re-fetch and go straight to summarization.
  const tweetContextHash = hashTweetContext(opts.tweetContext?.text);

  if (!opts.noCache && !opts.raw) {
    const cachedSummary = _orchestratorDeps.getCachedArticleSummary({
      urlCanonical: cacheKeyUrl,
      tweetContextHash,
    });
    if (cachedSummary) {
      logger.debug('article cache hit: summary', { url: cacheKeyUrl, tweetContextHash });
      return cachedSummary;
    }
  }

  // ─── Stage 2: resolve body (cache → cardData/fetch) ────────────────
  let body: ArticleBody | undefined;
  let bodyFromCache = false;

  if (!opts.noCache) {
    const cachedBody = _orchestratorDeps.getCachedArticleBody(cacheKeyUrl);
    if (cachedBody) {
      body = cachedBody;
      bodyFromCache = true;
      logger.debug('article cache hit: body', { url: cacheKeyUrl });
    }
  }

  if (!body) {
    if (source === 'x-article') {
      // ── X Article path (P3.0) ──────────────────────────────────────
      let cardPayload: unknown = opts.cardData;
      if (cardPayload === undefined) {
        // Standalone path — we need the card. The X Article URL is anchored
        // under a tweet; let the existing thread fetcher walk the page and
        // hand us back the tweet's `raw.card` payload via the parser.
        try {
          cardPayload = await fetchCardForArticleUrl(url);
        } catch (err) {
          // Hard failure — no card means no body. Surface as a partial
          // result so the caller still gets a schema-valid object.
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`fetch card: ${msg}`);
          return finalize({
            url,
            canonicalUrl,
            source,
            body: emptyBody(),
            summary: undefined,
            keyPoints: [],
            partial: true,
            errors,
            cost,
          });
        }
      }

      try {
        body = _orchestratorDeps.parseXArticle(cardPayload);
      } catch (err) {
        if (err instanceof ArticleParseError) {
          errors.push(`parse: ${err.message}`);
          return finalize({
            url,
            canonicalUrl,
            source,
            body: emptyBody(),
            summary: undefined,
            keyPoints: [],
            partial: true,
            errors,
            cost,
          });
        }
        throw err;
      }
    } else {
      // ── External HTML path (P3.1) ──────────────────────────────────
      try {
        const fetched = await _orchestratorDeps.fetchExternalArticle({ url });
        body = fetched.body;
        // Carry over partial flag + tier escalation warnings.
        if (fetched.partial) partial = true;
        if (fetched.errors && fetched.errors.length > 0) {
          for (const e of fetched.errors) errors.push(`fetch: ${e}`);
        }
        // If fetch resolved to a more authoritative URL (e.g., t.co
        // expanded mid-fetch or a redirect chain), prefer it.
        if (fetched.canonicalUrl && fetched.canonicalUrl !== cacheKeyUrl) {
          const reCanonical = canonicalizeArticleUrl(fetched.canonicalUrl);
          if (reCanonical !== cacheKeyUrl) {
            canonicalUrl = reCanonical;
            cacheKeyUrl = reCanonical;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`fetch: ${msg}`);
        return finalize({
          url,
          canonicalUrl,
          source,
          body: emptyExternalBody(),
          summary: undefined,
          keyPoints: [],
          partial: true,
          errors,
          cost,
        });
      }
    }

    // Cache the body (write-through even when noCache reads were skipped
    // — the next run benefits).
    if (body) {
      try {
        _orchestratorDeps.putCachedArticleBody({ urlCanonical: cacheKeyUrl, source, body });
      } catch (err) {
        logger.debug('article body cache write failed', { err: String(err) });
      }
    }
  }

  // Spec §8.2 — WARN on long articles before kicking off summarization.
  if (body && body.wordCount > LONG_ARTICLE_THRESHOLD_WORDS) {
    logger.warn('long article detected', {
      wordCount: body.wordCount,
      url,
    });
  }

  // ─── Stage 3: summarize ────────────────────────────────────────────
  let summary: string | undefined;
  let keyPoints: string[] = [];
  let modelUsed: string | undefined;

  const canSummarize = !opts.raw && body && body.wordCount > 0;
  if (canSummarize) {
    if (!cfg.kyma.key) {
      errors.push('KYMA_API_KEY not set — returning body only');
      partial = true;
    } else {
      try {
        const summarizeOpts: Parameters<typeof summarizeArticle>[1] = {
          urlCanonical: cacheKeyUrl,
        };
        if (opts.synthesisModel !== undefined) summarizeOpts.model = opts.synthesisModel;
        if (opts.noCache) summarizeOpts.noCache = true;
        if (opts.tweetContext) summarizeOpts.tweetContext = opts.tweetContext;
        const res = await _orchestratorDeps.summarizeArticle(body as ArticleBody, summarizeOpts);
        summary = res.summary;
        keyPoints = res.keyPoints;
        cost.summarize = res.estimatedCostUsd;
        modelUsed = res.model;
      } catch (err) {
        errors.push(`summarize: ${String(err)}`);
        partial = true;
        logger.warn('article summarize failed', { err: String(err) });
      }
    }
  }

  // ─── Stage 3.5: cross-reference (P3.2) ─────────────────────────────
  // Only runs when (a) tweet context was supplied, (b) we have a real
  // body to attribute against, (c) we're not in raw mode, and (d) the
  // Kyma key is set. Failures degrade — the summary still ships and
  // the orchestrator emits `crossReferences: []`.
  let crossReferences: CrossReference[] = [];
  const canCrossReference =
    !opts.raw &&
    body &&
    body.wordCount > 0 &&
    opts.tweetContext?.text &&
    cfg.kyma.key &&
    !errors.some((e) => e.includes('KYMA_API_KEY'));
  if (canCrossReference) {
    try {
      const crxOpts: Parameters<typeof crossReferenceArticle>[0] = {
        articleBody: body as ArticleBody,
        tweetThesis: (opts.tweetContext as { text: string }).text,
        urlCanonical: cacheKeyUrl,
      };
      if (summary) crxOpts.articleSummary = summary;
      if (opts.synthesisModel !== undefined) crxOpts.model = opts.synthesisModel;
      if (opts.noCache) crxOpts.noCache = true;
      const res = await _orchestratorDeps.crossReferenceArticle(crxOpts);
      crossReferences = res.crossReferences;
      cost.crossReference = res.estimatedCostUsd;
      if (!modelUsed) modelUsed = res.model;
    } catch (err) {
      errors.push(`cross-reference: ${String(err)}`);
      partial = true;
      logger.warn('article cross-reference failed', { err: String(err) });
    }
  }

  const result = finalize({
    url,
    canonicalUrl,
    source,
    body: (body ?? emptyBody()) as ArticleBody,
    summary,
    keyPoints,
    crossReferences,
    partial,
    errors,
    cost,
  });

  // ─── Stage 4: summary cache write ──────────────────────────────────
  // Only write when we have a real summary (avoid caching body-only
  // partials — those are cheap to re-derive).
  if (!opts.noCache && !opts.raw && summary) {
    try {
      _orchestratorDeps.putCachedArticleSummary({
        urlCanonical: cacheKeyUrl,
        tweetContextHash,
        summary: result,
        model: modelUsed ?? cfg.kyma.model,
      });
    } catch (err) {
      logger.debug('article summary cache write failed', { err: String(err) });
    }
  }

  // Touch `bodyFromCache` so the closure doesn't warn-unused. We don't
  // currently surface it but it's useful in debug logs:
  if (bodyFromCache) {
    logger.debug('article body served from cache', { url: cacheKeyUrl });
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function emptyBody(): ArticleBody {
  return {
    title: 'Untitled',
    text: '',
    wordCount: 0,
    contentSource: 'x-article-card',
  };
}

function emptyExternalBody(): ArticleBody {
  return {
    title: 'Untitled',
    text: '',
    wordCount: 0,
    contentSource: 'cheerio-fallback',
  };
}

function hashTweetContext(text: string | undefined): string {
  if (!text) return '';
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Resolve an X Article URL's tweet card.
 *
 * Path A — tweet URL (`x.com/<handle>/status/<id>`): walk the page via
 * the existing thread fetcher. The same TweetDetail GraphQL response
 * that powers `xray thread` carries the card on the root post's
 * `raw.card` payload (set by `parsePost` in P3.0).
 *
 * Path B — bare X Article URL (`x.com/i/article/<id>` or
 * `x.com/<handle>/articles/<id>`): not directly fetchable via the
 * thread route (the URL isn't a /status/). P3.0 surfaces a clear error
 * pointing the caller at the tweet URL or at `cardData`. Wiring this up
 * properly is a deferred enhancement (P3.1+ may add a dedicated SSR or
 * Playwright path; for P3.0 the orchestrator works via the tweet-URL
 * route + the future `--articles` flag).
 *
 * Returns the raw `tweet.card` sub-object suitable for `parseXArticle`.
 * Throws when no card is recoverable.
 */
async function fetchCardForArticleUrl(url: string): Promise<unknown> {
  // Quick triage — if this is a /status/<id> URL, route via fetchThread.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a parseable URL: ${url}`);
  }
  const isStatusUrl = /\/status\/\d+/.test(parsed.pathname);
  if (!isStatusUrl) {
    throw new Error(
      `P3.0 cannot fetch bare X Article URLs (${url}). Pass the tweet URL that hosts the article (x.com/<handle>/status/<id>) or supply opts.cardData. Full /i/article/<id> support lands in P3.1+.`,
    );
  }

  // Lazy import (see note at the top of this file).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../fetcher/thread.ts') as { fetchThread: FetchThreadFn };
  const result = await mod.fetchThread(url);
  const root = result.thread.rootPost;
  if (!root) {
    throw new Error(`No root post recovered from thread fetch: ${url}`);
  }
  // `parsePost` stashes the card under `raw.card`. Defensive narrowing.
  const raw = root.raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'card' in raw) {
    const card = (raw as { card?: unknown }).card;
    if (card !== undefined) return card;
  }
  throw new Error(`Tweet has no X Article card payload: ${url}`);
}

function finalize(args: {
  url: string;
  canonicalUrl?: string;
  source: ArticleSource;
  body: ArticleBody;
  summary?: string;
  keyPoints: string[];
  crossReferences?: CrossReference[];
  partial: boolean;
  errors: string[];
  cost: ArticleCostBreakdown;
}): ArticleSummary {
  const estimatedCostUsd = round6((args.cost.summarize ?? 0) + (args.cost.crossReference ?? 0));
  logger.debug('article cost', {
    stage: 'total',
    costUsd: estimatedCostUsd,
    breakdown: args.cost,
  });

  // Build with conditional fields so undefined doesn't slip into the
  // emitted JSON. Mirrors the pattern in `intelligence/video.ts`.
  const out: ArticleSummary = {
    url: args.url,
    canonicalUrl: args.canonicalUrl ?? args.url,
    source: args.source,
    body: args.body,
    keyPoints: args.keyPoints,
    crossReferences: args.crossReferences ?? [],
    estimatedCostUsd,
    costBreakdown: args.cost,
    partial: args.partial,
    errors: args.errors,
    generatedAt: new Date().toISOString(),
  };
  if (args.summary) out.summary = args.summary;

  return ArticleSummarySchema.parse(out);
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// Export for unit tests.
export { fetchCardForArticleUrl as _fetchCardForArticleUrl, hashTweetContext as _hashTweetContext };
