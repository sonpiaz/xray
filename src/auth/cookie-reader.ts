/**
 * P1.5.1 — Chromium cookie reader (macOS).
 *
 * Reads + decrypts X-domain cookies out of a Chromium-family browser's
 * `Cookies` SQLite DB. Designed for the P1.5.2 escalation orchestrator: each
 * helper here is callable in isolation and never persists, logs, or returns
 * cookie values for non-whitelisted names.
 *
 * Layering mirrors `src/fetcher/ssr.ts`:
 *   - `decryptValue` — pure AES-128-CBC + PKCS7 unpad. Testable without any
 *     keychain, sqlite, or filesystem access.
 *   - `mapRowsToCookies` — pure row → DecryptedCookie projection (filtering,
 *     samesite mapping, plaintext vs encrypted branch). Takes injected
 *     decrypt + key fetcher so tests can mock keychain.
 *   - `fetchKeychainPassword` — thin `security(1)` subprocess wrapper. The
 *     only place that touches macOS Keychain.
 *   - `readXCookies` — top-level orchestrator: open sqlite read-only (with
 *     WAL lock fallback via temp copy), run the host-filtered query, then
 *     hand the rows to `mapRowsToCookies`.
 *
 * Privacy invariants (spec §9):
 *   - SQL WHERE clause excludes non-X hosts at the source. Non-X rows never
 *     enter Node memory.
 *   - On top of the SQL filter, a name whitelist drops everything but the
 *     handful of cookies XRay's Playwright path actually uses.
 *   - Cookie VALUES are never written to logs (debug or otherwise) and never
 *     persisted to disk. The decrypted values exist only in the returned
 *     array, which the orchestrator hands straight to `ctx.addCookies(...)`
 *     before letting it go out of scope.
 */
import { spawnSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieDecryptError, KeychainDeniedError } from '../core/errors.ts';
import { logger } from '../core/logger.ts';
import type { ChromiumBrowser } from './browsers.ts';

/**
 * Cookie shape the P1.5.2 orchestrator hands to Playwright's
 * `context.addCookies(...)`. Field names + types match the Playwright
 * `addCookies` parameter object (see `node_modules/playwright-core/types`).
 */
export type DecryptedCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix time in seconds. `-1` for session cookies (no expiry). */
  expires: number;
  sameSite?: 'Strict' | 'Lax' | 'None';
};

/**
 * Raw row shape produced by the Chromium cookie query — keeps the SQLite
 * boundary explicit and lets tests build synthetic inputs without standing
 * up a real DB.
 */
export type ChromiumCookieRow = {
  host_key: string;
  name: string;
  /** Plaintext fallback when `encrypted_value` is empty (very old cookies). */
  value: string;
  /** Either `v10`/`v11` prefixed AES-128-CBC ciphertext, or a zero-length blob. */
  encrypted_value: Buffer;
  path: string;
  /** Chromium's WebKit epoch microseconds since 1601-01-01. */
  expires_utc: number;
  is_secure: 0 | 1 | number;
  is_httponly: 0 | 1 | number;
  /** Chromium internal samesite codes: -1 unspecified, 0 None, 1 Lax, 2 Strict. */
  samesite: number;
};

/**
 * Names XRay actually injects into Playwright. Anything else read from the
 * `Cookies` DB is dropped before decryption so we never even derive plaintext
 * for unused cookies. Spec §9.2 — kept narrow on purpose.
 *
 * NOTE: The task brief proposed a slightly different list
 * (`_twitter_sess`, `lang`); we follow the spec §9.2 wording because that's
 * the document the privacy/threat-model section enforces. `lang` and
 * `_twitter_sess` are not required for GraphQL auth on the modern X stack.
 */
export const X_COOKIE_WHITELIST = new Set([
  'auth_token',
  'ct0',
  'twid',
  'guest_id',
  'guest_id_ads',
  'guest_id_marketing',
]);

const SALT = 'saltysalt';
const PBKDF2_ITERATIONS_MACOS = 1003;
const KEY_LEN = 16;
const AES_BLOCK_SIZE = 16;
const IV = Buffer.alloc(AES_BLOCK_SIZE, 0x20); // 16 bytes of ASCII space

const HOST_FILTER_SQL = [
  'SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite',
  'FROM cookies',
  "WHERE host_key LIKE '%x.com' OR host_key LIKE '%twitter.com'",
].join(' ');

