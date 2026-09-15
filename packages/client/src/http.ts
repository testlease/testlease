import { ErrorCodes, TestLeaseError } from '@testlease/protocol';

export interface HttpOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  /** Per-request timeout for non-waiting calls. */
  requestTimeoutMs: number;
  /** Network-level retries for idempotent calls. */
  retries: number;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Retry on connection errors. Only for calls that are safe to repeat. */
  retry?: boolean;
}

function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const cause = (err as Error & { cause?: { code?: string } }).cause;
  const code = cause?.code ?? (err as { code?: string }).code;
  return (
    err.message.includes('fetch failed') ||
    err.message.includes('socket hang up') ||
    [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      'UND_ERR_SOCKET',
      'UND_ERR_CONNECT_TIMEOUT',
    ].includes(code ?? '')
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      },
      { once: true },
    );
  });
}

export class HttpTransport {
  private readonly options: HttpOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpOptions) {
    this.options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, '') };
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (!/^https?:\/\//.test(this.options.baseUrl)) {
      throw new TestLeaseError(
        ErrorCodes.INVALID_REQUEST,
        `baseUrl must start with http:// or https:// (got "${options.baseUrl}")`,
      );
    }
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async request<T>(req: RequestOptions): Promise<T> {
    const attempts = req.retry ? this.options.retries + 1 : 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await sleep(Math.min(100 * 2 ** (attempt - 1), 1000), req.signal);
      try {
        return await this.once<T>(req);
      } catch (err) {
        lastErr = err;
        if (!isConnectionError(err) || req.signal?.aborted) throw this.wrap(err);
      }
    }
    throw this.wrap(lastErr);
  }

  private async once<T>(req: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.options.userAgent ?? 'testlease-client',
    };
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`;
    if (req.body !== undefined) headers['content-type'] = 'application/json';

    const signals: AbortSignal[] = [
      AbortSignal.timeout(req.timeoutMs ?? this.options.requestTimeoutMs),
    ];
    if (req.signal) signals.push(req.signal);
    const res = await this.fetchImpl(`${this.options.baseUrl}${req.path}`, {
      method: req.method,
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.any(signals),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const err = TestLeaseError.fromBody(parsed, res.status);
      if (parsed === undefined) {
        throw new TestLeaseError(
          err.code,
          `TestLease server at ${this.options.baseUrl} returned HTTP ${res.status} without a JSON body${text ? `: ${text.slice(0, 200)}` : ''}`,
          { status: res.status },
        );
      }
      throw err;
    }
    return parsed as T;
  }

  private wrap(err: unknown): Error {
    if (err instanceof TestLeaseError) return err;
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return new TestLeaseError(
        err.name === 'TimeoutError' ? ErrorCodes.UNAVAILABLE : ErrorCodes.ACQUIRE_ABORTED,
        err.name === 'TimeoutError'
          ? `Request to ${this.options.baseUrl} timed out.`
          : 'Request aborted by the caller.',
        { baseUrl: this.options.baseUrl },
      );
    }
    if (isConnectionError(err)) {
      const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
      return new TestLeaseError(
        ErrorCodes.UNAVAILABLE,
        `Cannot reach TestLease at ${this.options.baseUrl} (${cause?.code ?? (err as Error).message}). Is the server running? Try: testlease doctor`,
        { baseUrl: this.options.baseUrl, cause: cause?.code ?? (err as Error).message },
      );
    }
    return err instanceof Error ? err : new Error(String(err));
  }
}
