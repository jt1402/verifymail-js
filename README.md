# verifymail

Official Node / TypeScript SDK for the [VerifyMail API](https://verifymailapi.com) — disposable, throwaway, and abusive email detection.

```ts
import { VerifyMail } from "verifymail";

const vm = new VerifyMail({ apiKey: process.env.VERIFYMAIL_KEY! });

const result = await vm.check("user@example.com");

switch (result.verdict.recommendation) {
  case "block":
    throw new Error("This email cannot be used.");
  case "allow_with_flag":
    user.requires_email_verification = true;
    await sendVerificationEmail(user);
    break;
  case "allow":
    // Clean. Proceed.
    break;
}
```

## Install

```bash
npm install verifymail
# or
pnpm add verifymail
```

Requires Node 18+ (uses native `fetch`). Works in any modern server runtime — Node, Bun, Deno, Vercel Functions, Cloudflare Workers.

## API

### `new VerifyMail(options)`

| Option | Default | Description |
|---|---|---|
| `apiKey` | (required) | Your `dc_…` API key from the dashboard. |
| `baseUrl` | `https://api.verifymailapi.com` | Override for staging. |
| `retries` | `2` | Retries on 429 / 5xx with backoff. Set to 0 to disable. |
| `timeoutMs` | `30000` | Per-request timeout. |
| `riskProfile` | (server default) | `"strict"` / `"balanced"` / `"permissive"`. Per-call override available. |
| `fetch` | `globalThis.fetch` | Inject a custom fetch (tests, edge runtimes). |

### `vm.check(email, opts?)`

Checks a single email. Returns a `CheckResponse` (the five-block schema).

```ts
const r = await vm.check("user@example.com", { idempotencyKey: true });
console.log(r.verdict.recommendation, r.score.value);
```

### `vm.checkDomain(domain, opts?)`

Domain-only check (skips syntax validation). Same 1-credit cost.

### `vm.checkBulk(emails[], opts?)`

Submit 1–100 emails. Charges N credits up front, all-or-nothing.

```ts
const { items, summary } = await vm.checkBulk(["a@x.com", "b@x.com"]);
// items[i] matches emails[i] (order preserved).
```

### `vm.checkBulkStream(emails[], onEvent, opts?)`

For large batches (5k–100k addresses). Calls `onEvent` once per finished row + once with a `{ event: "summary" }` final line. Results arrive in finish order; correlate via `index`.

```ts
await vm.checkBulkStream(emails, (e) => {
  if ("event" in e) {
    console.log("done — credits remaining:", e.credits_remaining);
  } else {
    processRow(e.index, e.result);
  }
});
```

### `vm.checkAsync({ email, webhookUrl, webhookSecret? })`

Two-phase verification. Returns a 202 immediately with a preliminary verdict; the final result is POSTed to your webhook URL after the deep SMTP probe completes.

```ts
const { request_id, preliminary } = await vm.checkAsync({
  email: "user@example.com",
  webhookUrl: "https://your-app.example/webhooks/verifymail",
  webhookSecret: process.env.VERIFYMAIL_WEBHOOK_SECRET,
});
```

In your webhook handler, verify the signature with `verifyWebhook()`:

```ts
import express from "express";
import { verifyWebhook } from "verifymail";

app.post(
  "/webhooks/verifymail",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.header("X-VerifyMail-Signature") ?? "";
    if (!verifyWebhook(req.body, sig, process.env.VERIFYMAIL_WEBHOOK_SECRET!)) {
      return res.status(401).send("bad signature");
    }
    const event = JSON.parse(req.body.toString("utf8"));
    // event.result is the final CheckResponse.
    res.status(200).end();
  },
);
```

### `vm.report({ domain, outcome, notes? })`

Tell us when a domain turned out to be confirmed throwaway / legitimate / suspected.

### `vm.usage()`

Returns the same shape the dashboard reads — current-period totals + remaining credit balance.

### `vm.status()`

Per-component health (Redis, Postgres, DNS). Always 200; read individual fields.

## Errors

```ts
import {
  VerifyMailError,
  InvalidApiKeyError,
  QuotaExceededError,
  RateLimitError,
  IdempotencyConflictError,
  ValidationError,
  ServiceDegradedError,
} from "verifymail";

try {
  await vm.check(email);
} catch (e) {
  if (e instanceof QuotaExceededError) return showBilling(e.upgradeUrl);
  if (e instanceof RateLimitError) return retryLater(e.retryAfter);
  if (e instanceof VerifyMailError) return logAndShowGeneric(e);
  throw e;
}
```

All errors carry `code`, `status`, `requestId`, `docsUrl`, and the original `body` payload when available.

## Idempotency

Pass `idempotencyKey: true` to auto-generate a UUID v4, or pass a fixed string you choose. Within 24 hours the same key replays the cached response with no duplicate charge. Re-using a key with a different body throws `IdempotencyConflictError`.

## License

MIT
