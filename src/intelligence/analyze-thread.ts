import { getCachedThread } from '../cache/threads.ts';
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { type FetchMode, type FetchOptions, fetchThread } from '../fetcher/thread.ts';
import { parseXUrl } from '../fetcher/url.ts';
import { analyzeThread } from '../kyma/analyze.ts';
import type { ShallowAnalysisDigest } from '../kyma/prompts.ts';
import type { ArticleSummary } from '../models/article.ts';
import type { XMedia } from '../models/media.ts';
import type { XPost } from '../models/post.ts';
import type { ResearchReport, StanceDistribution, ThreadCoverage } from '../models/report.ts';
import type { XThread } from '../models/thread.ts';
import type { VideoReport } from '../models/video-report.ts';
import { analyzeArticle } from './article.ts';
import { classifyComments, computeStanceDistribution } from './classify.ts';
import { deepAnalyze } from './deep.ts';
import { analyzeVideo } from './video.ts';

/** Defensive cap so a 10-video thread doesn't burn $5+ silently. */
const MAX_VIDEOS_PER_THREAD = 3;

/**
 * P3.2 — Defensive cap on linked articles per `--articles` thread run.
 * Higher than video (3) because articles are cheaper per-call, but still
 * bounded so a link-heavy thread doesn't burn $1+ silently. Spec §15
 * (Risks: Cost without caps at full scope).
 */
const MAX_ARTICLES_PER_THREAD = 5;

export type ResearchOptions = {
  mode?: FetchMode;
  noCache?: boolean;
  skipAnalysis?: boolean;
  // P1.0 additions
  depth?: number;
  maxReplies?: number;
  // P1.3 — when true, runs per-subtree Kyma calls + a synthesis call ON TOP OF
  // the shallow analyze pass. Default false preserves Phase 0/P1.1/P1.2 behavior.
  deep?: boolean;
  // P2.3 — when true, scan rootPost + authorPosts for `type === 'video'`
  // media entries and run the video pipeline on each. Capped at
  // MAX_VIDEOS_PER_THREAD. Comments are not scanned (too expensive).
  // Failures degrade into warnings; the rest of the report still ships.
  video?: boolean;
  // P3.2 — when true, scan rootPost + authorPosts for external links +
  // X Article cards, then run the article pipeline (fetch → summarize →
  // cross-reference) on each. Capped at MAX_ARTICLES_PER_THREAD.
  // Comments are not scanned (cost). Failures per article degrade into
  // warnings; the rest of the report still ships.
  articles?: boolean;
};

/**
 * P3.2 — A single article candidate produced by `collectArticleCandidates`.
 * Stores the URL plus an optional `cardData` payload when the candidate
 * came from an X Article tweet card (lets the orchestrator skip a
 * redundant network round-trip).
 */
export type ArticleCandidate = {
  url: string;
  source: 'x-article' | 'external-html';
  cardData?: unknown;
};

