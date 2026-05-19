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
