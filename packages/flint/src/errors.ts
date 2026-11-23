type FlintErrorOptions = {
  code: string;
  cause?: unknown;
};

export class FlintError extends Error {
  readonly code: string;
  constructor(message: string, opts: FlintErrorOptions) {
    super(message, { cause: opts.cause });
    this.code = opts.code;
    this.name = 'FlintError';
  }
}

export type AdapterErrorKind =
  | 'rate_limit'
  | 'overloaded'
  | 'server'
  | 'network'
  | 'timeout'
  | 'auth'
  | 'not_found'
  | 'context_overflow'
  | 'invalid_request'
  | 'unknown';

type AdapterErrorOptions = FlintErrorOptions & {
  kind?: AdapterErrorKind;
  retryable?: boolean;
  retryAfterMs?: number;
  status?: number;
};

export class AdapterError extends FlintError {
  readonly kind: AdapterErrorKind;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;
  constructor(message: string, opts: AdapterErrorOptions) {
    super(message, opts);
    this.name = 'AdapterError';
    this.kind = opts.kind ?? 'unknown';
    this.retryable = opts.retryable ?? false;
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
  }
}

const CONTEXT_OVERFLOW_RE =
  /prompt is too long|context(_| )length|context window|maximum context|too many tokens/i;

function parseRetryAfter(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms !== null && Number.isFinite(Number(ms))) return Number(ms);
  const s = headers.get('retry-after');
  if (s === null) return undefined;
  if (Number.isFinite(Number(s))) return Number(s) * 1000;
  const date = Date.parse(s);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Map an HTTP failure to a classified AdapterError. Shared by the first-party adapters. */
export function httpError(
  provider: string,
  status: number,
  message: string | undefined,
  headers?: Headers,
  body?: unknown,
): AdapterError {
  const msg = message ?? `${provider} ${status}`;
  let kind: AdapterErrorKind;
  if (status === 429) kind = 'rate_limit';
  else if (status === 529 || status === 503) kind = 'overloaded';
  else if (status === 408) kind = 'timeout';
  else if (status === 401 || status === 403) kind = 'auth';
  else if (status === 404) kind = 'not_found';
  else if (status >= 500) kind = 'server';
  else if ((status === 400 || status === 413) && CONTEXT_OVERFLOW_RE.test(msg))
    kind = 'context_overflow';
  else if (status >= 400 && status < 500) kind = 'invalid_request';
  else kind = 'unknown';
  let retryable =
    kind === 'rate_limit' ||
    kind === 'overloaded' ||
    kind === 'server' ||
    kind === 'timeout' ||
    status === 409;
  const shouldRetry = headers?.get('x-should-retry');
  if (shouldRetry === 'true') retryable = true;
  if (shouldRetry === 'false') retryable = false;
  const retryAfterMs = parseRetryAfter(headers);
  return new AdapterError(msg, {
    code: `adapter.http.${status}`,
    cause: { status, body },
    kind,
    retryable,
    status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export function networkError(cause: unknown): AdapterError {
  const aborted = cause instanceof Error && cause.name === 'AbortError';
  return new AdapterError(aborted ? 'Request aborted' : 'Network error', {
    code: aborted ? 'adapter.aborted' : 'adapter.network',
    cause,
    kind: 'network',
    retryable: !aborted,
  });
}

export class ValidationError extends FlintError {
  constructor(message: string, opts: FlintErrorOptions) {
    super(message, opts);
    this.name = 'ValidationError';
  }
}

export class ToolError extends FlintError {
  constructor(message: string, opts: FlintErrorOptions) {
    super(message, opts);
    this.name = 'ToolError';
  }
}

export class BudgetExhausted extends FlintError {
  constructor(message: string, opts: FlintErrorOptions) {
    super(message, opts);
    this.name = 'BudgetExhausted';
  }
}

export class ParseError extends FlintError {
  constructor(message: string, opts: FlintErrorOptions) {
    super(message, opts);
    this.name = 'ParseError';
  }
}

export class TimeoutError extends FlintError {
  constructor(message: string, opts: FlintErrorOptions) {
    super(message, opts);
    this.name = 'TimeoutError';
  }
}

export class NotImplementedError extends FlintError {
  constructor(what: string) {
    super(`Not implemented: ${what}`, { code: 'not_implemented' });
    this.name = 'NotImplementedError';
  }
}
