import { createCipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChromiumBrowser } from '../../src/auth/browsers.ts';
import {
  type ChromiumCookieRow,
  X_COOKIE_WHITELIST,
  chromiumEpochToUnixSeconds,
  decryptValue,
  deriveAesKey,
  mapRowsToCookies,
  mapSameSite,
  readXCookies,
} from '../../src/auth/cookie-reader.ts';
import { CookieDecryptError, KeychainDeniedError } from '../../src/core/errors.ts';

/**
 * Fixture builder — encrypts a plaintext exactly the way Chromium does on
 * macOS so the test runs the same code path as a real Chrome cookie row.
 * We deliberately do this here (rather than importing from production code)
 * so a future bug in the encrypt direction can't accidentally also "pass"
 * the decrypt test.
 */
function encryptLikeChromium(plaintext: string, key: Buffer): Buffer {
  const iv = Buffer.alloc(16, 0x20);
  const cipher = createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(true);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), ciphertext]);
}

const KEYCHAIN_PASSWORD = 'mock-keychain-password';
const KEY = deriveAesKey(KEYCHAIN_PASSWORD);

const FAKE_BROWSER: ChromiumBrowser = {
  name: 'chrome',
  displayName: 'Google Chrome',
  cookiesDbPath: '/dev/null/Cookies', // never opened — rowsReader is injected
  keychainService: 'Chrome Safe Storage',
};

function row(over: Partial<ChromiumCookieRow>): ChromiumCookieRow {
  return {
    host_key: '.x.com',
    name: 'auth_token',
    value: '',
    encrypted_value: encryptLikeChromium('synthetic-auth-token', KEY),
    path: '/',
    expires_utc: 0, // session by default
    is_secure: 1,
    is_httponly: 1,
    samesite: -1,
    ...over,
  };
}

describe('deriveAesKey — PBKDF2 with Chromium parameters', () => {
  it('produces a 16-byte key', () => {
    expect(KEY).toBeInstanceOf(Buffer);
    expect(KEY.length).toBe(16);
  });

  it('is deterministic for the same password', () => {
    expect(deriveAesKey(KEYCHAIN_PASSWORD).equals(KEY)).toBe(true);
  });

  it('changes when the password changes', () => {
    expect(deriveAesKey(`${KEYCHAIN_PASSWORD}-different`).equals(KEY)).toBe(false);
  });
});

describe('decryptValue — pure AES-128-CBC round-trip', () => {
  it('decrypts a v10-prefixed payload back to the original plaintext', () => {
    const enc = encryptLikeChromium('hello world', KEY);
    expect(decryptValue(enc, KEY)).toBe('hello world');
  });

  it('handles multi-block plaintexts (PKCS7 padding spanning a block boundary)', () => {
    // 17 bytes → straddles one AES block, exercises padding.
    const longText = 'a'.repeat(17);
    const enc = encryptLikeChromium(longText, KEY);
    expect(decryptValue(enc, KEY)).toBe(longText);
  });

  it('handles a single-byte plaintext (15 bytes of padding)', () => {
    const enc = encryptLikeChromium('x', KEY);
    expect(decryptValue(enc, KEY)).toBe('x');
  });

  it('round-trips unicode payloads', () => {
    const text = 'cốc cốc — utf8';
    const enc = encryptLikeChromium(text, KEY);
    expect(decryptValue(enc, KEY)).toBe(text);
  });

  it('throws CookieDecryptError on an empty buffer', () => {
    expect(() => decryptValue(Buffer.alloc(0), KEY)).toThrow(CookieDecryptError);
  });

  it('throws CookieDecryptError on a wrong-sized key', () => {
    const enc = encryptLikeChromium('hi', KEY);
    expect(() => decryptValue(enc, Buffer.alloc(8))).toThrow(CookieDecryptError);
  });

  it('throws CookieDecryptError on an unknown encryption prefix', () => {
    const garbage = Buffer.concat([Buffer.from('xyz'), Buffer.alloc(16)]);
    expect(() => decryptValue(garbage, KEY)).toThrow(/unknown cookie encryption prefix/);
  });

  it('throws CookieDecryptError on a ciphertext whose length is not a block multiple', () => {
    const malformed = Buffer.concat([Buffer.from('v10'), Buffer.from([1, 2, 3])]);
    expect(() => decryptValue(malformed, KEY)).toThrow(CookieDecryptError);
  });

  it('throws CookieDecryptError when the wrong key is used (PKCS7 unpad fails)', () => {
    const enc = encryptLikeChromium('the original', KEY);
    const wrongKey = deriveAesKey('a different password');
    expect(() => decryptValue(enc, wrongKey)).toThrow(CookieDecryptError);
  });
});

