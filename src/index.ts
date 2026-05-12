/**
 * Official SDK for the VerifyMail API.
 *
 *   import { VerifyMail } from "verifymailapi";
 *   const vm = new VerifyMail({ apiKey: process.env.VERIFYMAIL_KEY! });
 *   const r = await vm.check("user@example.com");
 *   if (r.verdict.recommendation === "block") { ... }
 *
 * Docs: https://verifymailapi.com/docs
 */

import { HttpClient, type ClientOptions, type RequestOptions } from "./client.js";
import type {
  AsyncCheckResponse,
  BulkCheckResponse,
  BulkStreamEvent,
  CheckResponse,
  ReportRequest,
  ReportResponse,
  StatusResponse,
  UsageMeResponse,
} from "./types.js";

export * from "./types.js";
export * from "./errors.js";
export { verifyWebhook } from "./webhooks.js";

export interface CheckOptions {
  /** Override the SDK-wide risk profile for this call. */
  riskProfile?: "strict" | "balanced" | "permissive";
  /** Make the call idempotent. Pass `true` to auto-generate a UUID, or a fixed string. */
  idempotencyKey?: string | boolean;
}

export interface AsyncCheckArgs {
  email: string;
  webhookUrl: string;
  /** Optional HMAC-SHA256 key used to sign the final webhook payload. */
  webhookSecret?: string;
}

export class VerifyMail {
  private readonly http: HttpClient;

  constructor(opts: ClientOptions) {
    this.http = new HttpClient(opts);
  }

  /** Check a single email. Charges 1 credit. */
  check(email: string, opts: CheckOptions = {}): Promise<CheckResponse> {
    return this.http.json<CheckResponse>({
      path: "/v1/check",
      body: { email },
      idempotencyKey: opts.idempotencyKey,
      riskProfile: opts.riskProfile,
    });
  }

  /** Check a domain only (no local part). Charges 1 credit. */
  checkDomain(domain: string, opts: CheckOptions = {}): Promise<CheckResponse> {
    return this.http.json<CheckResponse>({
      path: "/v1/check/domain",
      body: { domain },
      idempotencyKey: opts.idempotencyKey,
      riskProfile: opts.riskProfile,
    });
  }

  /** Bulk check 1–100 emails. Charges N credits up front (all-or-nothing). */
  checkBulk(emails: string[], opts: CheckOptions = {}): Promise<BulkCheckResponse> {
    if (emails.length === 0 || emails.length > 100) {
      throw new RangeError("checkBulk requires 1–100 emails.");
    }
    return this.http.json<BulkCheckResponse>({
      path: "/v1/check/bulk",
      body: { emails },
      idempotencyKey: opts.idempotencyKey,
      riskProfile: opts.riskProfile,
    });
  }

  /**
   * Stream bulk-check results as each row completes. Calls `onEvent` once
   * per result (in finish-order) plus once with a final `{event: "summary"}`.
   *
   *   await vm.checkBulkStream(emails, (e) => {
   *     if ("event" in e) console.log("done", e);
   *     else processRow(e.index, e.result);
   *   });
   */
  async checkBulkStream(
    emails: string[],
    onEvent: (e: BulkStreamEvent) => void | Promise<void>,
    opts: Omit<CheckOptions, "idempotencyKey"> = {},
  ): Promise<void> {
    if (emails.length === 0) throw new RangeError("checkBulkStream needs at least one email.");

    const req: RequestOptions = {
      path: "/v1/check/bulk/stream",
      body: { emails },
      riskProfile: opts.riskProfile,
      // Streaming requests aren't safe to auto-retry — would re-charge credits
      // and re-stream rows. Customer must retry explicitly.
      noRetry: true,
    };
    const res = await this.http.raw(req);
    if (!res.body) throw new Error("Streaming response had no body.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      // Drain complete lines; keep the partial tail in buf for the next chunk.
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          await onEvent(JSON.parse(line) as BulkStreamEvent);
        } catch (err) {
          throw new Error(`Failed to parse stream line: ${line}`);
        }
      }
    }
    // Final flush in case the server didn't terminate with newline.
    const tail = buf.trim();
    if (tail) await onEvent(JSON.parse(tail) as BulkStreamEvent);
  }

  /**
   * Async deep check. Returns 202 immediately with a preliminary verdict;
   * VerifyMail POSTs the final result to your webhook URL once the deep
   * SMTP probe completes. Verify the signature with `verifyWebhook()` in
   * your handler before trusting the payload.
   */
  checkAsync(args: AsyncCheckArgs, opts: CheckOptions = {}): Promise<AsyncCheckResponse> {
    return this.http.json<AsyncCheckResponse>({
      path: "/v1/check/async",
      body: {
        email: args.email,
        webhook_url: args.webhookUrl,
        webhook_secret: args.webhookSecret,
      },
      idempotencyKey: opts.idempotencyKey,
      riskProfile: opts.riskProfile,
    });
  }

  /** File a /v1/report for a domain outcome (feedback loop). */
  report(req: ReportRequest): Promise<ReportResponse> {
    return this.http.json<ReportResponse>({
      path: "/v1/report",
      body: req,
    });
  }

  /** Programmatic equivalent of the dashboard's Usage summary. */
  usage(): Promise<UsageMeResponse> {
    return this.http.json<UsageMeResponse>({
      path: "/v1/usage/me",
      method: "GET",
    });
  }

  /** Component health (Redis / Postgres / DNS). Always returns 200. */
  status(): Promise<StatusResponse> {
    return this.http.json<StatusResponse>({
      path: "/v1/status",
      method: "GET",
    });
  }
}

export default VerifyMail;
