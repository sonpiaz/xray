import { cacheInfo, clearCache, clearProfileCache, closeDb } from '../../cache/index.ts';
import { embedAllCached } from '../../embeddings/index.ts';

export function cacheInfoCommand(): void {
  const info = cacheInfo();
  closeDb();
  const kb = (info.sizeBytes / 1024).toFixed(1);
  const videoMb = (info.video.totalBytes / 1024 / 1024).toFixed(1);
  const embedKb = (info.embeddings.storageBytes / 1024).toFixed(1);
  process.stdout.write(
    `${[
      `path:        ${info.path}`,
      `size:        ${kb} KB`,
      `posts:       ${info.postCount}`,
      `threads:     ${info.threadCount}`,
      `kyma:        ${info.kymaCount}`,
      `video:       ${info.video.transcriptCount} transcripts, ${info.video.visionCount} vision, ${info.video.fileCount} files (${videoMb} MB)`,
      `embeddings:  ${info.embeddings.count} items (${embedKb} KB)`,
    ].join('\n')}\n`,
  );
}

export function cacheClearCommand(opts: { profilesOnly?: boolean } = {}): void {
  if (opts.profilesOnly) {
    clearProfileCache();
    closeDb();
    process.stderr.write('profile cache cleared\n');
    return;
  }
  clearCache();
  process.stderr.write('cache cleared\n');
}

/**
 * P4.0 — `xray cache embed`. Walks every cached source (posts,
 * threads, article bodies) and embeds anything new or whose
 * content_hash has drifted. First run on a fresh install triggers
 * the @xenova MiniLM model download (~23MB, logged via the provider).
 *
 * `--no-resume` forces a full re-embed even when nothing changed.
 * `cac` parses `--no-resume` into `opts.resume === false` (negated
 * flag pattern), so we read `resume` rather than `noResume` here.
 */
export async function cacheEmbedCommand(opts: { resume?: boolean } = {}): Promise<void> {
  const skipExisting = opts.resume !== false; // default true; --no-resume sets resume=false
  const summary = await embedAllCached({ skipExisting });
  const cappedNote =
    summary.commentsCapped > 0
      ? ` (skipped ${summary.commentsCapped} comments past per-thread cap)`
      : '';
  process.stderr.write(
    `embedded ${summary.embedded} items, skipped ${summary.skipped} unchanged, ${summary.candidates} candidates total in ${summary.durationMs}ms${cappedNote}\n`,
  );
}