export async function research(url: string, opts: ResearchOptions = {}): Promise<ResearchReport> {
  const cfg = loadConfig();
  const parsed = parseXUrl(url);

  let thread: XThread | undefined;
  let coverage: ThreadCoverage | undefined;
  let cacheHit = false;
  if (!opts.noCache) {
    thread = getCachedThread(parsed.id);
    if (thread) {
      cacheHit = true;
      logger.debug('thread cache hit', { id: parsed.id });
      // v1.0.1 — synthesize a minimal coverage record on cache hits.
      // The cache stores `XThread` only (not the original `ThreadCoverage`
      // from `fetchThread`), so v1.0.0 dropped `report.coverage` entirely
      // whenever the thread was served from cache (even though
      // classification + the report-level fields still ran). We can't
      // reconstruct the original target/achieved depth + cursor list
      // without the raw fetch, so this synthesized record is intentionally
      // conservative — fetchedReplies derives from the cached
      // `thread.comments.length`, status carries thread.partial, and
      // classifiedReplies is filled in by the classification step below.
      coverage = {
        targetDepth: opts.depth ?? 0,
        achievedDepth: 0,
        targetReplies: opts.maxReplies ?? thread.comments.length,
        fetchedReplies: thread.comments.length,
        classifiedReplies: 0,
        paginationCursors: [],
        status: thread.partial ? 'partial' : 'ok',
        ...(thread.partial && thread.partialReason ? { failureReason: thread.partialReason } : {}),
      };
    }
  }
  if (!thread) {
    const fetchOpts: FetchOptions = {};
    if (opts.mode !== undefined) fetchOpts.mode = opts.mode;
    if (opts.depth !== undefined) fetchOpts.depth = opts.depth;
    if (opts.maxReplies !== undefined) fetchOpts.maxReplies = opts.maxReplies;
    const result = await fetchThread(parsed.canonical, fetchOpts);
    thread = result.thread;
    if (result.coverage) {
      coverage = {
        targetDepth: result.coverage.targetDepth,
        achievedDepth: result.coverage.achievedDepth,
        targetReplies: result.coverage.targetReplies,
        fetchedReplies: result.coverage.fetchedReplies,
        classifiedReplies: 0,
        paginationCursors: result.coverage.paginationCursors,
        status: result.coverage.status,
        ...(result.coverage.failureReason !== undefined
          ? { failureReason: result.coverage.failureReason }
          : {}),
        // P1.5.2 — propagate the escalation tier into the report so downstream
        // agents know how the data was obtained.
        ...(result.tier !== undefined ? { tier: result.tier } : {}),
      };
    } else if (result.tier !== undefined) {
      // SSR-only paths skip the Playwright walk entirely (no coverage). Build a
      // minimal coverage record so `report.coverage.tier` is still populated.
      coverage = {
        targetDepth: 0,
        achievedDepth: 0,
        targetReplies: opts.maxReplies ?? 50,
        fetchedReplies: thread.comments.length,
        classifiedReplies: 0,
        paginationCursors: [],
        status: thread.partial ? 'partial' : 'ok',
        tier: result.tier,
      };
    }
  }

  const partialWarnings: string[] = [];
  if (thread.partial && thread.partialReason) {
    partialWarnings.push(`Partial: ${thread.partialReason}`);
  }
  if (coverage && coverage.status === 'partial') {
    partialWarnings.push(
      `Partial: fetched ${coverage.fetchedReplies}/${coverage.targetReplies} target replies (depth ${coverage.achievedDepth}/${coverage.targetDepth})`,
    );
  }

  if (opts.skipAnalysis || !cfg.kyma.key) {
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      source: { url: parsed.canonical, model: 'none', cacheHit },
      thread,
      tldr: thread.rootPost.text.slice(0, 280),
      summary: thread.rootPost.text,
      keyInsights: [],
      notableReplies: [],
      openQuestions: [],
      warnings: [
        ...partialWarnings,
        ...(cfg.kyma.key ? [] : ['KYMA_API_KEY not set — returning raw thread without analysis.']),
      ],
      ...(coverage ? { coverage } : {}),
    };
  }

  // P1.1: classify replies before the thread-level analysis call so that
  // future renderers / downstream consumers can read `comment.classification`
  // off the thread payload that ships back in the report.
  let stanceDistribution: StanceDistribution | undefined;
  if (thread.comments.length > 0) {
    const outcome = await classifyComments(thread);
    if (outcome.classifiedCount > 0) {
      stanceDistribution = computeStanceDistribution(thread);
    }
    if (coverage) {
      coverage = {
        ...coverage,
        classifiedReplies: outcome.classifiedCount,
        prefilterApplied: outcome.prefilterApplied,
        candidatePool: outcome.candidatePool,
        classifiedFromPool: outcome.classifiedFromPool,
      };
    }
    for (const w of outcome.warnings) partialWarnings.push(w);
    logger.debug('classification done', {
      classified: outcome.classifiedCount,
      calls: outcome.callCount,
      prefilterApplied: outcome.prefilterApplied,
      candidatePool: outcome.candidatePool,
    });
  }

  const analysis = await analyzeThread(thread);

  // P1.3: deep mode runs AFTER the shallow analyze so the synthesis call can
  // reference the shallow tldr/summary/insights. Default-off — only fires when
  // `opts.deep === true`. Failures degrade gracefully into warnings; the report
  // still contains the shallow analyze output.
  let subtreeSummaries: import('../models/report.ts').SubtreeSummary[] | undefined;
  let deepSynthesis: import('../models/report.ts').DeepSynthesis | undefined;
  if (opts.deep && thread.comments.length > 0) {
    const shallowDigest: ShallowAnalysisDigest = {
      tldr: analysis.tldr,
      summary: analysis.summary,
      keyInsights: analysis.keyInsights.map((k) => ({
        insight: k.insight,
        confidence: k.confidence,
      })),
      openQuestions: analysis.openQuestions,
      ...(analysis.topic ? { topic: analysis.topic } : {}),
    };
    const deepOutcome = await deepAnalyze(thread, shallowDigest);
    if (deepOutcome.subtreeSummaries.length > 0) {
      subtreeSummaries = deepOutcome.subtreeSummaries;
    }
    if (deepOutcome.deepSynthesis) {
      deepSynthesis = deepOutcome.deepSynthesis;
    }
    for (const w of deepOutcome.warnings) partialWarnings.push(w);
    logger.debug('deep mode done', {
      subtreeCalls: deepOutcome.subtreeCallCount,
      synthesisCalls: deepOutcome.synthesisCallCount,
      summaries: deepOutcome.subtreeSummaries.length,
    });
  }

  // P3.2 — Article pipeline. Runs after analyze so an article failure
  // can't block the text report. Scans rootPost.links + authorPosts[]
  // .links + rootPost.raw (for X Article cards). Comments not scanned.
  let articleSummaries: ArticleSummary[] | undefined;
  if (opts.articles) {
    const candidates = collectArticleCandidates(thread);
    if (candidates.length === 0) {
      logger.debug('articles flag set but no article candidates found on root/author posts');
    } else {
      if (candidates.length > MAX_ARTICLES_PER_THREAD) {
        logger.debug('capping article analysis at MAX_ARTICLES_PER_THREAD', {
          found: candidates.length,
          cap: MAX_ARTICLES_PER_THREAD,
        });
        partialWarnings.push(
          `Found ${candidates.length} articles on this thread; analyzing first ${MAX_ARTICLES_PER_THREAD}.`,
        );
      }
      const slice = candidates.slice(0, MAX_ARTICLES_PER_THREAD);
      const tweetContextText = buildTweetContext(thread);
      const results: ArticleSummary[] = [];
      for (const cand of slice) {
        try {
          const analyzeOpts: Parameters<typeof analyzeArticle>[0] = {
            url: cand.url,
            tweetContext: {
              text: tweetContextText,
              postId: thread.rootPost.id,
            },
          };
          if (opts.noCache) analyzeOpts.noCache = true;
          if (cand.cardData !== undefined) analyzeOpts.cardData = cand.cardData;
          const summary = await analyzeArticle(analyzeOpts);
          results.push(summary);
        } catch (err) {
          const msg = String(err);
          partialWarnings.push(`Article pipeline failed for ${cand.url}: ${msg}`);
          logger.warn('article pipeline failed', { url: cand.url, err: msg });
        }
      }
      if (results.length > 0) articleSummaries = results;
    }
  }

  // P2.3 — Video pipeline. Runs after analyze so a video failure can't
  // block the text report. Scans rootPost.media + authorPosts[].media for
  // type === 'video' (comments not scanned — expensive).
  let videoAnalysis: VideoReport[] | undefined;
  if (opts.video) {
    const candidates = collectVideoCandidates(thread);
    if (candidates.length === 0) {
      logger.debug('video flag set but no video media found on root/author posts');
    } else {
      if (candidates.length > MAX_VIDEOS_PER_THREAD) {
        logger.debug('capping video analysis at MAX_VIDEOS_PER_THREAD', {
          found: candidates.length,
          cap: MAX_VIDEOS_PER_THREAD,
        });
        partialWarnings.push(
          `Found ${candidates.length} videos on this thread; analyzing first ${MAX_VIDEOS_PER_THREAD}.`,
        );
      }
      const slice = candidates.slice(0, MAX_VIDEOS_PER_THREAD);
      const results: VideoReport[] = [];
      for (const media of slice) {
        try {
          const report = await analyzeVideo(
            { url: media.url, mediaHint: media },
            {
              ...(opts.noCache ? { noCache: true } : {}),
            },
          );
          results.push(report);
        } catch (err) {
          const msg = String(err);
          partialWarnings.push(`Video pipeline failed for ${media.url}: ${msg}`);
          logger.warn('video pipeline failed', { url: media.url, err: msg });
        }
      }
      if (results.length > 0) videoAnalysis = results;
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: { url: parsed.canonical, model: analysis.model, cacheHit },
    thread,
    topic: analysis.topic,
    tldr: analysis.tldr,
    summary: analysis.summary,
    keyInsights: analysis.keyInsights,
    notableReplies: analysis.notableReplies,
    openQuestions: analysis.openQuestions,
    warnings: partialWarnings,
    ...(coverage ? { coverage } : {}),
    ...(stanceDistribution ? { stanceDistribution } : {}),
    ...(subtreeSummaries ? { subtreeSummaries } : {}),
    ...(deepSynthesis ? { deepSynthesis } : {}),
    ...(videoAnalysis ? { videoAnalysis } : {}),
    ...(articleSummaries ? { articleSummaries } : {}),
  };
}

