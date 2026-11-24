import { WEBHOOK_ORIGIN, WEBHOOK_URL } from "./origin.mjs";
import { botToken, webhookSecret } from "./secret.mjs";

const TOKEN_RE = /^[0-9]+:[A-Za-z0-9_-]+$/;
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;

let inflight = null;
let settled = false;
let state = { status: "pending", error: undefined };

export function webhookStatus() {
  return { status: state.status, error: state.error };
}

export function resetRegistrationForTests() {
  inflight = null;
  settled = false;
  state = { status: "pending", error: undefined };
}

function publicError(description) {
  if (typeof description !== "string") return undefined;
  let text = description.trim();
  if (!text) return undefined;
  const token = botToken();
  const secret = webhookSecret();
  if (token) text = text.split(token).join("[redacted]");
  if (secret) text = text.split(secret).join("[redacted]");
  text = text.split(WEBHOOK_URL).join("[redacted]");
  text = text.split(WEBHOOK_ORIGIN).join("[redacted]");
  text = text.replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[redacted]");
  if (text.length > 180) text = text.slice(0, 180);
  return text;
}

function remember(status, description) {
  state = { status, error: publicError(description) };
  settled = true;
}

function allowedWebhookUrl() {
  if (WEBHOOK_URL !== "https://group-inbox.apps.grok.bot/telegram") return null;
  if (WEBHOOK_ORIGIN !== "https://group-inbox.apps.grok.bot") return null;
  let url;
  try {
    url = new URL(WEBHOOK_URL);
  } catch {
    return null;
  }
  if (url.origin !== WEBHOOK_ORIGIN) return null;
  if (url.protocol !== "https:" || url.hostname !== "group-inbox.apps.grok.bot") return null;
  if (url.pathname !== "/telegram" || url.search || url.hash || url.username || url.password) return null;
  return "https://group-inbox.apps.grok.bot/telegram";
}

async function telegramMethod(token, method, body) {
  const endpoint = new URL(`https://api.telegram.org/bot${token}/${method}`);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "api.telegram.org" ||
    endpoint.pathname !== `/bot${token}/${method}`
  ) {
    return { ok: false, description: "telegram request rejected" };
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    console.error("webhook registration failed");
    return { ok: false, description: "telegram request failed" };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    console.error("webhook registration failed");
    return { ok: false, description: "telegram request failed" };
  }
  if (!response.ok || !data || data.ok !== true) {
    console.error(`webhook registration failed ${response.status}`);
    const description = data && typeof data.description === "string"
      ? data.description
      : "telegram request failed";
    return { ok: false, description };
  }
  return { ok: true, result: data.result };
}

async function registerAndConfirm(token, secret) {
  const webhookUrl = allowedWebhookUrl();
  if (!webhookUrl || webhookUrl.includes(token) || webhookUrl.includes(secret)) {
    remember("failed", "telegram request rejected");
    return false;
  }

  const set = await telegramMethod(token, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message"],
  });
  if (!set.ok) {
    remember("failed", set.description);
    return false;
  }

  const info = await telegramMethod(token, "getWebhookInfo");
  if (!info.ok) {
    remember("failed", info.description);
    return false;
  }

  const result = info.result && typeof info.result === "object" ? info.result : {};
  const current = typeof result.url === "string" ? result.url : "";
  const deliveryError = typeof result.last_error_message === "string" ? result.last_error_message : undefined;
  if (current === webhookUrl) {
    remember("registered", deliveryError);
    console.error("webhook registered");
    return true;
  }
  remember("pending", deliveryError);
  return false;
}

/** First request only. Later calls reuse the recorded status. */
export function ensureRegistered() {
  if (settled) return Promise.resolve(state.status === "registered");
  if (inflight) return inflight;

  const token = botToken();
  const secret = webhookSecret();
  if (!token || !secret) return Promise.resolve(false);
  if (!TOKEN_RE.test(token) || !SECRET_RE.test(secret)) return Promise.resolve(false);
  if (!allowedWebhookUrl()) {
    remember("failed", "telegram request rejected");
    return Promise.resolve(false);
  }

  inflight = registerAndConfirm(token, secret).finally(() => {
    inflight = null;
  });
  return inflight;
}
