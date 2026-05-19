import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig } from '../core/config.ts';
import { FetchError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { launchHeadedAuthBrowser } from '../fetcher/browser.ts';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

/**
 * Open a non-headless browser to x.com/login, let the user sign in manually,
 * then persist the storage state to ~/.xray/storageState.json.
 *
 * Uses an ISOLATED browser instance (not the fetch singleton) so the fetch
 * path stays headless forever regardless of when/whether the user runs
 * `xray auth` interactively.
 */
export async function loginInteractive(): Promise<string> {
  const cfg = loadConfig();
  if (cfg.fetcher.headless) {
    throw new FetchError(
      'Interactive login requires a visible browser. Set XRAY_HEADLESS=false and try again.',
    );
  }

  const browser = await launchHeadedAuthBrowser();
  try {
    const ctx = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 1800 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles',
    });
    const page = await ctx.newPage();
    await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

    logger.info('Sign in to X in the opened browser. The CLI will detect login and save cookies.');

    const start = Date.now();
    const timeout = 5 * 60 * 1000;
    while (Date.now() - start < timeout) {
      await page.waitForTimeout(2000);
      const cookies = await ctx.cookies();
      const hasAuth = cookies.some((c) => c.name === 'auth_token' && c.value.length > 10);
      if (hasAuth) break;
    }

    const cookies = await ctx.cookies();
    if (!cookies.some((c) => c.name === 'auth_token')) {
      throw new FetchError('Did not detect a successful X login within 5 minutes.');
    }

    mkdirSync(dirname(cfg.fetcher.storageStatePath), { recursive: true });
    await ctx.storageState({ path: cfg.fetcher.storageStatePath });
    logger.info('saved login state', { path: cfg.fetcher.storageStatePath });
    return cfg.fetcher.storageStatePath;
  } finally {
    await browser.close();
  }
}
