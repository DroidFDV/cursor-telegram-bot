import { WEBHOOK_ORIGIN, WEBHOOK_URL } from "./origin.mjs";
import { botToken, webhookSecret } from "./secret.mjs";

const TOKEN_RE = /^[0-9]+:[A-Za-z0-9_-]+$/;
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;
const RETRY_MS = 60_000;

let registeredFor = null;
let inflight = null;
let notBefore = 0;
let warned = false;

export function resetRegistrationForTests() {
  registeredFor = null;
  inflight = null;
  notBefore = 0;
  warned = false;
}

function skipOnce() {
  if (warned) return;
  warned = true;
  console.error("webhook registration skipped");
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

async function postSetWebhook(token, secret) {
  const endpoint = new URL(`https://api.telegram.org/bot${token}/setWebhook`);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "api.telegram.org" ||
    !endpoint.pathname.endsWith("/setWebhook")
  ) {
    skipOnce();
    return false;
  }

  const webhookUrl = allowedWebhookUrl();
  if (!webhookUrl || webhookUrl.includes(token) || webhookUrl.includes(secret)) {
    skipOnce();
    return false;
  }

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secret,
        allowed_updates: ["message"],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    console.error("webhook registration failed");
    return false;
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    console.error("webhook registration failed");
    return false;
  }
  if (!response.ok || !data || data.ok !== true) {
    console.error(`webhook registration failed ${response.status}`);
    return false;
  }
  console.error("webhook registered");
  return true;
}

export function ensureRegistered() {
  const origin = allowedWebhookUrl();
  if (!origin) {
    skipOnce();
    return Promise.resolve(false);
  }
  if (registeredFor === origin) return Promise.resolve(true);
  if (inflight) return inflight;
  if (Date.now() < notBefore) return Promise.resolve(false);

  const token = botToken();
  const secret = webhookSecret();
  if (!token || !secret) return Promise.resolve(false);
  if (!TOKEN_RE.test(token) || !SECRET_RE.test(secret)) {
    skipOnce();
    return Promise.resolve(false);
  }

  inflight = postSetWebhook(token, secret)
    .then((ok) => {
      if (ok) registeredFor = origin;
      else notBefore = Date.now() + RETRY_MS;
      return ok;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
