import { loginInteractive } from '../../auth/login.ts';
import { closeBrowser } from '../../fetcher/browser.ts';
import { runAuthStatus } from './auth-status.ts';

export type AuthOptions = {
  status?: boolean;
};

export async function authCommand(opts: AuthOptions = {}): Promise<number> {
  if (opts.status) {
    return runAuthStatus();
  }
  try {
    const path = await loginInteractive();
    process.stderr.write(`saved login to ${path}\n`);
    return 0;
  } finally {
    await closeBrowser();
  }
}
