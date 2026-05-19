/**
 * P4.1 — Standalone `xray search <query>` command.
 *
 * Embeds the query with the local MiniLM provider, scores it against
 * every embedded cache row, then renders Markdown (default) or JSON.
 * Always closes the browser + SQLite handles in `finally` so the
 * process exits cleanly even on errors.
 *
 * Validates `--type` against the four enum values up-front so the
 * orchestrator never sees a bogus filter.
 */
import { writeFileSync } from 'node:fs';
import { closeDb } from '../../cache/db.ts';
import { closeBrowser } from '../../fetcher/browser.ts';
import { renderSearchMarkdown } from '../../render/search-markdown.ts';
import { type SearchOptions, search } from '../../search/search.ts';

export type SearchCmdOptions = {
  json?: boolean;
  output?: string;
  limit?: number | string;
  threshold?: number | string;
  type?: string;
  rerank?: boolean;
  model?: string;
};

const VALID_TYPES = new Set(['comment', 'post', 'thread', 'article-passage']);

export async function searchCommand(query: string, opts: SearchCmdOptions): Promise<void> {
  if (!query || !query.trim()) {
    throw new Error('search: query must be a non-empty string');
  }

  const searchOpts: SearchOptions = { query };

  if (opts.limit !== undefined) {
    const n = Number(opts.limit);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`Invalid --limit: ${opts.limit}. Expected a positive integer.`);
    }
    searchOpts.limit = n;
  }
  if (opts.threshold !== undefined) {
    const n = Number(opts.threshold);
    if (!Number.isFinite(n) || n < -1 || n > 1) {
      throw new Error(`Invalid --threshold: ${opts.threshold}. Expected a number in [-1, 1].`);
    }
    searchOpts.threshold = n;
  }
  if (opts.type !== undefined) {
    if (!VALID_TYPES.has(opts.type)) {
      throw new Error(
        `Invalid --type: ${opts.type}. Expected one of: ${[...VALID_TYPES].join(', ')}.`,
      );
    }
    searchOpts.typeFilter = opts.type as SearchOptions['typeFilter'];
  }
  if (opts.rerank) searchOpts.rerank = true;
  if (opts.model) searchOpts.rerankModel = opts.model;

  try {
    const response = await search(searchOpts);
    const output = opts.json ? JSON.stringify(response, null, 2) : renderSearchMarkdown(response);
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