/**
 * Derive the AES-128 key Chromium uses on macOS: PBKDF2-HMAC-SHA1 with a
 * fixed salt and exactly 1003 iterations. The iteration count is part of the
 * Chromium spec — not a tunable. Exported only so tests can build matching
 * encrypted fixtures.
 */
export function deriveAesKey(password: string): Buffer {
  return pbkdf2Sync(password, SALT, PBKDF2_ITERATIONS_MACOS, KEY_LEN, 'sha1');
}

/**
 * Decrypt a single Chromium-encrypted cookie value. Pure function — no I/O.
 *
 * Accepts the raw `encrypted_value` blob as it appears in the SQLite row.
 * Handles:
 *   - `v10` / `v11` prefix (strips 3 bytes before AES-128-CBC + PKCS7 unpad)
 *   - IV is a fixed 16-byte block of ASCII spaces
 *
 * Throws `CookieDecryptError` on malformed input. Callers should catch and
 * skip the row rather than failing the entire read.
 */
export function decryptValue(encrypted: Buffer, key: Buffer): string {
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    throw new CookieDecryptError('decryptValue called with empty buffer');
  }
  if (key.length !== KEY_LEN) {
    throw new CookieDecryptError(
      `decryptValue called with ${key.length}-byte key; expected ${KEY_LEN}`,
    );
  }

  // Modern Chromium encrypts as `v10` || ciphertext (occasionally `v11` on
  // newer Linux DBs). Strip the prefix; everything else is invalid input.
  const prefix = encrypted.subarray(0, 3).toString('ascii');
  if (prefix !== 'v10' && prefix !== 'v11') {
    throw new CookieDecryptError(`unknown cookie encryption prefix: ${JSON.stringify(prefix)}`);
  }
  const ciphertext = encrypted.subarray(3);
  if (ciphertext.length === 0 || ciphertext.length % AES_BLOCK_SIZE !== 0) {
    throw new CookieDecryptError(
      `ciphertext length ${ciphertext.length} is not a positive multiple of ${AES_BLOCK_SIZE}`,
    );
  }

  try {
    const decipher = createDecipheriv('aes-128-cbc', key, IV);
    // Node's auto-padding handles PKCS7 unpad. Leave it on — Chromium pads
    // exactly per spec.
    decipher.setAutoPadding(true);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return stripChromeMacPrefix(plaintext);
  } catch (err) {
    throw new CookieDecryptError('AES-128-CBC decrypt failed', { cause: err });
  }
}

/**
 * Chrome 113+ (`kCookieEncryptionFeature`) prepends a 32-byte SHA-256 of the
 * host_key to the cookie value before AES encryption, as a defence against
 * cookie-value swaps across domains. After decryption the bytes are still
 * there and they look like binary noise to anything downstream.
 *
 * We detect the prefix heuristically: real X cookie values are pure printable
 * ASCII (hex, base64, URL-encoded), so if the first 32 bytes contain ANY byte
 * outside printable ASCII range (0x20-0x7E), they are the MAC and we strip
 * them. Older Chromes without the feature produce pure-ASCII plaintext from
 * the very first byte, and this check is a no-op.
 *
 * Discovered during the first live live `xray thread` against real macOS
 * Chrome cookies on 2026-05-19.
 */
function stripChromeMacPrefix(plaintext: Buffer): string {
  if (plaintext.length <= 32) return plaintext.toString('utf8');
  const head = plaintext.subarray(0, 32);
  for (let i = 0; i < head.length; i++) {
    const b = head[i]!;
    if (b < 0x20 || b > 0x7e) {
      return plaintext.subarray(32).toString('utf8');
    }
  }
  return plaintext.toString('utf8');
}

/**
 * Chromium's internal samesite codes → Playwright's enum. Returns undefined
 * for the "unspecified" code so callers can omit the field entirely
 * (matches Playwright's "no preference" semantic).
 */
export function mapSameSite(code: number): DecryptedCookie['sameSite'] | undefined {
  switch (code) {
    case 0:
      return 'None';
    case 1:
      return 'Lax';
    case 2:
      return 'Strict';
    default:
      return undefined;
  }
}

/**
 * Chromium stores `expires_utc` as microseconds since the WebKit epoch
 * (1601-01-01 UTC). Convert to unix seconds. Session cookies (no expiry) use
 * 0, which we project to Playwright's `-1` convention.
 */
export function chromiumEpochToUnixSeconds(expiresUtc: number): number {
  if (!Number.isFinite(expiresUtc) || expiresUtc <= 0) return -1;
  // Microseconds since 1601-01-01, minus 1601→1970 offset in microseconds.
  const EPOCH_OFFSET_MICROS = 11644473600_000_000;
  const unixMicros = expiresUtc - EPOCH_OFFSET_MICROS;
  if (unixMicros <= 0) return -1;
  return Math.floor(unixMicros / 1_000_000);
}