/**
 * P3.2 / v1.0.1 — Collect article candidates from rootPost + authorPosts.
 *
 * Three channels (deduped by URL):
 *   1. `post.links[]` — any HTTP(S) URL that classifies as an article
 *      (external-html or x-article).
 *   2. `post.card` — v1.0.1 structured X card field. When `card.url`
 *      points at an X Article (`/i/article/<id>`) the orchestrator can
 *      skip the network round-trip and re-use the in-flight body text.
 *   3. `post.raw.card` — v1.0.0 fallback for cache rows + tests that
 *      stashed the card under `raw.card` before v1.0.1 promoted it to a
 *      typed field.
 *
 * Comments are intentionally NOT scanned (a busy thread can expose
 * 50+ external links and burn $1+ in a single call). De-duplicates by
 * the post's `expandedUrl` (preferred) or `url` field. Cap downstream
 * via MAX_ARTICLES_PER_THREAD.
 *
 * v1.0.1 expands scanning to BOTH rootPost AND authorPosts for the card
 * channels (v1.0.0 only scanned rootPost.raw). Threads where an article
 * is dropped in a 2/N or 3/N follow-up no longer disappear.
 *
 * Exported for unit tests.
 */
export function collectArticleCandidates(thread: XThread): ArticleCandidate[] {
  // Local import — pulled here so the module-load graph doesn't pick up
  // detect.ts in modules that only need analyze-thread for its types.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { detectArticleSource } = require('../article/detect.ts') as {
    detectArticleSource: (url: string) => 'x-article' | 'external-html' | null;
  };

  const posts: XPost[] = [thread.rootPost, ...thread.authorPosts];
  const seen = new Set<string>();
  const out: ArticleCandidate[] = [];

  // Channel 1 — external links on root + author posts.
  for (const p of posts) {
    for (const link of p.links) {
      const target = link.expandedUrl ?? link.url;
      if (!target) continue;
      const src = detectArticleSource(target);
      if (!src) continue;
      if (seen.has(target)) continue;
      seen.add(target);
      out.push({ url: target, source: src });
    }
  }

  // Channel 2 — v1.0.1 structured `XPost.card` (root + author posts).
  // We probe both rootPost AND authorPosts so an article dropped in a
  // 2/N follow-up isn't missed. The card payload carries enough info
  // (URL + optional bodyText) to skip the article-fetch round-trip.
  for (const p of posts) {
    const card = p.card;
    if (!card?.url) continue;
    const src = detectArticleSource(card.url);
    // Card may be a non-article (summary_large_image, video_app, etc.).
    // Honour the detector — only enqueue when the URL classifies.
    if (src !== 'x-article' && src !== 'external-html') continue;
    if (seen.has(card.url)) {
      // Upgrade the existing entry with the card payload so the
      // orchestrator can re-use any pre-extracted body text.
      const existing = out.find((c) => c.url === card.url);
      if (existing && existing.cardData === undefined) existing.cardData = card;
      continue;
    }
    seen.add(card.url);
    out.push({ url: card.url, source: src, cardData: card });
  }

  // Channel 3 — v1.0.0 backward-compat: raw card under `XPost.raw.card`.
  // Older cache rows (and tests written before v1.0.1) stash the card
  // shape here instead of in `XPost.card`. We walk both root + author
  // posts (v1.0.0 only walked root) so we don't silently regress.
  for (const p of posts) {
    const rawCard = extractRawCardLegacy(p);
    if (!rawCard) continue;
    const cardUrl = extractCardUrl(rawCard);
    if (!cardUrl) continue;
    if (seen.has(cardUrl)) {
      const existing = out.find((c) => c.url === cardUrl);
      if (existing && existing.cardData === undefined) existing.cardData = rawCard;
      continue;
    }
    seen.add(cardUrl);
    out.push({ url: cardUrl, source: 'x-article', cardData: rawCard });
  }

  return out;
}

