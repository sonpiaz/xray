/**
 * P5.1 — Shared retry utility with exponential backoff + jitter.
 *
 * Used by the Kyma client (network call) and the X cookie-tier fetch to
 * absorb transient failures (HTTP 429, 5xx, network blips) before bubbling
 * up to the caller. Sits at the network layer BELOW any caching wrapper,
 * so cached hits never trigger retries.
 *
 * Defaults match the Phase 5 spec: 3 attempts, 1s base, 2x multiplier,
 * ±30% jitter, 30s cap. The `retryAfterMs(err)` hook lets callers parse
 * provider-specific hints (e.g. the HTTP `Retry-After` header) and skip
 * the exponential schedule when the server has told us exactly how long
 * to wait.
 *
 * Logging:
 *   - `logger.warn('retry attempt', ...)` on each retry (provider label,
 *     attempt, delayMs, short err msg).
 *   - `logger.error('retry exhausted', ...)` on final failure.
 *
 * Non-retryable errors are thrown immediately on the first attempt — see
 * `defaultIsRetryable` for the heuristic (HTTP 429/5xx + a small set of
 * network error codes).
 */
import { logger } from './logger.ts';

export type RetryOptions = {
  /** Max attempts including the first one. Default 3. */
  maxAttempts?: number;
  /** Initial backoff in ms. Default 1000 (1s). */
  baseMs?: number;
  /** Backoff multiplier per attempt. Default 2. */
  multiplier?: number;
  /** Max backoff cap in ms. Default 30000 (30s). */
  maxMs?: number;
  /** Jitter spread, ±fraction. Default 0.3. */
  jitter?: number;
  /** Custom retryable check. Default: HTTP 429, 5xx, network errors. */
  isRetryable?: (err: unknown) => boolean;
  /** Override delay extraction (e.g., parse Retry-After). Returns ms or undefined. */
  retryAfterMs?: (err: unknown) => number | undefined;
  /** Provider label for log messages (e.g., 'kyma', 'x-cookie'). */
  label?: string;
  /**
   * Test seam — replaces the default `setTimeout`-based sleep. Lets unit
   * tests skip real wall-clock waits without mocking globals.
   */
  sleep?: (ms: number) => Promise<void>;
};

/** Network error codes from Node that mean "try again later". */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'EPIPE',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function extractStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const obj = err as Record<string, unknown>;
  if (typeof obj.status === 'number') return obj.status;
  if (typeof obj.statusCode === 'number') return obj.statusCode;
  return undefined;
}

function extractCode(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const obj = err as Record<string, unknown>;
  if (typeof obj.code === 'string') return obj.code;
  // undici nests the original code under `cause.code` for some failures.
  if (obj.cause && typeof obj.cause === 'object') {
    const inner = (obj.cause as Record<string, unknown>).code;
    if (typeof inner === 'string') return inner;
  }
  return undefined;
}

function isAbortTimeout(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const obj = err as Record<string, unknown>;
  if (obj.name !== 'AbortError') return false;
  if (typeof obj.message === 'string' && /timeout|timed out/i.test(obj.message)) return true;
  if (obj.cause && typeof obj.cause === 'object') {
    const inner = obj.cause as Record<string, unknown>;
    if (typeof inner.message === 'string' && /timeout|timed out/i.test(inner.message)) return true;
  }
  return false;
}

export function defaultIsRetryable(err: unknown): boolean {
  const status = extractStatus(err);
  if (status !== undefined) {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  const code = extractCode(err);
  if (code && RETRYABLE_NETWORK_CODES.has(code)) return true;
  if (isAbortTimeout(err)) return true;
  return false;
}

function shortMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 200 ? `${err.message.slice(0, 200)}…` : err.message;
  }
  return String(err).slice(0, 200);
}

function computeBackoff(
  attempt: number,
  opts: Required<Pick<RetryOptions, 'baseMs' | 'multiplier' | 'maxMs' | 'jitter'>>,
): number {
  // attempt is 1-based; first retry uses baseMs * multiplier^0 = baseMs.
  const exp = opts.baseMs * opts.multiplier ** (attempt - 1);
  const capped = Math.min(exp, opts.maxMs);
  const spread = (Math.random() * 2 - 1) * opts.jitter; // ±jitter fraction
  return Math.max(0, Math.round(capped * (1 + spread)));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Execute `fn`, retrying on transient failures. Returns the resolved value
 * from `fn` on success; throws the final error on exhaustion.
 *
 * Retry count semantics: `maxAttempts = 3` means 1 initial attempt + up to
 * 2 retries. The first attempt is NOT delayed; only retries wait.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  const multiplier = opts.multiplier ?? 2;
  const maxMs = opts.maxMs ?? 30000;
  const jitter = opts.jitter ?? 0.3;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const retryAfterMs = opts.retryAfterMs;
  const sleep = opts.sleep ?? defaultSleep;
  const label = opts.label ?? 'request';

  let lastErr: unknown;
  let attemptsRun = 0;
  let retried = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attemptsRun = attempt;
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt >= maxAttempts) break;

      const hint = retryAfterMs?.(err);
      const delayMs =
        hint !== undefined && hint >= 0
          ? Math.min(hint, maxMs)
          : computeBackoff(attempt, { baseMs, multiplier, maxMs, jitter });

      retried = true;
      logger.warn('retry attempt', {
        provider: label,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        err: shortMessage(err),
      });
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  // Only log "exhausted" when we actually exhausted retries — a non-retryable
  // first-attempt failure shouldn't be reported as a retry exhaustion.
  if (retried) {
    logger.error('retry exhausted', {
      provider: label,
      totalAttempts: attemptsRun,
      finalErr: shortMessage(lastErr),
    });
  }
  throw lastErr;
}

/**
 * Helper for HTTP-style errors that carry a `Retry-After` header. Accepts
 * the header value (seconds or HTTP-date) and returns ms, or undefined if
 * unparseable. Exposed so providers can plug it into `retryAfterMs`.
 */
export function parseRetryAfter(headerValue: string | undefined | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  // Numeric seconds (most common from API gateways).
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const secs = Number.parseFloat(trimmed);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    return undefined;
  }
  // HTTP-date.
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return undefined;
}
