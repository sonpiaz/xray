import { getCachedThread } from '../cache/threads.ts';
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { type FetchMode, type FetchOptions, fetchThread } from '../fetcher/thread.ts';
import { parseXUrl } from '../fetcher/url.ts';
import { analyzeThread } from '../kyma/analyze.ts';
import type { ResearchReport, StanceDistribution, ThreadCoverage } from '../models/report.ts';
import type { XThread } from '../models/thread.ts';
import { classifyComments, computeStanceDistribution } from './classify.ts';

export type ResearchOptions = {
  mode?: FetchMode;
  noCache?: boolean;
  skipAnalysis?: boolean;
  // P1.0 additions
  depth?: number;
  maxReplies?: number;
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
  };
}
