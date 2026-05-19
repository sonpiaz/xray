/**
 * P1.5.2 — Escalation state-machine tests for `fetchThread`.
 *
 * We exercise the 3-tier orchestrator (Cookie+PW → SSR → saved auth) +
 * direct-mode overrides via the `_orchestratorDeps` test seam exposed by
 * `src/fetcher/thread.ts`. Every external dependency (Chromium detection,
 * cookie read, Playwright launch, SSR fetch, storageState load, sqlite
 * cache write) is stubbed so the suite runs under Node without touching
 * Chrome, Keychain, or `bun:sqlite`.
 *
 * Side modules that the orchestrator imports through normal import edges —
 * `src/cache/threads.ts` (bun:sqlite) and `src/fetcher/browser.ts`
 * (playwright) — are `vi.mock`'d at the top of the file so their
 * top-level imports never fire under the Node test runner.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock side-effect-heavy modules BEFORE importing the orchestrator. Vitest
// hoists vi.mock to the top of the file so the orchestrator's own imports
// see the stubbed versions.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

vi.mock('../../src/cache/threads.ts', () => ({
  putCachedThread: vi.fn(),
  getCachedThread: vi.fn(),
}));

vi.mock('../../src/fetcher/browser.ts', () => ({
  newContext: vi.fn(),
  newContextWithCookies: vi.fn(),
  getBrowser: vi.fn(),
  saveStorageState: vi.fn(),
  closeBrowser: vi.fn(),
}));

import type { ChromiumBrowser } from '../../src/auth/browsers.ts';
import type { DecryptedCookie } from '../../src/auth/cookie-reader.ts';
import { AuthWallError, FetchError, KeychainDeniedError } from '../../src/core/errors.ts';
import { type FetchResult, _orchestratorDeps, fetchThread } from '../../src/fetcher/thread.ts';
import type { XPost } from '../../src/models/post.ts';
import type { XThread } from '../../src/models/thread.ts';

// ---- Shared fixtures ------------------------------------------------------

const URL = 'https://x.com/karpathy/status/1234567890';

function fakeBrowser(name: ChromiumBrowser['name']): ChromiumBrowser {
  return {
    name,
    displayName: name === 'chrome' ? 'Google Chrome' : name === 'brave' ? 'Brave' : 'Edge',
    cookiesDbPath: `/dev/null/${name}/Cookies`,
    keychainService: `${name} Safe Storage`,
  };
}

function fakeCookie(): DecryptedCookie {
  return {
    name: 'auth_token',
    value: 'synthetic',
    domain: '.x.com',
    path: '/',
    secure: true,
    httpOnly: true,
    expires: -1,
  };
}

function fakePost(id = '1234567890', handle = 'karpathy'): XPost {
  return {
    id,
    url: `https://x.com/${handle}/status/${id}`,
    author: { handle, verified: false },
    text: 'hello',
    metrics: {},
    media: [],
    links: [],
    isReply: false,
    isQuote: false,
  };
}

function fakeThread(over: Partial<XThread> = {}): XThread {
  return {
    rootPost: fakePost(),
    authorPosts: [],
    quoteTweets: [],
    comments: [],
    fetchedAt: new Date().toISOString(),
    partial: false,
    ...over,
  };
}

function cookieResult(): FetchResult {
  return {
    thread: fakeThread({ comments: [], partial: false }),
    coverage: {
      targetDepth: 3,
      achievedDepth: 1,
      targetReplies: 50,
      fetchedReplies: 0,
      paginationCursors: [],
      status: 'ok',
    },
  };
}

function authResult(): FetchResult {
  return {
    thread: fakeThread({ partial: false }),
    coverage: {
      targetDepth: 3,
      achievedDepth: 1,
      targetReplies: 50,
      fetchedReplies: 0,
      paginationCursors: [],
      status: 'ok',
    },
  };
}

// ---- Per-test isolation ---------------------------------------------------

const originalDeps = { ..._orchestratorDeps };

beforeEach(() => {
  // Reset the seam to the runtime impl before each test. Tests opt in by
  // assigning specific mock functions.
  Object.assign(_orchestratorDeps, originalDeps);
  vi.mocked(existsSync).mockImplementation(() => false);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.assign(_orchestratorDeps, originalDeps);
});

// ---- Direct-mode overrides ------------------------------------------------

describe('fetchThread — direct-mode overrides', () => {
  it("mode='ssr' calls fetchSsr only; never touches cookies", async () => {
    const fetchSsr = vi.fn(async () => ({
      thread: fakeThread(),
      coverage: { tier: 'ssr' as const } as never,
    }));
    const detectChromiumBrowsers = vi.fn(() => [fakeBrowser('chrome')]);
    const readXCookies = vi.fn(async () => [fakeCookie()]);
    const putCachedThread = vi.fn();
    _orchestratorDeps.fetchSsr = fetchSsr;
    _orchestratorDeps.detectChromiumBrowsers = detectChromiumBrowsers;
    _orchestratorDeps.readXCookies = readXCookies;
    _orchestratorDeps.putCachedThread = putCachedThread;

    const result = await fetchThread(URL, { mode: 'ssr' });

    expect(result.tier).toBe('ssr');
    expect(fetchSsr).toHaveBeenCalledOnce();
    expect(detectChromiumBrowsers).not.toHaveBeenCalled();
    expect(readXCookies).not.toHaveBeenCalled();
    expect(putCachedThread).toHaveBeenCalledOnce();
  });

  it("mode='cookie' tries cookies only and throws FetchError when no browsers are detected (no SSR fallback)", async () => {
    const fetchSsr = vi.fn();
    _orchestratorDeps.fetchSsr = fetchSsr;
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => []);

    await expect(fetchThread(URL, { mode: 'cookie' })).rejects.toBeInstanceOf(FetchError);
    expect(fetchSsr).not.toHaveBeenCalled();
  });

  it("mode='cookie' fails hard when every browser yields no usable cookies (no SSR fallback)", async () => {
    const fetchSsr = vi.fn();
    _orchestratorDeps.fetchSsr = fetchSsr;
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => [fakeBrowser('chrome')]);
    _orchestratorDeps.readXCookies = vi.fn(async () => []);

    await expect(fetchThread(URL, { mode: 'cookie' })).rejects.toBeInstanceOf(FetchError);
    expect(fetchSsr).not.toHaveBeenCalled();
  });

  it("mode='auth' uses storageState fetcher", async () => {
    const fetchWithStorageState = vi.fn(async () => authResult());
    const detectChromiumBrowsers = vi.fn();
    _orchestratorDeps.fetchWithStorageState = fetchWithStorageState;
    _orchestratorDeps.detectChromiumBrowsers = detectChromiumBrowsers;

    const result = await fetchThread(URL, { mode: 'auth' });

    expect(result.tier).toBe('auth');
    expect(fetchWithStorageState).toHaveBeenCalledOnce();
    expect(detectChromiumBrowsers).not.toHaveBeenCalled();
  });

  it("mode='auth' propagates fetcher errors (e.g. missing storageState)", async () => {
    _orchestratorDeps.fetchWithStorageState = vi.fn(async () => {
      throw new FetchError('No saved login at /tmp/storageState.json. Run `xray auth` first.');
    });

    await expect(fetchThread(URL, { mode: 'auth' })).rejects.toBeInstanceOf(FetchError);
  });
});

// ---- Auto-mode escalation chain ------------------------------------------

describe('fetchThread — auto-mode escalation', () => {
  it("Chrome has cookies + fetch succeeds → tier='cookie', SSR never called", async () => {
    const fetchSsr = vi.fn();
    const fetchWithStorageState = vi.fn();
    const fetchWithCookies = vi.fn(async () => cookieResult());
    _orchestratorDeps.fetchSsr = fetchSsr;
    _orchestratorDeps.fetchWithStorageState = fetchWithStorageState;
    _orchestratorDeps.fetchWithCookies = fetchWithCookies;
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => [fakeBrowser('chrome')]);
    _orchestratorDeps.readXCookies = vi.fn(async () => [fakeCookie()]);

    const result = await fetchThread(URL, { mode: 'auto' });

    expect(result.tier).toBe('cookie');
    expect(fetchWithCookies).toHaveBeenCalledOnce();
    expect(fetchSsr).not.toHaveBeenCalled();
    expect(fetchWithStorageState).not.toHaveBeenCalled();
  });

  it('KeychainDeniedError on Chrome → falls through to Brave → Edge → SSR', async () => {
    const readXCookies = vi
      .fn<(browser: ChromiumBrowser) => Promise<DecryptedCookie[]>>()
      .mockImplementationOnce(async () => {
        throw new KeychainDeniedError('user denied chrome');
      })
      .mockImplementationOnce(async () => {
        throw new KeychainDeniedError('user denied brave');
      })
      .mockImplementationOnce(async () => {
        throw new KeychainDeniedError('user denied edge');
      });
    const fetchSsr = vi.fn(async () => ({
      thread: fakeThread(),
      coverage: { tier: 'ssr' as const } as never,
    }));
    const fetchWithCookies = vi.fn();
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => [
      fakeBrowser('chrome'),
      fakeBrowser('brave'),
      fakeBrowser('edge'),
    ]);
    _orchestratorDeps.readXCookies = readXCookies;
    _orchestratorDeps.fetchSsr = fetchSsr;
    _orchestratorDeps.fetchWithCookies = fetchWithCookies;
    _orchestratorDeps.putCachedThread = vi.fn();

    const result = await fetchThread(URL, { mode: 'auto' });

    expect(result.tier).toBe('ssr');
    expect(readXCookies).toHaveBeenCalledTimes(3);
    expect(fetchWithCookies).not.toHaveBeenCalled();
    expect(fetchSsr).toHaveBeenCalledOnce();
  });

  it("no Chromium browsers detected → SSR fallback returns tier='ssr'", async () => {
    const fetchSsr = vi.fn(async () => ({
      thread: fakeThread(),
      coverage: { tier: 'ssr' as const } as never,
    }));
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => []);
    _orchestratorDeps.fetchSsr = fetchSsr;
    _orchestratorDeps.fetchWithCookies = vi.fn();
    _orchestratorDeps.putCachedThread = vi.fn();

    const result = await fetchThread(URL, { mode: 'auto' });

    expect(result.tier).toBe('ssr');
    expect(fetchSsr).toHaveBeenCalledOnce();
  });

  it('AuthWallError (session expired) on Chrome → tries Brave → SSR', async () => {
    const fetchWithCookies = vi
      .fn<typeof _orchestratorDeps.fetchWithCookies>()
      .mockImplementationOnce(async () => {
        throw new AuthWallError('expired session on chrome');
      })
      .mockImplementationOnce(async () => {
        throw new AuthWallError('expired session on brave');
      });
    const fetchSsr = vi.fn(async () => ({
      thread: fakeThread(),
      coverage: { tier: 'ssr' as const } as never,
    }));
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => [
      fakeBrowser('chrome'),
      fakeBrowser('brave'),
    ]);
    _orchestratorDeps.readXCookies = vi.fn(async () => [fakeCookie()]);
    _orchestratorDeps.fetchWithCookies = fetchWithCookies;
    _orchestratorDeps.fetchSsr = fetchSsr;
    _orchestratorDeps.putCachedThread = vi.fn();

    const result = await fetchThread(URL, { mode: 'auto' });

    expect(result.tier).toBe('ssr');
    expect(fetchWithCookies).toHaveBeenCalledTimes(2);
    expect(fetchSsr).toHaveBeenCalledOnce();
  });

  it("cookies + SSR both fail; storageState exists → tier='auth'", async () => {
    vi.mocked(existsSync).mockImplementation(() => true);
    const fetchSsr = vi.fn(async () => {
      throw new FetchError('SSR fetch returned HTTP 404');
    });
    const fetchWithStorageState = vi.fn(async () => authResult());
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => []);
    _orchestratorDeps.fetchSsr = fetchSsr;
    _orchestratorDeps.fetchWithStorageState = fetchWithStorageState;
    _orchestratorDeps.putCachedThread = vi.fn();

    const result = await fetchThread(URL, { mode: 'auto' });

    expect(result.tier).toBe('auth');
    expect(fetchSsr).toHaveBeenCalledOnce();
    expect(fetchWithStorageState).toHaveBeenCalledOnce();
  });

  it('all 3 tiers fail → throws FetchError with `xray auth` guidance', async () => {
    vi.mocked(existsSync).mockImplementation(() => false);
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => []);
    _orchestratorDeps.fetchSsr = vi.fn(async () => {
      throw new FetchError('SSR fetch returned HTTP 500');
    });
    _orchestratorDeps.fetchWithStorageState = vi.fn(); // never called — no storageState

    let caught: unknown;
    try {
      await fetchThread(URL, { mode: 'auto' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FetchError);
    const msg = (caught as Error).message;
    expect(msg).toMatch(/requires authentication/i);
    expect(msg).toMatch(/Run `xray auth`/);
  });

  it('SSR returning a thread without rootPost still escalates to auth (or errors)', async () => {
    vi.mocked(existsSync).mockImplementation(() => false);
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => []);
    _orchestratorDeps.fetchSsr = vi.fn(async () => ({
      // SSR sometimes "succeeds" with an empty page (rootPost falsy) on login walls.
      thread: { ...fakeThread(), rootPost: undefined as unknown as XPost },
      coverage: { tier: 'ssr' as const } as never,
    }));

    await expect(fetchThread(URL, { mode: 'auto' })).rejects.toBeInstanceOf(FetchError);
  });

  it("Chrome no cookies, Brave has cookies → tier='cookie' (skips Chrome cleanly)", async () => {
    const readXCookies = vi
      .fn<(browser: ChromiumBrowser) => Promise<DecryptedCookie[]>>()
      .mockImplementationOnce(async () => []) // chrome empty
      .mockImplementationOnce(async () => [fakeCookie()]); // brave has them
    const fetchWithCookies = vi.fn(async () => cookieResult());
    const fetchSsr = vi.fn();
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => [
      fakeBrowser('chrome'),
      fakeBrowser('brave'),
    ]);
    _orchestratorDeps.readXCookies = readXCookies;
    _orchestratorDeps.fetchWithCookies = fetchWithCookies;
    _orchestratorDeps.fetchSsr = fetchSsr;

    const result = await fetchThread(URL, { mode: 'auto' });

    expect(result.tier).toBe('cookie');
    expect(readXCookies).toHaveBeenCalledTimes(2);
    expect(fetchWithCookies).toHaveBeenCalledOnce();
    expect(fetchSsr).not.toHaveBeenCalled();
  });
});

// ---- coverage.tier ----------------------------------------------------------

describe('fetchThread — coverage.tier on FetchResult', () => {
  it("Tier 1 success populates coverage from inner result AND sets tier='cookie'", async () => {
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => [fakeBrowser('chrome')]);
    _orchestratorDeps.readXCookies = vi.fn(async () => [fakeCookie()]);
    _orchestratorDeps.fetchWithCookies = vi.fn(async () => cookieResult());

    const result = await fetchThread(URL, { mode: 'auto' });

    expect(result.tier).toBe('cookie');
    expect(result.coverage).toBeDefined();
    expect(result.coverage?.targetDepth).toBe(3);
  });

  it("Tier 2 SSR fallback returns tier='ssr' and no Playwright coverage", async () => {
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => []);
    _orchestratorDeps.fetchSsr = vi.fn(async () => ({
      thread: fakeThread(),
      coverage: { tier: 'ssr' as const } as never,
    }));
    _orchestratorDeps.putCachedThread = vi.fn();

    const result = await fetchThread(URL, { mode: 'auto' });

    expect(result.tier).toBe('ssr');
    expect(result.coverage).toBeUndefined();
  });

  it("Tier 3 auth fallback sets tier='auth' with the Playwright coverage", async () => {
    vi.mocked(existsSync).mockImplementation(() => true);
    _orchestratorDeps.detectChromiumBrowsers = vi.fn(() => []);
    _orchestratorDeps.fetchSsr = vi.fn(async () => {
      throw new FetchError('ssr down');
    });
    _orchestratorDeps.fetchWithStorageState = vi.fn(async () => authResult());

    const result = await fetchThread(URL, { mode: 'auto' });

    expect(result.tier).toBe('auth');
    expect(result.coverage).toBeDefined();
  });
});
