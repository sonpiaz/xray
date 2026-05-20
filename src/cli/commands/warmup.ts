/**
 * P5.1 — `xray warmup` — preheat heavy resources so a first real command
 * (`xray thread`, `xray search`) doesn't pay the cold-start tax in front
 * of the user.
 *
 * Pipeline (best-effort: each step swallows its own error so a downstream
 * failure doesn't mask the upstream success the user already cares about):
 *   1. MiniLM embedding model bootstrap — first run downloads ~23MB,
 *      subsequent runs hit the @xenova on-disk cache and take <1s.
 *   2. Playwright Chromium launch — first run pays the bin load tax;
 *      subsequent runs benefit from OS file-system cache. We close the
 *      browser immediately because warmup is preheat, not active session.
 *   3. SQLite cache open + close — forces the table-creation migrations to
 *      run if the db file is fresh.
 *
 * `--json` swaps the human summary for a structured object.
 */
import { logger } from '../../core/logger.ts';
import { getEmbedder } from '../../embeddings/provider.ts';
import { closeBrowser, getBrowser } from '../../fetcher/browser.ts';

// Lazy-import the bun:sqlite-backed db module so Vitest (Node-based) can
// load this file in unit tests without pulling in the Bun-only sqlite
// binding. Mirrors the pattern in src/cache/kyma.ts.
type DbModule = typeof import('../../cache/db.ts');
let dbMod: DbModule | undefined;
async function loadDbModule(): Promise<DbModule> {
  if (dbMod) return dbMod;
  dbMod = await import('../../cache/db.ts');
  return dbMod;
}

export type WarmupOptions = {
  json?: boolean;
};

export type WarmupResult = {
  totalDurationMs: number;
  embedding: { durationMs: number; ready: boolean; error?: string };
  playwright: { durationMs: number; ready: boolean; error?: string };
  sqlite: { durationMs: number; ready: boolean; error?: string };
};

/**
 * Test seam — swap the heavy dependencies so warmup tests can stub the
 * embedder / browser / db without paying the real cold-start cost.
 */
export const _warmupDeps = {
  getEmbedder,
  getBrowser,
  closeBrowser,
  openDb: async (): Promise<unknown> => {
    const mod = await loadDbModule();
    return mod.getDb();
  },
  closeDb: async (): Promise<void> => {
    const mod = await loadDbModule();
    mod.closeDb();
  },
};

async function timeIt<T>(
  fn: () => Promise<T>,
): Promise<{ result?: T; error?: unknown; durationMs: number }> {
  const start = Date.now();
  try {
    const result = await fn();
    return { result, durationMs: Date.now() - start };
  } catch (error) {
    return { error, durationMs: Date.now() - start };
  }
}

function shortErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function runWarmup(): Promise<WarmupResult> {
  const t0 = Date.now();

  // Step 1 — embedding model. First run downloads, subsequent runs load from cache.
  logger.debug('warmup: embedding model');
  const embed = await timeIt(() => _warmupDeps.getEmbedder());

  // Step 2 — Playwright Chromium. Launch and close immediately.
  logger.debug('warmup: playwright chromium');
  const browser = await timeIt(() => _warmupDeps.getBrowser());
  if (browser.result) {
    // Close the singleton so we don't leak a handle. The next real command
    // re-launches, but the binary is now warm in OS file cache.
    await _warmupDeps.closeBrowser().catch(() => undefined);
  }

  // Step 3 — SQLite cache open + close.
  logger.debug('warmup: sqlite cache');
  const db = await timeIt(() => _warmupDeps.openDb());
  await _warmupDeps.closeDb().catch(() => undefined);

  return {
    totalDurationMs: Date.now() - t0,
    embedding: {
      durationMs: embed.durationMs,
      ready: embed.error === undefined,
      ...(embed.error ? { error: shortErr(embed.error) } : {}),
    },
    playwright: {
      durationMs: browser.durationMs,
      ready: browser.error === undefined,
      ...(browser.error ? { error: shortErr(browser.error) } : {}),
    },
    sqlite: {
      durationMs: db.durationMs,
      ready: db.error === undefined,
      ...(db.error ? { error: shortErr(db.error) } : {}),
    },
  };
}

export async function warmupCommand(opts: WarmupOptions = {}): Promise<void> {
  const result = await runWarmup();

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const lines: string[] = [];
  lines.push(`xray warmup completed in ${result.totalDurationMs}ms`);
  lines.push(
    `  - embedding model: ${result.embedding.ready ? `ready in ${result.embedding.durationMs}ms` : `FAILED (${result.embedding.error ?? 'unknown'})`}`,
  );
  lines.push(
    `  - playwright chromium: ${result.playwright.ready ? `ready in ${result.playwright.durationMs}ms` : `FAILED (${result.playwright.error ?? 'unknown'})`}`,
  );
  lines.push(
    `  - sqlite cache: ${result.sqlite.ready ? 'ready' : `FAILED (${result.sqlite.error ?? 'unknown'})`}`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}
