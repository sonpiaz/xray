import { getCachedThread } from '../cache/threads.ts';
import { loadConfig } from '../core/config.ts';
import { logger } from '../core/logger.ts';
import { type FetchMode, fetchThread } from '../fetcher/thread.ts';
import { parseXUrl } from '../fetcher/url.ts';
import { analyzeThread } from '../kyma/analyze.ts';
import type { ResearchReport } from '../models/report.ts';
import type { XThread } from '../models/thread.ts';

export type ResearchOptions = {
  mode?: FetchMode;
  noCache?: boolean;
  skipAnalysis?: boolean;
};

export async function research(url: string, opts: ResearchOptions = {}): Promise<ResearchReport> {
  const cfg = loadConfig();
  const parsed = parseXUrl(url);

  let thread: XThread | undefined;
  let cacheHit = false;
  if (!opts.noCache) {
    thread = getCachedThread(parsed.id);
    if (thread) {
      cacheHit = true;
      logger.debug('thread cache hit', { id: parsed.id });
    }
  }
  if (!thread) {
    const fetchOpts: { mode?: FetchMode } = {};
    if (opts.mode !== undefined) fetchOpts.mode = opts.mode;
    thread = await fetchThread(parsed.canonical, fetchOpts);
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
      warnings: cfg.kyma.key
        ? []
        : ['KYMA_API_KEY not set — returning raw thread without analysis.'],
    };
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
    warnings: thread.partial && thread.partialReason ? [`Partial: ${thread.partialReason}`] : [],
  };
}
