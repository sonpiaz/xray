import { writeFileSync } from 'node:fs';
import { closeDb } from '../../cache/db.ts';
import { closeBrowser } from '../../fetcher/browser.ts';
import type { FetchMode } from '../../fetcher/thread.ts';
import { type ResearchOptions, research } from '../../intelligence/analyze-thread.ts';
import { renderReportMarkdown } from '../../render/markdown.ts';

export type ThreadCmdOptions = {
  json?: boolean;
  output?: string;
  noCache?: boolean;
  raw?: boolean;
  mode?: string;
  depth?: number | string;
  maxReplies?: number | string;
  deep?: boolean;
  video?: boolean;
  articles?: boolean;
};

export async function threadCommand(url: string, opts: ThreadCmdOptions): Promise<void> {
  const research_opts: ResearchOptions = {};
  if (opts.noCache) research_opts.noCache = true;
  if (opts.raw) research_opts.skipAnalysis = true;
  if (opts.mode) {
    // P1.5.2 — `'anon'` was removed in v0.2.0 (see PHASE_1_5_PLAN.md §6.3).
    // Surface a targeted error instead of a generic "invalid mode" so users
    // upgrading from v0.1.x get the migration path inline.
    if (opts.mode === 'anon') {
      throw new Error(
        '--mode anon was removed in v0.2.0. Use --mode ssr (no auth) or --mode cookie (force cookies).',
      );
    }
    if (!['auto', 'ssr', 'cookie', 'auth'].includes(opts.mode)) {
      throw new Error(`Invalid --mode: ${opts.mode}. Use auto|ssr|cookie|auth.`);
    }
    research_opts.mode = opts.mode as FetchMode;
  }
  if (opts.depth !== undefined) {
    const n = Number(opts.depth);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      throw new Error(`Invalid --depth: ${opts.depth}. Expected integer in [1, 10].`);
    }
    research_opts.depth = n;
  }
  if (opts.maxReplies !== undefined) {
    const n = Number(opts.maxReplies);
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      throw new Error(`Invalid --max-replies: ${opts.maxReplies}. Expected integer in [1, 200].`);
    }
    research_opts.maxReplies = n;
  }
  if (opts.deep) research_opts.deep = true;
  if (opts.video) research_opts.video = true;
  if (opts.articles) research_opts.articles = true;

  try {
    const report = await research(url, research_opts);
    const output = opts.json ? JSON.stringify(report, null, 2) : renderReportMarkdown(report);
    if (opts.output) {
      writeFileSync(opts.output, output);
      process.stderr.write(`wrote ${output.length} bytes to ${opts.output}\n`);
    } else {
      process.stdout.write(`${output}\n`);
    }
  } finally {
    await closeBrowser();
    closeDb();
  }
}