describe('mapSameSite — Chromium samesite codes', () => {
  it('maps 0 → None, 1 → Lax, 2 → Strict', () => {
    expect(mapSameSite(0)).toBe('None');
    expect(mapSameSite(1)).toBe('Lax');
    expect(mapSameSite(2)).toBe('Strict');
  });

  it('returns undefined for the unspecified code (-1)', () => {
    expect(mapSameSite(-1)).toBeUndefined();
  });

  it('returns undefined for any other value', () => {
    expect(mapSameSite(99)).toBeUndefined();
  });
});

describe('chromiumEpochToUnixSeconds — WebKit epoch conversion', () => {
  it('returns -1 for session cookies (expires_utc = 0)', () => {
    expect(chromiumEpochToUnixSeconds(0)).toBe(-1);
  });

  it('returns -1 for negative or non-finite inputs', () => {
    expect(chromiumEpochToUnixSeconds(-1)).toBe(-1);
    expect(chromiumEpochToUnixSeconds(Number.NaN)).toBe(-1);
  });

  it('converts a known 2030-01-01 timestamp to its unix-seconds equivalent', () => {
    // 2030-01-01T00:00:00Z = 1893456000 unix seconds.
    // Chromium stores microseconds since 1601-01-01, so:
    //   1893456000 + 11644473600  = 13537929600 unix-style seconds since WebKit epoch
    //   × 1_000_000                = microseconds value Chromium would write.
    const chromiumMicros = (1893456000 + 11644473600) * 1_000_000;
    expect(chromiumEpochToUnixSeconds(chromiumMicros)).toBe(1893456000);
  });
});

describe('X_COOKIE_WHITELIST — spec §9.2 names only', () => {
  it('contains exactly the six names the spec authorizes', () => {
    expect([...X_COOKIE_WHITELIST].sort()).toEqual(
      ['auth_token', 'ct0', 'guest_id', 'guest_id_ads', 'guest_id_marketing', 'twid'].sort(),
    );
  });
});

describe('mapRowsToCookies — filter + projection', () => {
  it('keeps only whitelisted names; drops marketing/tracking cookies that slipped past the SQL filter', () => {
    const rows = [
      row({ name: 'auth_token' }),
      row({ name: 'ct0' }),
      row({ name: 'lang' }), // not in whitelist
      row({ name: 'personalization_id' }), // not in whitelist
    ];
    const cookies = mapRowsToCookies(rows, KEY);
    expect(cookies.map((c) => c.name).sort()).toEqual(['auth_token', 'ct0']);
  });

  it('decrypts v10 rows correctly and surfaces the plaintext value', () => {
    const rows = [row({ name: 'auth_token', encrypted_value: encryptLikeChromium('SECRET', KEY) })];
    const [cookie] = mapRowsToCookies(rows, KEY);
    expect(cookie?.value).toBe('SECRET');
  });

  it('falls back to the plaintext `value` column when encrypted_value is empty', () => {
    const rows = [
      row({
        name: 'guest_id',
        encrypted_value: Buffer.alloc(0),
        value: 'v1%3A1234567890',
      }),
    ];
    const [cookie] = mapRowsToCookies(rows, KEY);
    expect(cookie?.value).toBe('v1%3A1234567890');
  });

  it('skips rows that fail to decrypt rather than throwing', () => {
    // Build a row whose encrypted_value was made with a *different* key —
    // PKCS7 unpad will reject it during finalization.
    const wrongKey = deriveAesKey('some other password');
    const rows = [
      row({ name: 'auth_token', encrypted_value: encryptLikeChromium('decoy', wrongKey) }),
      row({ name: 'ct0', encrypted_value: encryptLikeChromium('keep-me', KEY) }),
    ];
    const cookies = mapRowsToCookies(rows, KEY);
    expect(cookies.map((c) => c.name)).toEqual(['ct0']);
    expect(cookies[0]?.value).toBe('keep-me');
  });

  it('skips encrypted rows entirely when no key was provided (keychain item missing)', () => {
    const rows = [
      row({ name: 'auth_token', encrypted_value: encryptLikeChromium('SECRET', KEY) }),
      row({ name: 'guest_id', encrypted_value: Buffer.alloc(0), value: 'plain-guest-id' }),
    ];
    const cookies = mapRowsToCookies(rows, undefined);
    expect(cookies.map((c) => c.name)).toEqual(['guest_id']);
  });

  it('maps samesite codes (0/1/2) into the Playwright enum', () => {
    const rows = [
      row({ name: 'auth_token', samesite: 0 }),
      row({ name: 'ct0', samesite: 1 }),
      row({ name: 'twid', samesite: 2 }),
    ];
    const cookies = mapRowsToCookies(rows, KEY);
    const bySameSite = Object.fromEntries(cookies.map((c) => [c.name, c.sameSite]));
    expect(bySameSite.auth_token).toBe('None');
    expect(bySameSite.ct0).toBe('Lax');
    expect(bySameSite.twid).toBe('Strict');
  });

  it('omits the sameSite field when the row carries the unspecified code', () => {
    const rows = [row({ name: 'auth_token', samesite: -1 })];
    const [cookie] = mapRowsToCookies(rows, KEY);
    expect(cookie && 'sameSite' in cookie).toBe(false);
  });

  it('preserves domain / path / secure / httpOnly flags from the source row', () => {
    const rows = [
      row({
        name: 'auth_token',
        host_key: '.twitter.com',
        path: '/some/sub',
        is_secure: 0,
        is_httponly: 0,
      }),
    ];
    const [cookie] = mapRowsToCookies(rows, KEY);
    expect(cookie?.domain).toBe('.twitter.com');
    expect(cookie?.path).toBe('/some/sub');
    expect(cookie?.secure).toBe(false);
    expect(cookie?.httpOnly).toBe(false);
  });

  it('defaults path to "/" when the source row has an empty path', () => {
    const rows = [row({ name: 'auth_token', path: '' })];
    const [cookie] = mapRowsToCookies(rows, KEY);
    expect(cookie?.path).toBe('/');
  });

  it('reports -1 expires for session cookies (expires_utc = 0)', () => {
    const rows = [row({ name: 'auth_token', expires_utc: 0 })];
    const [cookie] = mapRowsToCookies(rows, KEY);
    expect(cookie?.expires).toBe(-1);
  });
});

