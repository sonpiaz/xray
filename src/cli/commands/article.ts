/**
 * P3.0 — Standalone `xray article <url>` command.
 *
 * Hands off to `analyzeArticle()` and renders the result as markdown
 * (default) or JSON. Mirrors `video.ts` for shape so the CLI surface
 * stays consistent across analyzers.
 */
import { writeFileSync } from 'node:fs';
import { closeDb } from '../../cache/db.ts';
import { closeBrowser } from '../../fetcher/browser.ts';
import { type ArticleAnalyzeOptions, analyzeArticle } from '../../intelligence/article.ts';
import { renderArticleMarkdown } from '../../render/article-markdown.ts';

export type ArticleCmdOptions = {
  json?: boolean;
  output?: string;
  noCache?: boolean;
  raw?: boolean;
  model?: string;
};

export async function articleCommand(url: string, opts: ArticleCmdOptions): Promise<void> {
  const analyzeOpts: ArticleAnalyzeOptions = { url };
  if (opts.noCache) analyzeOpts.noCache = true;
  if (opts.raw) analyzeOpts.raw = true;
  if (opts.model) analyzeOpts.synthesisModel = opts.model;

  try {
    const summary = await analyzeArticle(analyzeOpts);
    const output = opts.json ? JSON.stringify(summary, null, 2) : renderArticleMarkdown(summary);
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
