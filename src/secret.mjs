import { createHash, timingSafeEqual } from "node:crypto";

/** Bot token, only from the environment. Never log or send this value. */
export function botToken() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  return typeof value === "string" ? value.trim() : "";
}

/** Webhook secret, only from the environment. Never log or send this value. */
export function webhookSecret() {
  const value = process.env.TELEGRAM_WEBHOOK_SECRET;
  return typeof value === "string" ? value.trim() : "";
}

export function inboxReadKey() {
  const value = process.env.INBOX_READ_KEY;
  return typeof value === "string" ? value.trim() : "";
}

export function inboxKeySet() {
  return inboxReadKey().length > 0;
}

export function inboxAuthorized(header) {
  const expected = inboxReadKey();
  const provided = typeof header === "string" ? header.trim() : "";
  if (expected.length === 0 || provided.length === 0) return false;
  const actualHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function webhookAuthorized(header) {
  const expected = webhookSecret();
  if (expected.length === 0 || typeof header !== "string" || header.length === 0) {
    return false;
  }
  const actualHash = createHash("sha256").update(header).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function responseLeaksSecret(payload) {
  const token = botToken();
  const secret = webhookSecret();
  const inboxKey = inboxReadKey();
  if (token.length >= 8 && payload.includes(token)) return true;
  if (secret.length >= 8 && payload.includes(secret)) return true;
  if (inboxKey.length >= 8 && payload.includes(inboxKey)) return true;
  return false;
}
