# verifymailapi

[![npm version](https://img.shields.io/npm/v/verifymailapi.svg)](https://www.npmjs.com/package/verifymailapi) [![types](https://img.shields.io/npm/types/verifymailapi.svg)](https://www.npmjs.com/package/verifymailapi) [![license](https://img.shields.io/npm/l/verifymailapi.svg)](./LICENSE)

**Official Node / TypeScript SDK for the [VerifyMail API](https://verifymailapi.com)** — detect disposable, throwaway, and abusive emails before they reach your database.

```ts
import { VerifyMail } from "verifymailapi";

const vm = new VerifyMail({ apiKey: process.env.VERIFYMAIL_KEY! });

const { verdict } = await vm.check("user@example.com");
console.log(verdict.recommendation); // "allow" | "allow_with_flag" | "block"
```

---

## Install

```bash
npm install verifymailapi
# or
pnpm add verifymailapi
# or
yarn add verifymailapi
```

Works in any modern server runtime: **Node 18+, Bun, Deno, Vercel Edge / Functions, Cloudflare Workers, Railway, Fly.io**. Uses native `fetch` — zero dependencies.

> **Server-side only.** Never call this from a browser bundle — your API key would leak. Use it inside a server action, API route, or backend service.

---

## Production-ready example

This is what a real signup handler looks like. Copy-paste it into a Next.js server action, an Express route, or a Hono handler — the shape is the same everywhere.

```ts
import {
  VerifyMail,
  QuotaExceededError,
  RateLimitError,
  VerifyMailError,
} from "verifymailapi";

// Instantiate once per process, reuse per request.
const vm = new VerifyMail({
  apiKey: process.env.VERIFYMAIL_KEY!,
  riskProfile: "balanced",   // strict | balanced | permissive
});

export async function handleSignup(email: string, requestId: string) {
  let result;
  try {
    result = await vm.check(email, {
      // Idempotent — safe to retry a flaky network without double-charging.
      idempotencyKey: `signup:${requestId}`,
    });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      // Out of credits — don't bounce real customers. Allow with a flag.
      return { ok: true, action: "allow_with_flag", reason: "verifymail_unavailable" };
    }
    if (err instanceof RateLimitError) {
      return { ok: false, error: "Please retry in a moment.", retryAfter: err.retryAfter };
    }
    if (err instanceof VerifyMailError) {
      // Log the error and fail open — losing one signup hurts more than
      // briefly skipping fraud detection.
      console.error("VerifyMail:", err.code, err.message, err.requestId);
      return { ok: true, action: "allow", reason: "verifymail_error" };
    }
    throw err;
  }

  switch (result.verdict.recommendation) {
    case "block":
      // Reject the signup. result.verdict.summary explains *why*.
      return { ok: false, error: result.verdict.summary };
    case "allow_with_flag":
      // Pass through, but route this user through your verification step
      // (email confirmation link, captcha, slower onboarding — whatever
      // your app already has).
      return { ok: true, action: "allow_with_flag" };
    case "allow":
      return { ok: true, action: "allow" };
  }
}
```

That's the canonical pattern. Everything below is reference detail.

---

## API

### `new VerifyMail(options)`

| Option | Type | Default | Notes |
|---|---|---|---|
| `apiKey` | `string` | **required** | Your `dc_…` key from the [dashboard](https://verifymailapi.com/dashboard/keys). |
| `baseUrl` | `string` | `https://api.verifymailapi.com` | Override for staging or self-hosted. |
| `retries` | `number` | `2` | Retries on `429` / `5xx`. Set `0` to disable. |
| `timeoutMs` | `number` | `30000` | Per-request timeout. |
| `riskProfile` | `"strict" \| "balanced" \| "permissive"` | server default | Per-call `riskProfile` overrides this. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Inject for tests or non-Node runtimes. |

### Methods

| Method | What it does |
|---|---|
| **`vm.check(email, opts?)`** | Check one email. Charges 1 credit. Returns the full 5-block response. |
| **`vm.checkDomain(domain, opts?)`** | Check a domain only (no local part). Charges 1 credit. |
| **`vm.checkBulk(emails[], opts?)`** | 1–100 emails per call. Charges N up front, all-or-nothing. Order preserved. |
| **`vm.checkBulkStream(emails[], onEvent, opts?)`** | NDJSON streaming version of `checkBulk`. Use for 5k+ batches. |
| **`vm.checkAsync({ email, webhookUrl, webhookSecret? }, opts?)`** | Returns 202 immediately with a preliminary verdict. The final result is POSTed to your webhook. |
| **`vm.report({ domain, outcome, notes? })`** | Tell us when a domain turned out to be confirmed throwaway / legitimate / suspected. |
| **`vm.usage()`** | Current-period totals + credit balance — same shape your dashboard reads. |
| **`vm.status()`** | Component health (Redis / Postgres / DNS). Always returns 200. |

Every method that costs credits accepts `{ idempotencyKey: true }` (auto-generated UUID) or `{ idempotencyKey: "your-string" }`.

---

## Verdicts — what to do with each

```ts
switch (result.verdict.recommendation) {
  case "block":           // High confidence: abuse, dead address, or a disposable provider.
  case "allow_with_flag": // Suspicious. Route through your verification step.
  case "allow":           // Clean. Proceed normally.
}
```

**The most important rule:** map `allow_with_flag` to `user.requires_email_verification = true` (or whatever your friction-step is called). Most B2B apps already have email verification — that one line costs zero new code and catches the vast majority of bot signups.

If your app doesn't have email verification, add one. It's the cheapest fraud defense in existence and the API is designed around the assumption that you have it.

---

## Errors

All HTTP failures become typed errors so you can branch cleanly:

```ts
import {
  VerifyMailError,
  InvalidApiKeyError,
  QuotaExceededError,
  RateLimitError,
  IdempotencyConflictError,
  ValidationError,
  ServiceDegradedError,
} from "verifymailapi";

try {
  await vm.check(email);
} catch (err) {
  if (err instanceof QuotaExceededError) return showBilling(err.upgradeUrl);
  if (err instanceof RateLimitError)     return retryAfter(err.retryAfter); // seconds
  if (err instanceof InvalidApiKeyError) return alertOps("VerifyMail key rotated?");
  if (err instanceof VerifyMailError)    return logAndFallback(err);
  throw err;
}
```

Every error carries:

| Property | Type | Example |
|---|---|---|
| `code` | `string` | `"too_many_requests"`, `"quota_exceeded"`, … |
| `status` | `number` | HTTP status (`429`, `402`, …) |
| `requestId` | `string \| undefined` | Pass this when filing support tickets. |
| `docsUrl` | `string \| undefined` | Direct link to the relevant docs section. |
| `message` | `string` | Human-readable. |

Specific subclasses add specific fields — `RateLimitError.retryAfter`, `QuotaExceededError.upgradeUrl`, etc.

---

## Idempotency

`POST` endpoints that charge credits all accept an `Idempotency-Key` header. Replay the same key within **24 hours** and you get the cached response back — no duplicate work, no duplicate charge.

```ts
// Auto-generate a UUID v4
await vm.check(email, { idempotencyKey: true });

// Or pass your own (correlate with your own request ID)
await vm.check(email, { idempotencyKey: `signup:${requestId}` });
```

Re-using the same key with a different request body throws `IdempotencyConflictError` (HTTP 409). Pick a new key or send the original payload.

---

## Bulk processing

### Small batches (≤ 100 emails)

```ts
const { items, summary } = await vm.checkBulk(["a@x.com", "b@x.com", "c@x.com"]);

// items[i] matches emails[i] (order preserved).
items.forEach((r, i) => console.log(r.meta.domain, "→", r.verdict.recommendation));
console.log(`charged ${summary.credits_charged} credits in ${summary.elapsed_ms}ms`);
```

### Large batches (5k–100k addresses)

Stream results as each check completes — process rows immediately instead of waiting for the whole batch:

```ts
await vm.checkBulkStream(emails, (event) => {
  if ("event" in event) {
    console.log("done — credits remaining:", event.credits_remaining);
    return;
  }
  // event = { index: number, result: CheckResponse }
  await processRow(event.index, event.result);
});
```

Results arrive in **finish order**, not input order — correlate via `event.index`.

---

## Async deep checks (webhooks)

For workflows where the user can wait for an email but not a synchronous SMTP probe:

```ts
const { request_id, preliminary } = await vm.checkAsync({
  email: "user@example.com",
  webhookUrl: "https://your-app.example/webhooks/verifymail",
  webhookSecret: process.env.VERIFYMAIL_WEBHOOK_SECRET,
});

// `preliminary` is the fast-path verdict you can act on immediately.
// The deep SMTP probe runs in the background; the final result lands at your webhook.
```

### Verifying the webhook signature

```ts
import express from "express";
import { verifyWebhook } from "verifymailapi";

app.post(
  "/webhooks/verifymail",
  // IMPORTANT: raw body, not json — verifyWebhook needs the original bytes.
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.header("X-VerifyMail-Signature") ?? "";
    if (!verifyWebhook(req.body, sig, process.env.VERIFYMAIL_WEBHOOK_SECRET!)) {
      return res.status(401).send("bad signature");
    }
    const event = JSON.parse(req.body.toString("utf8"));
    // event.result is the final CheckResponse with the deep verdict.
    await handleFinalVerdict(event);
    res.status(200).end();
  },
);
```

Same idea in Hono / Fastify / Next.js Route Handlers — just keep the body bytes raw until after `verifyWebhook` returns true.

---

## Framework recipes

### Next.js — Server Action

```ts
// app/actions.ts
"use server";

import { VerifyMail, QuotaExceededError } from "verifymailapi";

const vm = new VerifyMail({ apiKey: process.env.VERIFYMAIL_KEY! });

export async function signupAction(_: unknown, formData: FormData) {
  const email = String(formData.get("email"));
  try {
    const r = await vm.check(email);
    if (r.verdict.recommendation === "block") {
      return { ok: false, error: r.verdict.summary };
    }
    await db.user.create({
      data: { email, requires_verification: r.verdict.recommendation === "allow_with_flag" },
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof QuotaExceededError) return { ok: true }; // fail open
    throw err;
  }
}
```

### Express — middleware

```ts
import { VerifyMail } from "verifymailapi";

const vm = new VerifyMail({ apiKey: process.env.VERIFYMAIL_KEY! });

app.post("/signup", async (req, res) => {
  const r = await vm.check(req.body.email);
  if (r.verdict.recommendation === "block") {
    return res.status(422).json({ error: r.verdict.summary });
  }
  const user = await createUser({
    ...req.body,
    requires_verification: r.verdict.recommendation === "allow_with_flag",
  });
  res.json(user);
});
```

### Cloudflare Workers / Edge

```ts
import { VerifyMail } from "verifymailapi";

export default {
  async fetch(req: Request, env: Env) {
    const vm = new VerifyMail({ apiKey: env.VERIFYMAIL_KEY });
    const { email } = await req.json();
    const r = await vm.check(email);
    return Response.json(r);
  },
};
```

---

## Rate limits

The API enforces **600 requests / minute per key** by default (configurable for paying customers). The SDK automatically:

- Reads `Retry-After` on `429` responses.
- Backs off and retries up to `retries` times (default `2`).
- Surfaces the limit info on the thrown `RateLimitError` if all retries fail.

Look at the response headers `X-RateLimit-Remaining` / `X-RateLimit-Reset` if you want to throttle preemptively in your own queue.

---

## TypeScript

The package ships full `.d.ts` types. Every response field is typed; every verdict / risk level / signal direction is a literal union you can `switch` over exhaustively.

```ts
import type {
  CheckResponse,
  Recommendation,
  RiskLevel,
  Signal,
  BulkCheckResponse,
  CheckCompletedEvent,
} from "verifymailapi";
```

Strict mode + `noUncheckedIndexedAccess` clean. Works with `"moduleResolution": "Bundler"`, `"node16"`, and classic `"node"`.

---

## Configuration via environment

This SDK doesn't read env vars itself — you pass them. Recommended names:

| Var | Purpose |
|---|---|
| `VERIFYMAIL_KEY` | Your `dc_…` API key |
| `VERIFYMAIL_WEBHOOK_SECRET` | Optional shared secret for `vm.checkAsync(...)` |
| `VERIFYMAIL_API_URL` | Optional override of `baseUrl` for staging |

---

## Links

- **Full API docs:** https://verifymailapi.com/docs
- **Dashboard / API keys:** https://verifymailapi.com/dashboard/keys
- **Issues / discussions:** https://github.com/jt1402/verifymail-js
- **Pricing:** https://verifymailapi.com/pricing

## License

MIT