/**
 * Pure row → DecryptedCookie projection. Takes the encryption key already
 * derived (so tests can pass a known-good key) and applies the name
 * whitelist + decrypt branch. Rows that fail to decrypt are skipped with a
 * debug log (never a value-bearing log).
 *
 * The key is `Buffer | undefined`: when undefined, only plaintext rows pass
 * (used when a browser's keychain entry is missing — we can still read
 * unencrypted legacy cookies).
 */
export function mapRowsToCookies(
  rows: ChromiumCookieRow[],
  key: Buffer | undefined,
): DecryptedCookie[] {
  const out: DecryptedCookie[] = [];
  for (const row of rows) {
    if (!X_COOKIE_WHITELIST.has(row.name)) continue;

    let value: string;
    if (row.encrypted_value && row.encrypted_value.length > 0) {
      if (!key) {
        logger.debug('cookie skipped — encrypted row but no keychain key available', {
          name: row.name,
        });
        continue;
      }
      try {
        value = decryptValue(row.encrypted_value, key);
      } catch (err) {
        // Intentionally do NOT include cookie name in error payload past the
        // debug context. Decrypt errors should be rare; we skip and continue.
        logger.debug('cookie decrypt failed — skipping row', {
          name: row.name,
          reason: err instanceof Error ? err.message : 'unknown',
        });
        continue;
      }
    } else if (row.value && row.value.length > 0) {
      value = row.value;
    } else {
      // Empty cookie — nothing to inject.
      continue;
    }

    const sameSite = mapSameSite(row.samesite);
    const cookie: DecryptedCookie = {
      name: row.name,
      value,
      domain: row.host_key,
      path: row.path || '/',
      secure: Boolean(row.is_secure),
      httpOnly: Boolean(row.is_httponly),
      expires: chromiumEpochToUnixSeconds(row.expires_utc),
      ...(sameSite !== undefined ? { sameSite } : {}),
    };
    out.push(cookie);
  }
  return out;
}

/**
 * Injection point for the macOS Keychain. Production code calls
 * `defaultKeychainFetcher` which shells out to `/usr/bin/security`. Tests
 * pass a fake to exercise denial / decrypt-error paths without prompting.
 *
 * Returning `undefined` means "no key available" (e.g. Keychain item missing
 * but the user has not explicitly denied access). Throwing
 * `KeychainDeniedError` means "user denied" — the orchestrator should not
 * retry this browser.
 */
export type KeychainFetcher = (service: string) => string | undefined;

/**
 * Real macOS Keychain fetcher. Uses `security find-generic-password -w -s "<svc>"`.
 *
 * Exit codes (`security(1)` man page):
 *   - 0 → password printed on stdout (trim trailing newline)
 *   - 44 → item not found
 *   - 51 → user clicked Deny / unsupported access
 *
 * Anything else we treat as denial too — the only safe move is to fall
 * through to the SSR tier.
 */