/**
 * v1.0.1 — Walk a post's raw payload looking for the v1.0.0-era `card`
 * sub-object. Returns undefined when the post has no raw, no card, or
 * a non-object card payload.
 */
function extractRawCardLegacy(post: XPost): unknown {
  const raw = post.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (!('card' in raw)) return undefined;
  const card = (raw as { card?: unknown }).card;
  if (!card || typeof card !== 'object' || Array.isArray(card)) return undefined;
  return card;
}

/**
 * Extract the canonical card URL from an X Article card payload. Probes
 * the documented binding key shapes (`card_url`, `url`, `article_url`)
 * in that order and falls through to the card's own `url` field. Returns
 * undefined when nothing usable is present.
 */
function extractCardUrl(card: unknown): string | undefined {
  if (!card || typeof card !== 'object' || Array.isArray(card)) return undefined;
  const co = card as Record<string, unknown>;

  // Direct `card.url`.
  if (typeof co.url === 'string' && co.url.startsWith('http')) return co.url;

  // Walk legacy.binding_values looking for url-shaped entries.
  const legacy = co.legacy;
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return undefined;
  const bindings = (legacy as { binding_values?: unknown }).binding_values;
  if (!Array.isArray(bindings)) return undefined;

  const URL_KEYS = ['card_url', 'url', 'article_url'];
  for (const key of URL_KEYS) {
    for (const b of bindings) {
      if (!b || typeof b !== 'object') continue;
      const bo = b as Record<string, unknown>;
      if (bo.key !== key) continue;
      const value = bo.value;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const sv = (value as { string_value?: unknown }).string_value;
        if (typeof sv === 'string' && sv.startsWith('http')) return sv;
      }
    }
  }
  return undefined;
}

