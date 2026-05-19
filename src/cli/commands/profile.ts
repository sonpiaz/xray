/**
 * P4.2 — `xray profile @<handle>` CLI command.
 *
 * Reads cached XRay data for the given X handle and synthesizes a
 * ProfileReport via 3 Kyma calls (topics + expertise, stance, notable
 * quotes + summary). Cached for 24h in `profile_cache`; bypass with
 * `--no-cache`.
 *
 * Always closes the browser + SQLite handles in `finally` so the CLI
 * exits cleanly even on error. The `--fresh N` flag is parsed but
 * currently silently degrades to cache-only (deferred to P5+).
 */
import { writeFileSync } from 'node:fs';
import { closeDb } from '../../cache/db.ts';
import { closeBrowser } from '../../fetcher/browser.ts';
import { type ProfileAnalyzeOptions, analyzeProfile } from '../../intelligence/profile.ts';
import { renderProfileMarkdown } from '../../render/profile-markdown.ts';

export type ProfileCmdOptions = {
  json?: boolean;
  output?: string;
  /** `cac` parses `--no-cache` into `{ cache: false }`, not `{ noCache: true }`. */
  cache?: boolean;
  /** Some callers may still pass camelCase noCache for parity — accept both. */
  noCache?: boolean;
  fresh?: number | string;
  model?: string;
};

export async function profileCommand(handle: string, opts: ProfileCmdOptions): Promise<void> {
  if (!handle || !handle.trim()) {
    throw new Error('profile: handle is required');
  }

  const analyzeOpts: ProfileAnalyzeOptions = {
    handle: handle.trim(),
  };
  // `--no-cache` from cac sets `opts.cache === false`. Also accept the
  // camelCase form for programmatic callers.
  if (opts.cache === false || opts.noCache === true) analyzeOpts.noCache = true;
  if (opts.model) analyzeOpts.synthesisModel = opts.model;
  if (opts.fresh !== undefined) {
    const n = Number(opts.fresh);
    if (!Number.isInteger(n) || n < 1 || n > 50) {
      throw new Error(`Invalid --fresh: ${opts.fresh}. Expected a positive integer in [1, 50].`);
    }
    analyzeOpts.fresh = n;
  }

  try {
    const report = await analyzeProfile(analyzeOpts);
    const output = opts.json ? JSON.stringify(report, null, 2) : renderProfileMarkdown(report);
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
