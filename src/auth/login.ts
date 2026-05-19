import { loadConfig } from '../core/config.ts';
import { FetchError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import { newContext, saveStorageState } from '../fetcher/browser.ts';

/**
 * Open a non-headless browser to x.com/login, let the user sign in manually,
 * then persist the storage state to ~/.xray/storageState.json.
 */
export async function loginInteractive(): Promise<string> {
  const cfg = loadConfig();
  if (cfg.fetcher.headless) {
    throw new FetchError(
      'Interactive login requires a visible browser. Set XRAY_HEADLESS=false and try again.',
    );
  }

  const ctx = await newContext('anon');
  const page = await ctx.newPage();
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  logger.info('Sign in to X in the opened browser. The CLI will detect login and save cookies.');

  // Wait for navigation to home or any URL where the user is recognized.
  // We poll for cookies that only set after auth.
  const start = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes
  while (Date.now() - start < timeout) {
    await page.waitForTimeout(2000);
    const cookies = await ctx.cookies();
    const hasAuth = cookies.some((c) => c.name === 'auth_token' && c.value.length > 10);
    if (hasAuth) break;
  }

  const cookies = await ctx.cookies();
  if (!cookies.some((c) => c.name === 'auth_token')) {
    await ctx.close();
    throw new FetchError('Did not detect a successful X login within 5 minutes.');
  }

  const path = await saveStorageState(ctx);
  await ctx.close();
  return path;
}
