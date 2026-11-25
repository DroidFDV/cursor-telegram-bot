import { createHash } from "node:crypto";

const WINDOW_MS = 60_000;
const FAIL_LIMIT = 10;
const buckets = new Map();

export function resetAuthLimitsForTests() {
  buckets.clear();
}

/** Trusted platform address only. A client-supplied X-Forwarded-For is ignored. */
export function clientKey(trustedForwardedFor) {
  const raw = Array.isArray(trustedForwardedFor) ? trustedForwardedFor[0] : trustedForwardedFor;
  if (typeof raw !== "string" || !raw.trim()) return "shared";
  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
  const address = parts[parts.length - 1];
  if (!address) return "shared";
  return createHash("sha256").update(`trusted:${address}`).digest("hex").slice(0, 32);
}

function entry(scope, client) {
  const key = `${scope}:${client}`;
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.start >= WINDOW_MS) {
    const fresh = { start: now, hits: 0 };
    buckets.set(key, fresh);
    return fresh;
  }
  return current;
}

export function authFailureBlocked(scope, client) {
  const current = buckets.get(`${scope}:${client}`);
  if (!current || Date.now() - current.start >= WINDOW_MS) return false;
  return current.hits >= FAIL_LIMIT;
}

export function recordAuthFailure(scope, client) {
  const current = entry(scope, client);
  current.hits += 1;
}
