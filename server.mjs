import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { authFailureBlocked, clientKey, recordAuthFailure } from "./src/auth-limit.mjs";
import { prepareDatabase } from "./src/db.mjs";
import { insertMessage, listMessages, takeInboxRead, takeWebhookInsert } from "./src/messages.mjs";
import { toRecord } from "./src/record.mjs";
import { ensureRegistered } from "./src/register.mjs";
import { botToken, inboxAuthorized, inboxDiagnostics, responseLeaksSecret, webhookAuthorized, webhookSecret, webhookSecretShorterThan16 } from "./src/secret.mjs";

const BODY_LIMIT = 1_048_576;

export function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    function fail(err) {
      if (settled) return;
      settled = true;
      reject(err);
    }

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(Object.assign(new Error("body too large"), { code: "LIMIT" }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (err && err.code === "LIMIT") return;
      fail(err);
    });
  });
}

function requestUrl(raw) {
  try {
    return new URL(raw || "/", "http://127.0.0.1");
  } catch {
    return new URL("http://127.0.0.1/");
  }
}

function pathname(req) {
  return requestUrl(req.url).pathname;
}

function afterId(searchParams) {
  if (!searchParams) return null;
  const raw = searchParams.get("after");
  if (raw == null || raw === "") return null;
  if (!/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return undefined;
  return value;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  if (responseLeaksSecret(payload)) {
    res.writeHead(500, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end('{"ok":false}');
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function dispatch({ method, path, searchParams, secretHeader, inboxKey, authorization, forwardedFor, readRequestBody }) {
  if (method === "GET" && path === "/health") {
    return {
      status: 200,
      body: {
        ok: true,
        ...inboxDiagnostics(),
        webhookSecretShorterThan16: webhookSecretShorterThan16(),
      },
    };
  }

  const client = clientKey(forwardedFor);

  if (method === "GET" && path === "/inbox") {
    if (authFailureBlocked("inbox", client)) return { status: 404, body: { ok: false } };
    if (!inboxAuthorized(inboxKey, authorization)) {
      recordAuthFailure("inbox", client);
      return { status: 404, body: { ok: false } };
    }
    const allowed = await takeInboxRead().catch((err) => {
      const code = err && typeof err.code === "string" ? err.code : "error";
      console.error(`inbox limit failed ${code}`);
      return false;
    });
    if (!allowed) return { status: 429, body: { ok: false } };
    await ensureRegistered().catch(() => {
      console.error("webhook registration failed");
    });
    const after = afterId(searchParams);
    if (after === undefined) return { status: 400, body: { ok: false } };
    try {
      const messages = await listMessages(after);
      return { status: 200, body: { messages } };
    } catch (err) {
      const code = err && typeof err.code === "string" ? err.code : "error";
      console.error(`inbox read failed ${code}`);
      return { status: 500, body: { ok: false } };
    }
  }

  if (path !== "/telegram") return { status: 404, body: { ok: false } };
  if (method !== "POST") return { status: 405, body: { ok: false } };
  if (authFailureBlocked("webhook", client)) {
    return { status: 401, body: { ok: false } };
  }
  if (!webhookAuthorized(secretHeader)) {
    recordAuthFailure("webhook", client);
    console.error("webhook rejected");
    return { status: 401, body: { ok: false } };
  }

  await ensureRegistered().catch(() => {
    console.error("webhook registration failed");
  });

  let raw;
  try {
    raw = await readRequestBody();
  } catch (err) {
    if (err && err.code === "LIMIT") return { status: 413, body: { ok: false } };
    console.error("webhook body failed");
    return { status: 400, body: { ok: false } };
  }

  let update;
  try {
    update = JSON.parse(raw.toString("utf8"));
  } catch {
    console.error("webhook ignored non-json");
    return { status: 400, body: { ok: false } };
  }

  const record = toRecord(update);
  if (!record) return { status: 200, body: { ok: true } };

  const accepted = await takeWebhookInsert().catch((err) => {
    const code = err && typeof err.code === "string" ? err.code : "error";
    console.error(`webhook ingest limit failed ${code}`);
    return false;
  });
  if (!accepted) return { status: 429, body: { ok: false } };

  try {
    await insertMessage(record);
  } catch (err) {
    const code = err && typeof err.code === "string" ? err.code : "error";
    console.error(`webhook persist failed ${code}`);
    return { status: 500, body: { ok: false } };
  }
  return { status: 200, body: { ok: true } };
}

export async function handle(req, res) {
  try {
    const url = requestUrl(req.url);
    const result = await dispatch({
      method: req.method,
      path: url.pathname,
      searchParams: url.searchParams,
      secretHeader: req.headers["x-telegram-bot-api-secret-token"],
      inboxKey: req.headers["x-inbox-key"],
      authorization: req.headers.authorization,
      forwardedFor: req.headers["x-forwarded-for"],
      readRequestBody: () => readBody(req),
    });
    sendJson(res, result.status, result.body);
  } catch (err) {
    const code = err && typeof err.code === "string" ? err.code : "error";
    console.error(`webhook handler failed ${code}`);
    if (!res.headersSent) sendJson(res, 500, { ok: false });
  }
}

function jsonResponse(status, body) {
  const payload = JSON.stringify(body);
  if (responseLeaksSecret(payload)) {
    return new Response('{"ok":false}', {
      status: 500,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return new Response(payload, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Host entrypoint. The function runtime invokes this; it does not run `node server.mjs`. */
export async function fetch(request) {
  const url = new URL(request.url);
  const result = await dispatch({
    method: request.method,
    path: url.pathname,
    searchParams: url.searchParams,
    secretHeader: request.headers.get("x-telegram-bot-api-secret-token"),
    inboxKey: request.headers.get("x-inbox-key"),
    authorization: request.headers.get("authorization"),
    forwardedFor: request.headers.get("x-forwarded-for"),
    readRequestBody: async () => {
      const raw = Buffer.from(await request.arrayBuffer());
      if (raw.length > BODY_LIMIT) {
        throw Object.assign(new Error("body too large"), { code: "LIMIT" });
      }
      return raw;
    },
  });
  return jsonResponse(result.status, result.body);
}

const app = { fetch };
export default app;

export function listenPort(override) {
  if (override != null) return override;
  const parsed = Number(process.env.PORT);
  if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) return parsed;
  return 3000;
}

export async function start(options = {}) {
  if (webhookSecret().length === 0) console.error("TELEGRAM_WEBHOOK_SECRET is not set");
  if (botToken().length === 0) console.error("TELEGRAM_BOT_TOKEN is not set");
  await prepareDatabase();
  const server = createServer((req, res) => {
    handle(req, res);
  });
  const port = listenPort(options.port);
  const host = options.host ?? "0.0.0.0";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.error(`listening on ${host}:${port}`);
  return server;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  start().catch((err) => {
    const code = err && typeof err.code === "string" ? err.code : "error";
    console.error(`startup failed ${code}`);
    process.exitCode = 1;
  });
}
