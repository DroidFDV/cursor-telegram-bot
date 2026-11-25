import { createHash, timingSafeEqual } from "node:crypto";

/** Bot token, only from the environment. Never log or send this value. */
export function botToken() {
  const value = process.env.TELEGRAM_BOT_TOKEN;
  return typeof value === "string" ? value.trim() : "";
}

/** Webhook secret, only from the environment. Never log or send this value. */
export function webhookSecret() {
  return trimmedEnv("TELEGRAM_WEBHOOK_SECRET");
}

export function inboxReadKey() {
  const trimmed = trimmedEnv("INBOX_READ_KEY");
  // One accidental wrapper only. A second "key=" is left in place.
  if (trimmed.startsWith("key=") && trimmed.length > 4) return trimmed.slice(4);
  return trimmed;
}

function trimmedEnv(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
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
  if (expected.length < 16 || typeof header !== "string" || header.length === 0) {
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
