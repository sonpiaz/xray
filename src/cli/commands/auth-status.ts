/**
 * P1.5.3 — `xray auth --status` diagnostic.
 *
 * Reports which auth sources the 3-tier escalation orchestrator (spec §4)
 * would have available right now, in the same order it would try them:
 *
 *   Tier 1 — Cookie+Playwright: per browser, count x.com / twitter.com
 *            cookie rows from the on-disk SQLite DB.
 *   Tier 2 — SSR: always available — no preconditions.
 *   Tier 3 — Saved Auth: presence + mtime of `storageState.json`.
 *
 * Privacy invariant: this handler MUST NOT trigger a macOS Keychain
 * prompt. Status checks pop a system dialog → privacy/UX violation per
 * [[feedback_invisible_auth_escalation]]. The implementation therefore
 * opens the Cookies DB read-only and only counts rows — no decrypt, no
 * Keychain access. The row count is sufficient to tell the user "there's
 * X session data here that the cookie tier would attempt to use" without
 * ever derefencing the encrypted blob.
 *
 * Exits 0 when at least Tier 2 (SSR) is usable, which is effectively
 * always — SSR has no preconditions. Exits 1 only if a future refactor
 * breaks SSR availability detection.
 */
import { existsSync, statSync } from 'node:fs';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ChromiumBrowser, detectChromiumBrowsers } from '../../auth/browsers.ts';
import { loadConfig } from '../../core/config.ts';
import { logger } from '../../core/logger.ts';

/** Per-browser status row in the Tier 1 section. */
export type BrowserStatus = {
  browser: ChromiumBrowser;
  /** True iff the Cookies DB file exists at the detected path. */
  dbExists: boolean;
  /**
   * Number of rows in the cookies table matching `%x.com` / `%twitter.com`
   * host_keys. `undefined` when the DB couldn't be read (locked + copy
   * failed, corrupted, schema mismatch). Counted without decrypting.
   */
  xRowCount: number | undefined;
  /** Set when xRowCount is undefined — short reason string for the report. */
  readError?: string;
};

export type AuthStatusReport = {
  /** Detection order: Chrome → Brave → Edge. */
  browsers: BrowserStatus[];
  /** Tier 2 is always usable — surfaced as a field for symmetry + future-proofing. */
  ssrAvailable: boolean;
  /** Tier 3: saved storageState.json. */
  storageStatePath: string;
  storageStateExists: boolean;
  /** ISO timestamp of storageState.json mtime when it exists. */
  storageStateMtime?: string;
  /**
   * Highest-quality tier currently usable. Picks the tier the orchestrator
   * would actually serve traffic from on the next `xray thread <url>`.
   */
  activeTier: 'cookie' | 'ssr' | 'auth' | 'none';
};

/**
 * P1.5.3 — Test seam mirroring `_orchestratorDeps` from `fetcher/thread.ts`.
 * Unit tests assign mock implementations before invoking
 * `runAuthStatus()` to avoid touching real browsers / SQLite / filesystem.
 *
 * `countXCookieRows` is intentionally separate from `detectChromiumBrowsers`
 * because the row count is the only "side effect" of the status check —
 * everything else is metadata derived from path constants.
 */
export const _authStatusDeps = {
  detectChromiumBrowsers,
  countXCookieRows: countXCookieRowsImpl,
  existsSync,
  statSync,
};

/**
 * Build the structured report. Pure logic — no stdout writes. Exposed for
 * unit tests so they can assert on the report shape without parsing
 * formatted output.
 */