/**
 * Build the tweet thesis text fed into article cross-reference. Joins
 * the root post text with any author follow-up texts (separator: blank
 * line). Caller is responsible for truncation downstream (the
 * cross-reference module caps to TWEET_THESIS_MAX_CHARS).
 *
 * Exported for unit tests.
 */
export function buildTweetContext(thread: XThread): string {
  const parts: string[] = [thread.rootPost.text];
  for (const p of thread.authorPosts) {
    if (p.text) parts.push(p.text);
  }
  return parts.join('\n\n');
}

/**
 * P2.3 — Collect video media URLs from rootPost + authorPosts. Comments
 * are intentionally NOT scanned (a busy thread could expose 50+ videos
 * and burn $5+ in a single call). De-duplicates by URL so a quoted
 * video that appears in both root and follow-up isn't analyzed twice.
 * Exported for unit tests.
 */
export function collectVideoCandidates(thread: XThread): XMedia[] {
  const posts: XPost[] = [thread.rootPost, ...thread.authorPosts];
  const seen = new Set<string>();
  const out: XMedia[] = [];
  for (const p of posts) {
    for (const m of p.media) {
      if (m.type !== 'video') continue;
      if (seen.has(m.url)) continue;
      seen.add(m.url);
      out.push(m);
    }
  }
  return out;
}
