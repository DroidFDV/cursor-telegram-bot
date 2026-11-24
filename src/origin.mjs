/** Host-provided public origin. Not a secret and not bound as one. */
export const ORIGIN_ENV = "CURSOR_APP_URL";

function containsConfiguredSecret(value) {
  const token = typeof process.env.TELEGRAM_BOT_TOKEN === "string"
    ? process.env.TELEGRAM_BOT_TOKEN.trim()
    : "";
  const secret = typeof process.env.TELEGRAM_WEBHOOK_SECRET === "string"
    ? process.env.TELEGRAM_WEBHOOK_SECRET.trim()
    : "";
  if (token.length >= 8 && value.includes(token)) return true;
  if (secret.length >= 8 && value.includes(secret)) return true;
  return false;
}

function hostnameOk(host) {
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  if (host.startsWith(".") || host.endsWith(".") || host.includes("..")) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host.endsWith(".internal") || host === "host.docker.internal") return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    !label.startsWith("-") &&
    !label.endsWith("-")
  );
}

/** https origin with no path, query, userinfo, or secret material. */
export function normalizeOrigin(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 300) return null;
  if (containsConfiguredSecret(trimmed)) return null;
  const withScheme = /^https:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.port !== "" && url.port !== "443") return null;
  const host = url.hostname;
  if (!hostnameOk(host)) return null;
  if (containsConfiguredSecret(host)) return null;
  return `https://${host}`;
}

export function originFromEnv() {
  return normalizeOrigin(process.env[ORIGIN_ENV]);
}
