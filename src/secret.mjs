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
  const trimmed = typeof value === "string" ? value.trim() : "";
  // One accidental wrapper: a leading "key=" makes a 43-character secret 47 characters.
  if (trimmed.startsWith("key=") && trimmed.length > 4) return trimmed.slice(4);
  return trimmed;
}

export function inboxKeySet() {
  return inboxReadKey().length > 0;
}

export function inboxKeyLength() {
  return inboxReadKey().length;
}

function keysMatch(expected, provided) {
  if (expected.length === 0 || provided.length === 0) return false;
  const actualHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

function bearerToken(header) {
  if (typeof header !== "string") return "";
  const match = header.trim().match(/^Bearer\s+(\S.*)$/i);
  return match ? match[1].trim() : "";
}

export function inboxAuthorized(inboxHeader, authorizationHeader) {
  const expected = inboxReadKey();
  const fromInbox = typeof inboxHeader === "string" ? inboxHeader.trim() : "";
  return keysMatch(expected, fromInbox) || keysMatch(expected, bearerToken(authorizationHeader));
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