export const defaultKeychainFetcher: KeychainFetcher = (service) => {
  const proc = spawnSync('/usr/bin/security', ['find-generic-password', '-w', '-s', service], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (proc.status === 0) {
    return proc.stdout.replace(/\r?\n$/, '');
  }
  if (proc.status === 44) {
    // Item-not-found is a legitimate "no key" — distinct from denial.
    logger.debug('keychain item not found', { service });
    return undefined;
  }
  throw new KeychainDeniedError(
    `Keychain access denied for "${service}" (security exit ${proc.status ?? 'null'})`,
    { cause: proc.error ?? undefined },
  );
};

/**
 * Open the Cookies SQLite file read-only. If the live browser is holding a
 * WAL write-lock we fall back to copying the DB (and `-wal`/`-shm`
 * sidecars) into a per-process temp dir and opening the copy. The temp
 * directory is created via `mkdtempSync` so concurrent xray invocations
 * don't collide.
 *
 * Lazy `bun:sqlite` import: vitest runs under Node and can't resolve the
 * `bun:sqlite` specifier at module-load time. By keeping the import inside
 * this function, the pure helpers above (`decryptValue`, `mapRowsToCookies`,
 * etc.) can be tested under Node without triggering the import.
 */
/**
 * `bun:sqlite` returns BLOB columns as JavaScript strings (each byte mapped to
 * a UTF-16 code unit via latin1/binary encoding) rather than `Uint8Array` /
 * `Buffer`. The raw bytes survive the round-trip, but the `Buffer.isBuffer`
 * check in `decryptValue` would reject the string and report "empty buffer".
 * Convert here once so the rest of the pipeline can stay buffer-typed.
 *
 * Discovered during the first live `xray thread` run against real Chrome
 * cookies on 2026-05-19 — 258 raw rows / 0 decrypted before this fix.
 */
function normalizeRow(row: ChromiumCookieRow): ChromiumCookieRow {
  const ev = row.encrypted_value as unknown;
  if (Buffer.isBuffer(ev)) return row;
  if (ev instanceof Uint8Array) {
    return { ...row, encrypted_value: Buffer.from(ev) };
  }
  if (typeof ev === 'string') {
    return { ...row, encrypted_value: Buffer.from(ev, 'binary') };
  }
  // null / undefined → empty buffer; mapRowsToCookies skips empty rows.
  return { ...row, encrypted_value: Buffer.alloc(0) };
}

async function openCookiesDbReadonly(
  dbPath: string,
): Promise<{ rows: ChromiumCookieRow[]; close: () => void }> {
  // Lazy dynamic import keeps Node/vitest from resolving the Bun-only module.
  // biome-ignore lint/suspicious/noExplicitAny: Bun module shape, narrowly used
  const sqliteMod: any = await import('bun:sqlite');
  const Database = sqliteMod.Database;

  let openPath = dbPath;
  let tempCopyDir: string | undefined;
  try {
    const db = new Database(openPath, { readonly: true });
    const rows = (db.query(HOST_FILTER_SQL).all() as ChromiumCookieRow[]).map(normalizeRow);
    return {
      rows,
      close: () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      },
    };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!/locked|busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(msg)) throw err;

    // Browser is holding a WAL write-lock. Copy DB + sidecars to a fresh
    // temp dir and open the copy. We never write back, so this is safe.
    tempCopyDir = mkdtempSync(join(tmpdir(), 'xray-cookies-'));
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
    const rows = (db.query(HOST_FILTER_SQL).all() as ChromiumCookieRow[]).map(normalizeRow);
    return {
      rows,
      close: () => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        // Leave the temp dir alone — OS will reap /tmp. We could rmSync here
        // but the cost of leaving it is negligible and rmSync would complicate
        // the error path with no real benefit.
      },
    };
  }
}

export type ReadXCookiesOptions = {
  /** Override the macOS Keychain fetcher — used by unit tests. */
  keychainFetcher?: KeychainFetcher;
  /**
   * Override the SQLite reader — used by unit tests to skip `bun:sqlite`
   * entirely. When provided, `readXCookies` reads rows from this function
   * instead of opening the on-disk file.
   */
  rowsReader?: (dbPath: string) => Promise<ChromiumCookieRow[]>;
};

/**
 * Top-level cookie read for a single browser. Returns the decrypted,
 * whitelisted X cookies — empty array if nothing usable was found.
 *
 * Errors:
 *   - `KeychainDeniedError` — user explicitly denied Keychain access for this
 *     browser. Orchestrator should skip this browser, NOT prompt again.
 *   - Any other thrown error is a hard fault (e.g. SQLite corruption). The
 *     orchestrator may log and fall through.
 *
 * The function NEVER throws for "no X cookies in DB" or "all rows failed to
 * decrypt" — both produce an empty array so the orchestrator can transition
 * cleanly to SSR fallback.
 */
export async function readXCookies(
  browser: ChromiumBrowser,
  opts: ReadXCookiesOptions = {},
): Promise<DecryptedCookie[]> {
  const keychainFetcher = opts.keychainFetcher ?? defaultKeychainFetcher;

  // Fetch the AES seed first — if the user denies Keychain access we want to
  // fail fast before touching the SQLite file.
  const password = keychainFetcher(browser.keychainService);
  const key = password !== undefined ? deriveAesKey(password) : undefined;

  let rows: ChromiumCookieRow[];
  let close: (() => void) | undefined;
  if (opts.rowsReader) {
    rows = await opts.rowsReader(browser.cookiesDbPath);
  } else {
    const handle = await openCookiesDbReadonly(browser.cookiesDbPath);
    rows = handle.rows;
    close = handle.close;
  }

  try {
    const cookies = mapRowsToCookies(rows, key);
    logger.debug('cookie read complete', {
      browser: browser.name,
      rawRows: rows.length,
      whitelistedDecrypted: cookies.length,
    });
    return cookies;
  } finally {
    close?.();
  }
}
