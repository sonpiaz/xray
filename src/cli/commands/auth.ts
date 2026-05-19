import { loginInteractive } from '../../auth/login.ts';
import { closeBrowser } from '../../fetcher/browser.ts';

export async function authCommand(): Promise<void> {
  // login.ts errors if XRAY_HEADLESS is true; nudge users instead of failing silently.
  if (process.env.XRAY_HEADLESS !== 'false') {
    process.env.XRAY_HEADLESS = 'false';
  }
  try {
    const path = await loginInteractive();
    process.stderr.write(`saved login to ${path}\n`);
  } finally {
    await closeBrowser();
  }
}
