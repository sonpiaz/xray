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
};

export async function threadCommand(url: string, opts: ThreadCmdOptions): Promise<void> {
  const research_opts: ResearchOptions = {};
  if (opts.noCache) research_opts.noCache = true;
  if (opts.raw) research_opts.skipAnalysis = true;
  if (opts.mode) {
    if (!['auto', 'anon', 'auth'].includes(opts.mode)) {
      throw new Error(`Invalid --mode: ${opts.mode}. Use auto|anon|auth.`);
    }
    research_opts.mode = opts.mode as FetchMode;
  }

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