describe('readXCookies — orchestration with injected keychain + rows reader', () => {
  it('returns whitelisted decrypted cookies when keychain + rows are healthy', async () => {
    const rows = [
      row({ name: 'auth_token', encrypted_value: encryptLikeChromium('TOKEN', KEY) }),
      row({
        name: 'ct0',
        encrypted_value: encryptLikeChromium('CSRF', KEY),
        host_key: 'x.com',
      }),
      row({ name: 'random_marketing', encrypted_value: encryptLikeChromium('drop', KEY) }),
    ];
    const cookies = await readXCookies(FAKE_BROWSER, {
      keychainFetcher: () => KEYCHAIN_PASSWORD,
      rowsReader: async () => rows,
    });
    expect(cookies.map((c) => c.name).sort()).toEqual(['auth_token', 'ct0']);
    expect(cookies.find((c) => c.name === 'auth_token')?.value).toBe('TOKEN');
  });

  it('propagates KeychainDeniedError from the injected fetcher', async () => {
    await expect(
      readXCookies(FAKE_BROWSER, {
        keychainFetcher: () => {
          throw new KeychainDeniedError('user denied');
        },
        rowsReader: async () => [],
      }),
    ).rejects.toThrow(KeychainDeniedError);
  });

  it('returns empty array when the rows reader yields no X cookies', async () => {
    const cookies = await readXCookies(FAKE_BROWSER, {
      keychainFetcher: () => KEYCHAIN_PASSWORD,
      rowsReader: async () => [],
    });
    expect(cookies).toEqual([]);
  });

  it('falls back to plaintext rows when keychain has no key (returns undefined)', async () => {
    const rows = [
      row({ name: 'auth_token', encrypted_value: encryptLikeChromium('lost', KEY) }),
      row({ name: 'guest_id', encrypted_value: Buffer.alloc(0), value: 'plain-id' }),
    ];
    const cookies = await readXCookies(FAKE_BROWSER, {
      keychainFetcher: () => undefined, // keychain item missing, not denied
      rowsReader: async () => rows,
    });
    expect(cookies).toHaveLength(1);
    expect(cookies[0]?.name).toBe('guest_id');
    expect(cookies[0]?.value).toBe('plain-id');
  });

  it('passes the browser cookies DB path through to the rows reader', async () => {
    const reader = vi.fn(async () => [] as ChromiumCookieRow[]);
    await readXCookies(FAKE_BROWSER, {
      keychainFetcher: () => KEYCHAIN_PASSWORD,
      rowsReader: reader,
    });
    expect(reader).toHaveBeenCalledWith(FAKE_BROWSER.cookiesDbPath);
  });
});
