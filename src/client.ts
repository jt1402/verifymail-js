import { errorFromResponse, RateLimitError, ServiceDegradedError, VerifyMailError } from "./errors.js";

export interface ClientOptions {
  apiKey: string;
  /** Defaults to https://api.verifymailapi.com */
  baseUrl?: string;
  /** Max retry attempts on retryable failures (429, 5xx). Default 2 (so up to 3 total tries). */
  retries?: number;
  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Override fetch — useful for tests or non-Node runtimes. */
  fetch?: typeof fetch;
  /** Default risk profile sent as X-Risk-Profile on every call (overridable per request). */
  riskProfile?: "strict" | "balanced" | "permissive";
}

export interface RequestOptions {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Provide an Idempotency-Key for POSTs. Auto-generated UUID if `true`. */
  idempotencyKey?: string | boolean;
  /** Override the default risk profile for this call. */
  riskProfile?: "strict" | "balanced" | "permissive";
  /** Skip retry on transient errors for this call. */
  noRetry?: boolean;
  /** Override timeout for this call. */
  timeoutMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function uuidv4(): string {
  // Node 19+ has globalThis.crypto.randomUUID. Polyfill for older Node.
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const buf = new Uint8Array(16);
  for (let i = 0; i < 16; i++) buf[i] = Math.floor(Math.random() * 256);
  buf[6] = (buf[6]! & 0x0f) | 0x40;
  buf[8] = (buf[8]! & 0x3f) | 0x80;
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class HttpClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly defaultRiskProfile: string | undefined;

  constructor(opts: ClientOptions) {
    if (!opts.apiKey) throw new VerifyMailError("apiKey is required.");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.verifymailapi.com").replace(/\/+$/, "");
    this.retries = opts.retries ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.defaultRiskProfile = opts.riskProfile;
    if (!this.fetchImpl) {
      throw new VerifyMailError(
        "No fetch available. Pass `fetch` in the options, or use Node 18+.",
      );
    }
  }

  /** Build the headers shared by every request. */
  private buildHeaders(opts: RequestOptions): Headers {
    const h = new Headers(opts.headers);
    h.set("X-API-Key", this.apiKey);
    h.set("Accept", "application/json");
    h.set("User-Agent", "verifymail-js/0.1.0");
    if (opts.body !== undefined) h.set("Content-Type", "application/json");

    const profile = opts.riskProfile ?? this.defaultRiskProfile;
    if (profile) h.set("X-Risk-Profile", profile);

    if (opts.idempotencyKey) {
      h.set(
        "Idempotency-Key",
        typeof opts.idempotencyKey === "string" ? opts.idempotencyKey : uuidv4(),
      );
    }
    return h;
  }

  private buildUrl(path: string, query?: RequestOptions["query"]): string {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /** Send and decode a JSON request. Retries on 429 / 5xx up to `retries` times. */
  async json<T>(opts: RequestOptions): Promise<T> {
    const raw = await this.raw(opts);
    if (raw.status === 204) return undefined as T;
    const text = await raw.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new VerifyMailError(`Non-JSON response from ${opts.path}.`, {
        status: raw.status,
      });
    }
  }

  /**
   * Send a request and return the raw Response. Handles retries + error mapping.
   * Used internally; exposed for the streaming bulk method to consume the body.
   */
  async raw(opts: RequestOptions): Promise<Response> {
    const url = this.buildUrl(opts.path, opts.query);
    const headers = this.buildHeaders(opts);
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const method = opts.method ?? (body ? "POST" : "GET");
    const maxTries = opts.noRetry ? 1 : this.retries + 1;
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;

    let lastError: VerifyMailError | undefined;
    for (let attempt = 0; attempt < maxTries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        // Network-level failure — retry if attempts remain.
        lastError = new VerifyMailError(
          err instanceof Error ? err.message : "Network error",
          { code: "network_error" },
        );
        if (attempt < maxTries - 1) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }
      clearTimeout(timer);

      if (res.ok) return res;

      // Parse error body (best-effort) so we can build a typed error.
      let parsed: unknown = undefined;
      try {
        parsed = await res.clone().json();
      } catch {
        /* ignore non-JSON error bodies */
      }
      const err = errorFromResponse(res.status, parsed, res.headers.get("Retry-After"));

      const isRetryable =
        !opts.noRetry &&
        RETRYABLE_STATUS.has(res.status) &&
        attempt < maxTries - 1;

      if (isRetryable) {
        const wait =
          err instanceof RateLimitError
            ? err.retryAfter * 1000
            : err instanceof ServiceDegradedError
            ? backoffMs(attempt)
            : backoffMs(attempt);
        await sleep(wait);
        lastError = err;
        continue;
      }

      throw err;
    }

    throw lastError ?? new VerifyMailError("Request failed after retries.");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number): number {
  // 250ms, 750ms, 2.25s — typical exponential with a small jitter floor.
  return Math.min(250 * Math.pow(3, attempt), 10_000);
}