export async function buildAuthStatusReport(): Promise<AuthStatusReport> {
  const cfg = loadConfig();
  const browsers = _authStatusDeps.detectChromiumBrowsers();

  const browserStatuses: BrowserStatus[] = [];
  let anyCookies = false;
  for (const browser of browsers) {
    const dbExists = _authStatusDeps.existsSync(browser.cookiesDbPath);
    if (!dbExists) {
      browserStatuses.push({ browser, dbExists: false, xRowCount: undefined });
      continue;
    }
    try {
      const count = await _authStatusDeps.countXCookieRows(browser.cookiesDbPath);
      if (count > 0) anyCookies = true;
      browserStatuses.push({ browser, dbExists: true, xRowCount: count });
    } catch (err) {
      browserStatuses.push({
        browser,
        dbExists: true,
        xRowCount: undefined,
        readError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const storageStatePath = cfg.fetcher.storageStatePath;
  const storageStateExists = _authStatusDeps.existsSync(storageStatePath);
  let storageStateMtime: string | undefined;
  if (storageStateExists) {
    try {
      storageStateMtime = _authStatusDeps.statSync(storageStatePath).mtime.toISOString();
    } catch (err) {
      logger.debug('auth --status: storageState stat failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Mirror the orchestrator's tier ordering: cookie > saved-auth > none.
  // SSR is not picked as "active" because in practice it's a fallback —
  // the orchestrator always tries cookie/auth first and only lands on SSR
  // if those are absent. Reporting "active tier: ssr" would mislead the
  // user into thinking SSR is the preferred path.
  let activeTier: AuthStatusReport['activeTier'];
  if (anyCookies) activeTier = 'cookie';
  else if (storageStateExists) activeTier = 'auth';
  else activeTier = 'ssr';

  return {
    browsers: browserStatuses,
    ssrAvailable: true,
    storageStatePath,
    storageStateExists,
    ...(storageStateMtime !== undefined ? { storageStateMtime } : {}),
    activeTier,
  };
}

/** Format the report as the human-readable output emitted to stdout. */
export function formatAuthStatusReport(report: AuthStatusReport): string {
  const lines: string[] = [];
  lines.push('XRay auth status');
  lines.push('');

  // ---- Tier 1 — Cookie+Playwright (PRIMARY) ----
  lines.push('Tier 1 — Cookie+Playwright (PRIMARY)');
  if (report.browsers.length === 0) {
    lines.push(
      '  no Chromium browsers found (Chrome, Brave, Edge). Tier 1 unavailable on this system.',
    );
  } else {
    for (const b of report.browsers) {
      const { browser, dbExists, xRowCount, readError } = b;
      if (!dbExists) {
        lines.push(`  ✗ ${browser.displayName}: Cookies DB not found (${browser.cookiesDbPath})`);
        continue;
      }
      if (xRowCount === undefined) {
        lines.push(
          `  ⚠ ${browser.displayName}: ${browser.cookiesDbPath} — read failed${
            readError ? ` (${readError})` : ''
          }`,
        );
        continue;
      }
      const mark = xRowCount > 0 ? '✓' : '✗';
      const tail = xRowCount > 0 ? `${xRowCount} x.com cookies` : 'no x.com cookies';
      lines.push(`  ${mark} ${browser.displayName}: ${tail} (${browser.cookiesDbPath})`);
    }
  }
  lines.push('');

  // ---- Tier 2 — SSR ----
  lines.push('Tier 2 — SSR Fallback');
  lines.push('  ✓ always available (no setup required, root post only)');
  lines.push('');

  // ---- Tier 3 — Saved Auth ----
  lines.push('Tier 3 — Saved Auth (LAST RESORT)');
  if (report.storageStateExists) {
    lines.push(`  ✓ ${report.storageStatePath}`);
    if (report.storageStateMtime) {
      lines.push(`    last modified: ${report.storageStateMtime}`);
    }
  } else {
    lines.push(
      `  ✗ not configured — run \`xray auth\` to save a login session (${report.storageStatePath})`,
    );
  }
  lines.push('');

  // ---- Summary ----
  const activeLabel =
    report.activeTier === 'cookie'
      ? 'cookie (Tier 1 — Chromium cookies will be injected silently)'
      : report.activeTier === 'auth'
        ? 'auth (Tier 3 — saved storageState.json will be used)'
        : report.activeTier === 'ssr'
          ? 'ssr (Tier 2 — root post only; run `xray auth` for full thread data)'
          : 'none — auth required';
  lines.push(`Active tier: ${activeLabel}`);

  return `${lines.join('\n')}\n`;
}

/**
 * Top-level entry point — called from `auth.ts` when `--status` is set.
 * Returns the exit code so the CLI shell can propagate it. Exit 0 when
 * SSR is available (effectively always); 1 reserved for the future case
 * where even SSR availability detection fails.
 */
export async function runAuthStatus(): Promise<number> {
  const report = await buildAuthStatusReport();
  process.stdout.write(formatAuthStatusReport(report));
  return report.ssrAvailable ? 0 : 1;
}

/**
 * Count `x.com` / `twitter.com` rows in a Chromium Cookies DB without
 * decrypting any value. Opens the SQLite file read-only; on a WAL-style
 * lock failure copies the DB (and `-wal`/`-shm` sidecars) into a fresh
 * temp dir and reads from the copy — same fallback pattern as
 * `cookie-reader.ts`'s `openCookiesDbReadonly`. The pattern is duplicated
 * (not extracted) because the cookie reader's helper returns full rows
 * and stays specialized for the decrypt path; the status check needs
 * only `SELECT COUNT(*)`, which is cheap to read independently.
 *
 * Lazy `bun:sqlite` import: vitest runs under Node and can't resolve the
 * `bun:sqlite` specifier at module-load time. Keeping the import inside
 * the function lets the pure formatter and report-builder tests run
 * under Node without triggering the import.
 */
async function countXCookieRowsImpl(dbPath: string): Promise<number> {
  // biome-ignore lint/suspicious/noExplicitAny: Bun module shape, narrowly used
  const sqliteMod: any = await import('bun:sqlite');
  const Database = sqliteMod.Database;
  const SQL =
    "SELECT COUNT(*) AS n FROM cookies WHERE host_key LIKE '%x.com' OR host_key LIKE '%twitter.com'";

  let openPath = dbPath;
  try {
    const db = new Database(openPath, { readonly: true });
    try {
      const row = db.query(SQL).get() as { n: number } | undefined;
      return row?.n ?? 0;
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!/locked|busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(msg)) throw err;

    // Browser is holding a WAL write-lock. Copy DB + sidecars to a fresh
    // temp dir and read from the copy. Read-only, never written back.
    const tempCopyDir = mkdtempSync(join(tmpdir(), 'xray-status-'));
    const copiedPath = join(tempCopyDir, 'Cookies');
    copyFileSync(dbPath, copiedPath);
    for (const suffix of ['-wal', '-shm']) {
      const side = `${dbPath}${suffix}`;
      if (existsSync(side)) {
        copyFileSync(side, `${copiedPath}${suffix}`);
      }
    }
    openPath = copiedPath;
    const db = new Database(openPath, { readonly: true });
    try {
      const row = db.query(SQL).get() as { n: number } | undefined;
      return row?.n ?? 0;
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    }
  }
}
