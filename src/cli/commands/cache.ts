import { cacheInfo, clearCache, closeDb } from '../../cache/index.ts';

export function cacheInfoCommand(): void {
  const info = cacheInfo();
  closeDb();
  const kb = (info.sizeBytes / 1024).toFixed(1);
  process.stdout.write(
    `${[
      `path:    ${info.path}`,
      `size:    ${kb} KB`,
      `posts:   ${info.postCount}`,
      `threads: ${info.threadCount}`,
      `kyma:    ${info.kymaCount}`,
    ].join('\n')}\n`,
  );
}

export function cacheClearCommand(): void {
  clearCache();
  process.stderr.write('cache cleared\n');
}
