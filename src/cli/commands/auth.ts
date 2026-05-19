import { loginInteractive } from '../../auth/login.ts';
import { closeBrowser } from '../../fetcher/browser.ts';

export async function authCommand(): Promise<void> {
  try {
    const path = await loginInteractive();
    process.stderr.write(`saved login to ${path}\n`);
  } finally {
    await closeBrowser();
  }
}
