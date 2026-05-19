export class XRayError extends Error {
  readonly code: string;
  readonly transient: boolean;
  override readonly cause?: unknown;

  constructor(code: string, message: string, opts: { transient?: boolean; cause?: unknown } = {}) {
    super(message);
    this.name = 'XRayError';
    this.code = code;
    this.transient = opts.transient ?? false;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

export class FetchError extends XRayError {
  constructor(message: string, opts: { transient?: boolean; cause?: unknown } = {}) {
    super('FETCH_ERROR', message, opts);
    this.name = 'FetchError';
  }
}

export class AuthRequiredError extends XRayError {
  constructor(message = 'X requires authentication. Run `xray auth` to log in.') {
    super('AUTH_REQUIRED', message, { transient: false });
    this.name = 'AuthRequiredError';
  }
}

export class KymaError extends XRayError {
  readonly status?: number;

  constructor(
    message: string,
    opts: { status?: number; transient?: boolean; cause?: unknown } = {},
  ) {
    super('KYMA_ERROR', message, opts);
    this.name = 'KymaError';
    if (opts.status !== undefined) this.status = opts.status;
  }
}

export class ParseError extends XRayError {
  constructor(message: string, cause?: unknown) {
    super('PARSE_ERROR', message, { cause });
    this.name = 'ParseError';
  }
}

/**
 * Raised when the OS keychain refuses to release the Chromium encryption key
 * (user clicked "Deny", the keychain item is missing, or the underlying
 * `security` invocation returned non-zero). Kept distinct from `FetchError`
 * so the P1.5.2 escalation orchestrator can pattern-match this exact failure
 * mode and silently fall through to the SSR tier without retrying.
 */
export class KeychainDeniedError extends XRayError {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super('KEYCHAIN_DENIED', message, opts);
    this.name = 'KeychainDeniedError';
  }
}

/**
 * Raised when an encrypted cookie value cannot be decrypted with the derived
 * AES key — corrupted row, unknown encryption prefix, or a Chromium update
 * we don't recognize yet. Distinct from `KeychainDeniedError` because the
 * recovery path is different: keychain denial means "skip this browser",
 * decrypt error means "skip this cookie row".
 */
export class CookieDecryptError extends XRayError {
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super('COOKIE_DECRYPT', message, opts);
    this.name = 'CookieDecryptError';
  }
}
