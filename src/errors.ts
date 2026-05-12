/**
 * Error class hierarchy. All HTTP errors from the API are translated into one
 * of these — customers can `instanceof` them to branch cleanly:
 *
 *   try { await vm.check(email) }
 *   catch (e) {
 *     if (e instanceof QuotaExceededError) return showBilling();
 *     if (e instanceof RateLimitError)     return retryLater(e.retryAfter);
 *     if (e instanceof VerifyMailError)    return logAndShowGeneric(e);
 *     throw e;
 *   }
 */

export interface ErrorBody {
  code: string;
  http_status: number;
  message: string;
  request_id?: string;
  docs_url?: string;
  // Rate-limit-specific
  limit?: number;
  reset_at?: string;
  // Quota-specific
  upgrade_url?: string;
}

export class VerifyMailError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly docsUrl: string | undefined;
  readonly body: ErrorBody | undefined;

  constructor(message: string, opts: {
    code?: string;
    status?: number;
    requestId?: string;
    docsUrl?: string;
    body?: ErrorBody;
  } = {}) {
    super(message);
    this.name = "VerifyMailError";
    this.code = opts.code ?? "verifymail_error";
    this.status = opts.status ?? 0;
    this.requestId = opts.requestId;
    this.docsUrl = opts.docsUrl;
    this.body = opts.body;
  }
}

export class InvalidApiKeyError extends VerifyMailError {
  constructor(opts: NonNullable<ConstructorParameters<typeof VerifyMailError>[1]>) {
    super("API key is missing or invalid.", opts);
    this.name = "InvalidApiKeyError";
  }
}

export class QuotaExceededError extends VerifyMailError {
  readonly upgradeUrl: string | undefined;
  constructor(opts: NonNullable<ConstructorParameters<typeof VerifyMailError>[1]>) {
    super("Out of credits. Buy a bundle to keep going.", opts);
    this.name = "QuotaExceededError";
    this.upgradeUrl = opts.body?.upgrade_url;
  }
}

export class RateLimitError extends VerifyMailError {
  readonly retryAfter: number;
  readonly limit: number | undefined;
  readonly resetAt: string | undefined;

  constructor(opts: NonNullable<ConstructorParameters<typeof VerifyMailError>[1]> & {
    retryAfter: number;
  }) {
    super(`Rate limit hit; retry after ${opts.retryAfter}s.`, opts);
    this.name = "RateLimitError";
    this.retryAfter = opts.retryAfter;
    this.limit = opts.body?.limit;
    this.resetAt = opts.body?.reset_at;
  }
}

export class IdempotencyConflictError extends VerifyMailError {
  constructor(opts: NonNullable<ConstructorParameters<typeof VerifyMailError>[1]>) {
    super(
      "Idempotency-Key was reused with a different request body. Use a new key or resend the original payload.",
      opts,
    );
    this.name = "IdempotencyConflictError";
  }
}

export class ValidationError extends VerifyMailError {
  constructor(message: string, opts: NonNullable<ConstructorParameters<typeof VerifyMailError>[1]>) {
    super(message, opts);
    this.name = "ValidationError";
  }
}

export class ServiceDegradedError extends VerifyMailError {
  constructor(opts: NonNullable<ConstructorParameters<typeof VerifyMailError>[1]>) {
    super("A component is degraded; retry shortly.", opts);
    this.name = "ServiceDegradedError";
  }
}

/**
 * Map an HTTP response to the right error class. The backend's error envelope
 * is `{ error: { code, http_status, message, ... } }`.
 */
export function errorFromResponse(
  status: number,
  body: { error?: ErrorBody } | unknown,
  retryAfterHeader?: string | null,
): VerifyMailError {
  const envelope =
    body && typeof body === "object" && "error" in body
      ? (body as { error?: ErrorBody }).error
      : undefined;
  const code = envelope?.code ?? "verifymail_error";
  const opts = {
    code,
    status,
    requestId: envelope?.request_id,
    docsUrl: envelope?.docs_url,
    body: envelope,
  };

  if (status === 401) return new InvalidApiKeyError(opts);
  if (status === 402) return new QuotaExceededError(opts);
  if (status === 409 && code === "invalid_idempotency_key")
    return new IdempotencyConflictError(opts);
  if (status === 422) return new ValidationError(envelope?.message ?? "Validation error.", opts);
  if (status === 429) {
    const retryAfter = Number(retryAfterHeader ?? envelope?.limit ?? 1);
    return new RateLimitError({ ...opts, retryAfter: Number.isFinite(retryAfter) ? retryAfter : 1 });
  }
  if (status === 503 || status === 504) return new ServiceDegradedError(opts);
  return new VerifyMailError(envelope?.message ?? `HTTP ${status}`, opts);
}
