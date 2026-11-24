import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { prepareDatabase } from "./src/db.mjs";
import { insertMessage } from "./src/messages.mjs";
import { toRecord } from "./src/record.mjs";
import { ensureRegistered } from "./src/register.mjs";
import { botToken, responseLeaksSecret, webhookAuthorized, webhookSecret } from "./src/secret.mjs";

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

function pathname(req) {
  try {
    return new URL(req.url || "/", "http://127.0.0.1").pathname;
  } catch {
    return "/";
  }
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

export async function handle(req, res) {
  const path = pathname(req);
  if (req.method === "GET" && path === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (path !== "/telegram") {
    sendJson(res, 404, { ok: false });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { ok: false });
    return;
  }
  if (!webhookAuthorized(req.headers["x-telegram-bot-api-secret-token"])) {
    console.error("webhook rejected");
    sendJson(res, 401, { ok: false });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err && err.code === "LIMIT") {
      sendJson(res, 413, { ok: false });
      return;
    }
    console.error("webhook body failed");
    sendJson(res, 400, { ok: false });
    return;
  }

  let update;
  try {
    update = JSON.parse(raw.toString("utf8"));
  } catch {
    console.error("webhook ignored non-json");
    sendJson(res, 400, { ok: false });
    return;
  }

  const record = toRecord(update);
  if (!record) {
    sendJson(res, 200, { ok: true });
    return;
  }

  try {
    await insertMessage(record);
  } catch (err) {
    const code = err && typeof err.code === "string" ? err.code : "error";
    console.error(`webhook persist failed ${code}`);
    sendJson(res, 500, { ok: false });
    return;
  }

  sendJson(res, 200, { ok: true });
}

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
    handle(req, res).catch((err) => {
      const code = err && typeof err.code === "string" ? err.code : "error";
      console.error(`webhook handler failed ${code}`);
      if (!res.headersSent) sendJson(res, 500, { ok: false });
    });
  });
  const port = listenPort(options.port);
  const host = options.host ?? "0.0.0.0";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.error(`listening on ${host}:${port}`);
  if (botToken().length > 0 && webhookSecret().length > 0) {
    ensureRegistered().catch(() => {
      console.error("webhook registration failed");
    });
  } else {
    console.error("webhook registration skipped");
  }
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
