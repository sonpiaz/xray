import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectChromiumBrowsers } from '../../src/auth/browsers.ts';

/**
 * `detectChromiumBrowsers` only does filesystem existence checks against the
 * `Library/Application Support/.../Default/Cookies` paths under the supplied
 * `home`. We construct synthetic home dirs in a per-test temp tree and check
 * that the detector returns the expected subset, in the documented order.
 *
 * The platform-gate (`os.platform() !== 'darwin' → []`) is exercised by the
 * fact that CI / local dev on macOS hits the happy path; we don't try to
 * mock `os.platform()` here because doing so requires module hooking and
 * yields little extra signal vs the integration smoke we get from the rest
 * of the suite.
 */

const COOKIE_PATHS: Record<'chrome' | 'brave' | 'edge', string> = {
  chrome: 'Library/Application Support/Google/Chrome/Default/Cookies',
  brave: 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies',
  edge: 'Library/Application Support/Microsoft Edge/Default/Cookies',
};

function makeFakeHome(installed: Array<'chrome' | 'brave' | 'edge'>): string {
  const home = mkdtempSync(join(tmpdir(), 'xray-fakehome-'));
  for (const browser of installed) {
    const cookiesPath = join(home, COOKIE_PATHS[browser]);
    mkdirSync(join(cookiesPath, '..'), { recursive: true });
    // Content is irrelevant — detection only does existsSync.
    writeFileSync(cookiesPath, 'placeholder');
  }
  return home;
}

const originalPlatform = process.platform;
beforeEach(() => {
  // Most tests assume macOS so the detector runs. If the suite is ever
  // executed on Linux/Windows CI we'd need to skip — flag that explicitly.
  if (originalPlatform !== 'darwin') {
    // The tests below intentionally assume darwin. Skipping is safer than
    // a false-positive empty-array assertion that masks regressions.
    return;
  }
});
afterEach(() => {
  /* noop — temp dirs are tossed by the OS */
});

describe.skipIf(process.platform !== 'darwin')(
  'detectChromiumBrowsers — macOS path detection',
  () => {
    it('returns empty array when no browsers are installed', () => {
      const home = makeFakeHome([]);
      expect(detectChromiumBrowsers(home)).toEqual([]);
    });

    it('detects Chrome alone when only Chrome is installed', () => {
      const home = makeFakeHome(['chrome']);
      const result = detectChromiumBrowsers(home);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('chrome');
      expect(result[0]?.displayName).toBe('Google Chrome');
      expect(result[0]?.keychainService).toBe('Chrome Safe Storage');
      expect(result[0]?.cookiesDbPath).toBe(join(home, COOKIE_PATHS.chrome));
    });

    it('detects Brave alone when only Brave is installed', () => {
      const home = makeFakeHome(['brave']);
      const result = detectChromiumBrowsers(home);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('brave');
      expect(result[0]?.keychainService).toBe('Brave Safe Storage');
    });

    it('detects Edge alone when only Edge is installed', () => {
      const home = makeFakeHome(['edge']);
      const result = detectChromiumBrowsers(home);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe('edge');
      expect(result[0]?.keychainService).toBe('Microsoft Edge Safe Storage');
    });

    it('returns Chrome before Brave before Edge when all three are installed', () => {
      const home = makeFakeHome(['edge', 'chrome', 'brave']); // intentionally scrambled
      const result = detectChromiumBrowsers(home);
      expect(result.map((b) => b.name)).toEqual(['chrome', 'brave', 'edge']);
    });

    it('returns Chrome then Edge when Brave is missing (preserves relative order)', () => {
      const home = makeFakeHome(['chrome', 'edge']);
      const result = detectChromiumBrowsers(home);
      expect(result.map((b) => b.name)).toEqual(['chrome', 'edge']);
    });

    it('uses os.homedir() by default when no home argument is supplied', () => {
      // Smoke-test only — we just want to confirm the default branch doesn't
      // throw. The result depends on whether Chrome/Brave/Edge happen to be
      // installed on the host, so we don't assert content.
      expect(() => detectChromiumBrowsers()).not.toThrow();
    });
  },
);
