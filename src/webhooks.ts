import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an incoming webhook signature from a `/v1/check/async` completion.
 *
 *   const ok = verifyWebhook(rawBody, req.header("X-VerifyMail-Signature"), secret);
 *   if (!ok) return res.status(401).end();
 *
 * Pass the *raw* request body bytes — not the parsed JSON. In Express:
 *   app.post("/webhook", express.raw({ type: "application/json" }), handler)
 */
export function verifyWebhook(
  rawBody: Buffer | Uint8Array | string,
  signatureHeader: string | null | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const body =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
  const expected =
    "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
