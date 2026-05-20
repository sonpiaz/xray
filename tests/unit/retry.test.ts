/**
 * P5.1 — `withRetry()` unit tests. Uses the `sleep` test seam so retry
 * waits don't burn real wall-clock time; each test asserts both the
 * outcome and the number of `fn` invocations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultIsRetryable, parseRetryAfter, withRetry } from '../../src/core/retry.ts';

const noSleep = async (_ms: number) => undefined;

beforeEach(() => {
  // Pin the jitter to 0 by default so timing assertions are deterministic.
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // → spread = 0
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withRetry — success paths', () => {
  it('returns the result on first attempt with no retry', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { sleep: noSleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries once on HTTP 429 and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate'), { status: 429 }))
      .mockResolvedValue('after-retry');
    const result = await withRetry(fn, { sleep: noSleep });
    expect(result).toBe('after-retry');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on HTTP 503 (5xx) and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('svc'), { status: 503 }))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on network ECONNRESET and succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('withRetry — exhaustion paths', () => {
  it('throws after maxAttempts on repeated 429', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('rate'), { status: 429 }));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow('rate');
    expect(fn).toHaveBeenCalledTimes(3); // default maxAttempts
  });

  it('honors a custom maxAttempts cap', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('rate'), { status: 429 }));
    await expect(withRetry(fn, { sleep: noSleep, maxAttempts: 5 })).rejects.toThrow('rate');
    expect(fn).toHaveBeenCalledTimes(5);
  });

  it('throws immediately on a non-retryable 400', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('bad req'), { status: 400 }));
    await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow('bad req');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('withRetry — Retry-After', () => {
  it('uses retryAfterMs hint over exponential backoff', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate'), { status: 429 }))
      .mockResolvedValue('ok');
    const sleep = vi.fn(async (_ms: number) => undefined);

    await withRetry(fn, {
      sleep,
      retryAfterMs: () => 5000, // server says wait 5s
      baseMs: 1000, // exponential would only sleep 1000ms
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0]?.[0]).toBe(5000);
  });

  it('parseRetryAfter parses numeric seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
  });

  it('parseRetryAfter parses HTTP-date as delta-ms', () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(8000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });
});

describe('withRetry — options', () => {
  it('honors a custom isRetryable function', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('weird'));
    let invoked = 0;
    const isRetryable = (err: unknown) => {
      invoked++;
      return err instanceof Error && err.message === 'weird';
    };
    await expect(withRetry(fn, { sleep: noSleep, isRetryable })).rejects.toThrow('weird');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(invoked).toBeGreaterThan(0);
  });

  it('jitter actually varies the delay across attempts', async () => {
    vi.restoreAllMocks();
    // Force Math.random to alternate to confirm jitter feeds into the
    // delay computation (different return values → different delays).
    const seq = [0.1, 0.9];
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => seq[i++ % seq.length] as number);

    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('rate'), { status: 429 }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    await expect(
      withRetry(fn, { sleep, baseMs: 1000, multiplier: 1, jitter: 0.3, maxAttempts: 3 }),
    ).rejects.toThrow();
    // Two retries → two sleep calls. Both should be near 1000ms ±30% but
    // the two values should differ because Math.random returns different
    // values across calls.
    expect(sleep).toHaveBeenCalledTimes(2);
    const d1 = sleep.mock.calls[0]?.[0] as number;
    const d2 = sleep.mock.calls[1]?.[0] as number;
    expect(d1).not.toBe(d2);
  });

  it('backoff caps at maxMs', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('rate'), { status: 429 }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    await expect(
      withRetry(fn, {
        sleep,
        baseMs: 10_000,
        multiplier: 10, // attempt 2 would be 100_000ms uncapped
        maxMs: 5_000,
        jitter: 0,
        maxAttempts: 3,
      }),
    ).rejects.toThrow();
    for (const call of sleep.mock.calls) {
      expect(call[0] as number).toBeLessThanOrEqual(5_000);
    }
  });

  it('label is included in retry log warning meta', async () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('rate'), { status: 429 }))
      .mockResolvedValue('ok');
    await withRetry(fn, { sleep: noSleep, label: 'kyma' });
    const calls = warn.mock.calls.map((c) => String(c[0]));
    const retryLine = calls.find((s) => s.includes('retry attempt'));
    expect(retryLine).toBeDefined();
    expect(retryLine).toContain('"provider":"kyma"');
  });
});

describe('defaultIsRetryable', () => {
  it('returns true for HTTP 429, 502, 503, 504', () => {
    for (const status of [429, 502, 503, 504]) {
      expect(defaultIsRetryable({ status })).toBe(true);
    }
  });

  it('returns false for 4xx other than 429', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(defaultIsRetryable({ status })).toBe(false);
    }
  });

  it('returns true for retryable network codes', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND']) {
      expect(defaultIsRetryable({ code })).toBe(true);
    }
  });

  it('returns false for unrecognized errors', () => {
    expect(defaultIsRetryable(new Error('mystery'))).toBe(false);
    expect(defaultIsRetryable({})).toBe(false);
    expect(defaultIsRetryable(undefined)).toBe(false);
  });

  it('returns true for AbortError with timeout in message', () => {
    const err = Object.assign(new Error('connection timeout'), { name: 'AbortError' });
    expect(defaultIsRetryable(err)).toBe(true);
  });
});
