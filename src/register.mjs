import { sql } from "./db.mjs";
import { WEBHOOK_ORIGIN, WEBHOOK_URL } from "./origin.mjs";
import { botToken, webhookSecret } from "./secret.mjs";

const TOKEN_RE = /^[0-9]+:[A-Za-z0-9_-]+$/;
const SECRET_RE = /^[A-Za-z0-9_-]{1,256}$/;
const MIN_INTERVAL_MS = 60_000;

let inflight = null;
let schemaReady = null;
let memory = freshMemory();

function freshMemory() {
  return { status: "pending", error: undefined, nextAttemptAt: 0, known: false };
}

export function webhookStatus() {
  return { status: memory.status, error: memory.error };
}

export async function resetRegistrationForTests() {
  inflight = null;
  schemaReady = null;
  memory = freshMemory();
  try {
    await sql("delete from webhook_state");
  } catch {
    // The table is created on the first registration attempt.
  }
}

export function forgetMemoryForTests() {
  inflight = null;
  memory = freshMemory();
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

function applyMemory(next) {
  memory = {
    status: next.status,
    error: next.error,
    nextAttemptAt: next.nextAttemptAt || 0,
    known: true,
  };
}

async function ensureSchema() {
  schemaReady ??= sql(
    `create table if not exists webhook_state (
      id integer primary key,
      status text not null,
      error text,
      next_attempt_at timestamptz,
      constraint webhook_state_id_chk check (id = 1),
      constraint webhook_state_status_chk check (status in ('pending', 'registered', 'failed'))
    )`,
  ).then(() => {});
  return schemaReady;
}

function asTime(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

async function loadState() {
  await ensureSchema();
  const rows = await sql(
    "select status, error, next_attempt_at from webhook_state where id = 1",
  );
  if (!rows[0]) return null;
  return {
    status: rows[0].status,
    error: typeof rows[0].error === "string" ? rows[0].error : undefined,
    nextAttemptAt: asTime(rows[0].next_attempt_at),
  };
}

async function saveState(status, error, nextAttemptAt) {
  await ensureSchema();
  const when = nextAttemptAt ? new Date(nextAttemptAt).toISOString() : null;
  await sql(
    `insert into webhook_state (id, status, error, next_attempt_at)
     values (1, $1, $2, $3)
     on conflict (id) do update
     set status = excluded.status,
         error = excluded.error,
         next_attempt_at = excluded.next_attempt_at`,
    [status, error ?? null, when],
  );
  applyMemory({ status, error, nextAttemptAt: nextAttemptAt || 0 });
}

async function claimAttempt() {
  await ensureSchema();
  const until = new Date(Date.now() + MIN_INTERVAL_MS).toISOString();
  const rows = await sql(
    `insert into webhook_state (id, status, error, next_attempt_at)
     values (1, 'pending', null, $1)
     on conflict (id) do update
     set next_attempt_at = excluded.next_attempt_at
     where webhook_state.status <> 'registered'
       and (webhook_state.next_attempt_at is null or webhook_state.next_attempt_at <= now())
     returning id`,
    [until],
  );
  return rows.length > 0;
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

function retryAfterSeconds(data) {
  const param = data && data.parameters && data.parameters.retry_after;
  if (typeof param === "number" && Number.isFinite(param) && param > 0) return param;
  const description = data && data.description;
  if (typeof description === "string") {
    const match = description.match(/retry after (\d+)/i);
    if (match) return Number(match[1]);
  }
  return 0;
}

function cooldownMs(retryAfter) {
  const fromTelegram = retryAfter > 0 ? retryAfter * 1000 : 0;
  return Math.max(MIN_INTERVAL_MS, fromTelegram);
}

async function telegramMethod(token, method, body) {
  const endpoint = new URL(`https://api.telegram.org/bot${token}/${method}`);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.hostname !== "api.telegram.org" ||
    endpoint.pathname !== `/bot${token}/${method}`
  ) {
    return { ok: false, description: "telegram request rejected", retryAfter: 0 };
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
    return { ok: false, description: "telegram request failed", retryAfter: 0 };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    console.error("webhook registration failed");
    return { ok: false, description: "telegram request failed", retryAfter: 0 };
  }
  if (!response.ok || !data || data.ok !== true) {
    console.error(`webhook registration failed ${response.status}`);
    const description = data && typeof data.description === "string"
      ? data.description
      : "telegram request failed";
    return { ok: false, description, retryAfter: retryAfterSeconds(data) };
  }
  return { ok: true, result: data.result, retryAfter: 0 };
}

function infoUrl(info) {
  const result = info.result && typeof info.result === "object" ? info.result : {};
  return typeof result.url === "string" ? result.url : "";
}

function infoError(info) {
  const result = info.result && typeof info.result === "object" ? info.result : {};
  return typeof result.last_error_message === "string" ? result.last_error_message : undefined;
}

async function registerAndConfirm(token, secret) {
  const webhookUrl = allowedWebhookUrl();
  if (!webhookUrl || webhookUrl.includes(token) || webhookUrl.includes(secret)) {
    await saveState("failed", publicError("telegram request rejected"), Date.now() + MIN_INTERVAL_MS);
    return false;
  }

  const persisted = await loadState();
  if (persisted?.status === "registered") {
    applyMemory(persisted);
    return true;
  }
  if (persisted && persisted.nextAttemptAt > Date.now()) {
    applyMemory(persisted);
    return false;
  }

  const claimed = await claimAttempt();
  if (!claimed) {
    const current = await loadState();
    if (current) applyMemory(current);
    return current?.status === "registered";
  }

  const info = await telegramMethod(token, "getWebhookInfo");
  if (!info.ok) {
    await saveState("failed", publicError(info.description), Date.now() + cooldownMs(info.retryAfter));
    return false;
  }
  if (infoUrl(info) === webhookUrl) {
    await saveState("registered", publicError(infoError(info)), 0);
    console.error("webhook registered");
    return true;
  }

  const set = await telegramMethod(token, "setWebhook", {
    url: webhookUrl,
    secret_token: secret,
    allowed_updates: ["message"],
  });
  if (!set.ok) {
    await saveState("failed", publicError(set.description), Date.now() + cooldownMs(set.retryAfter));
    return false;
  }

  const confirmed = await telegramMethod(token, "getWebhookInfo");
  if (!confirmed.ok) {
    await saveState("failed", publicError(confirmed.description), Date.now() + cooldownMs(confirmed.retryAfter));
    return false;
  }
  if (infoUrl(confirmed) === webhookUrl) {
    await saveState("registered", publicError(infoError(confirmed)), 0);
    console.error("webhook registered");
    return true;
  }
  await saveState("pending", publicError(infoError(confirmed)), Date.now() + MIN_INTERVAL_MS);
  return false;
}

/** At most one registration attempt per minute, shared across requests. */
export function ensureRegistered() {
  if (memory.known && memory.status === "registered") return Promise.resolve(true);
  if (memory.known && memory.nextAttemptAt > Date.now()) return Promise.resolve(false);
  if (inflight) return inflight;

  const token = botToken();
  const secret = webhookSecret();
  if (!token || !secret) return Promise.resolve(false);
  if (!TOKEN_RE.test(token) || !SECRET_RE.test(secret)) return Promise.resolve(false);
  if (!allowedWebhookUrl()) return Promise.resolve(false);

  inflight = registerAndConfirm(token, secret).finally(() => {
    inflight = null;
  });
  return inflight;
}
