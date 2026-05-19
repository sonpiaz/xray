import { getCachedThread } from '../cache/threads.ts';
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { type FetchMode, type FetchOptions, fetchThread } from '../fetcher/thread.ts';
import { parseXUrl } from '../fetcher/url.ts';
import { analyzeThread } from '../kyma/analyze.ts';
import type { ShallowAnalysisDigest } from '../kyma/prompts.ts';
import type { XMedia } from '../models/media.ts';
import type { XPost } from '../models/post.ts';
import type { ResearchReport, StanceDistribution, ThreadCoverage } from '../models/report.ts';
import type { XThread } from '../models/thread.ts';
import type { VideoReport } from '../models/video-report.ts';
import { classifyComments, computeStanceDistribution } from './classify.ts';
import { deepAnalyze } from './deep.ts';
import { analyzeVideo } from './video.ts';

/** Defensive cap so a 10-video thread doesn't burn $5+ silently. */
const MAX_VIDEOS_PER_THREAD = 3;

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
  };
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
