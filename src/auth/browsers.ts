/**
 * P1.5.1 — Chromium browser detection.
 *
 * Walks the well-known default-profile cookie DB paths for the Chromium-family
 * browsers we support (Chrome, Brave, Edge) on macOS and returns the subset
 * that are actually installed. Detection means "the `Cookies` SQLite file
 * exists on disk" — that's the only invariant we need before attempting a
 * cookie read in the next module. We deliberately do NOT touch the file
 * (no open/stat-content) so this stays cheap and side-effect free.
 *
 * Linux + Windows paths and keychain services are different in non-trivial
 * ways (libsecret/kwallet, DPAPI) so this module returns an empty array on
 * those platforms in v0.2.0. Spec §10.2 / §10.3 — deferred to v0.3.
 */
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type ChromiumBrowser = {
  /** Internal identifier — stable across releases. */
  name: 'chrome' | 'brave' | 'edge';
  /** Human-readable label for logs / `auth --status` output. */
  displayName: string;
  /** Absolute path to the Default profile's Cookies SQLite DB. */
  cookiesDbPath: string;
  /** macOS Keychain service whose generic-password row holds the AES seed. */
  keychainService: string;
};

/**
 * Detection order matches user preference frequency (Chrome > Brave > Edge in
 * 2026 for Mac dev/researcher audience). The first browser that yields usable
 * X cookies wins in P1.5.2, so this ordering doubles as the escalation order.
 */
export function detectChromiumBrowsers(home: string = homedir()): ChromiumBrowser[] {
  // Linux/Windows support intentionally deferred to v0.3 (different keyring
  // backends + cookie schema variants). Return empty so the P1.5.2 orchestrator
  // skips Tier 1 cleanly and drops to SSR fallback.
  // TODO(v0.3): Linux libsecret/kwallet (~/.config/{google-chrome,...}/Default/Cookies)
  // TODO(v0.3): Windows DPAPI (%LOCALAPPDATA%/Google/Chrome/User Data/Default/Network/Cookies)
  if (platform() !== 'darwin') return [];

  const candidates: ChromiumBrowser[] = [
    {
      name: 'chrome',
      displayName: 'Google Chrome',
      cookiesDbPath: join(home, 'Library/Application Support/Google/Chrome/Default/Cookies'),
      keychainService: 'Chrome Safe Storage',
    },
    {
      name: 'brave',
      displayName: 'Brave',
      cookiesDbPath: join(
        home,
        'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies',
      ),
      keychainService: 'Brave Safe Storage',
    },
    {
      name: 'edge',
      displayName: 'Microsoft Edge',
      cookiesDbPath: join(home, 'Library/Application Support/Microsoft Edge/Default/Cookies'),
      keychainService: 'Microsoft Edge Safe Storage',
    },
  ];

  return candidates.filter((b) => existsSync(b.cookiesDbPath));
}
