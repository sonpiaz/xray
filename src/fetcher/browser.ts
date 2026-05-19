import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Browser, type BrowserContext, chromium } from 'playwright';
import type { DecryptedCookie } from '../auth/cookie-reader.ts';
import { loadConfig } from '../core/config.ts';
import { FetchError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';

let browser: Browser | undefined;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  const cfg = loadConfig();
  try {
    browser = await chromium.launch({ headless: cfg.fetcher.headless });
  } catch (err) {
    throw new FetchError(
      'Failed to launch Chromium. Run `bunx playwright install chromium` first.',
      { cause: err },
    );
  }
  return browser;
}

export type ContextMode = 'anon' | 'auth';

export async function newContext(mode: ContextMode): Promise<BrowserContext> {
  const cfg = loadConfig();
  const b = await getBrowser();
  const opts: Parameters<Browser['newContext']>[0] = {
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 1800 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  };
  if (mode === 'auth') {
    if (!existsSync(cfg.fetcher.storageStatePath)) {
      throw new FetchError(
        `No saved login at ${cfg.fetcher.storageStatePath}. Run \`xray auth\` first.`,
      );
    }
    opts.storageState = cfg.fetcher.storageStatePath;
  }
  return b.newContext(opts);
}

/**
 * P1.5.1 — Build a fresh Playwright context seeded with cookies read out of
 * a Chromium browser's keychain-protected SQLite DB. Same UA/viewport/locale
 * as `newContext('anon')` so the X server sees a consistent browser
 * fingerprint regardless of which tier produced the cookies.
 *
 * This helper does NOT wire itself into `fetchThread()` — that's P1.5.2.
 * It's shipped now so the orchestrator (next sub-phase) can call it
 * directly without further changes here.
 */
export async function newContextWithCookies(cookies: DecryptedCookie[]): Promise<BrowserContext> {
  const b = await getBrowser();
  const ctx = await b.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 1800 },
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
  });
  if (cookies.length > 0) {
    await ctx.addCookies(cookies.map(toPlaywrightCookie));
  }
  logger.debug('new playwright context seeded with cookies', { count: cookies.length });
  return ctx;
}

/**
 * Shape `DecryptedCookie` → Playwright `addCookies` parameter. Playwright
 * accepts either `url` OR `(domain, path)`; we set both `domain` and `path`
 * since we have them, and omit `sameSite` when absent so Playwright applies
 * its own default.
 *
 * `expires=-1` (session cookie) maps to omitting the field — Playwright's
 * session-cookie convention.
 */
function toPlaywrightCookie(c: DecryptedCookie): Parameters<BrowserContext['addCookies']>[0][0] {
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(c.expires >= 0 ? { expires: c.expires } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
  };
}

export async function saveStorageState(ctx: BrowserContext): Promise<string> {
  const cfg = loadConfig();
  mkdirSync(dirname(cfg.fetcher.storageStatePath), { recursive: true });
  await ctx.storageState({ path: cfg.fetcher.storageStatePath });
  logger.info('saved login state', { path: cfg.fetcher.storageStatePath });
  return cfg.fetcher.storageStatePath;
}

export async function closeBrowser(): Promise<void> {
  if (browser?.isConnected()) {
    await browser.close();
  }
  browser = undefined;
}
