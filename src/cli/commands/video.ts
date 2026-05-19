import { writeFileSync } from 'node:fs';
import { closeDb } from '../../cache/db.ts';
import { closeBrowser } from '../../fetcher/browser.ts';
import { type VideoAnalyzeOptions, analyzeVideo } from '../../intelligence/video.ts';
import { renderVideoMarkdown } from '../../render/video-markdown.ts';

export type VideoCmdOptions = {
  json?: boolean;
  output?: string;
  noCache?: boolean;
  raw?: boolean;
  model?: string;
  frames?: number | string;
};

/**
 * P2.3 — Standalone `xray video <url>` command. Calls `analyzeVideo`
 * directly (no thread fetch) and renders the resulting `VideoReport` to
 * Markdown or JSON. Closes SQLite + browser handles in `finally` so the
 * process exits cleanly even if the pipeline throws.
 */
export async function videoCommand(url: string, opts: VideoCmdOptions): Promise<void> {
  const analyzeOpts: VideoAnalyzeOptions = {};
  if (opts.noCache) analyzeOpts.noCache = true;
  if (opts.raw) analyzeOpts.raw = true;
  if (opts.model) analyzeOpts.synthesisModel = opts.model;
  if (opts.frames !== undefined) {
    const n = Number(opts.frames);
    if (!Number.isInteger(n) || n < 1 || n > 24) {
      throw new Error(`Invalid --frames: ${opts.frames}. Expected integer in [1, 24].`);
    }
    // Both clamps move together — `analyzeVideo` still enforces its own
    // 4..12 hard floor/ceiling but we let the user steer within that.
    analyzeOpts.minFrames = n;
    analyzeOpts.maxFrames = n;
  }

  try {
    const report = await analyzeVideo(url, analyzeOpts);
    const output = opts.json
      ? JSON.stringify(report, null, 2)
      : renderVideoMarkdown(report, { mode: 'standalone' });
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
