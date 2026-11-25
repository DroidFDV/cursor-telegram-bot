import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import app, { handle } from "../server.mjs";
import { WEBHOOK_URL } from "../src/origin.mjs";
import { ensureRegistered, forgetMemoryForTests, resetRegistrationForTests } from "../src/register.mjs";

const TOKEN = "100000:TESTTOKEN";
const SECRET = "webhookSecretValue1";
const WEBHOOK = "https://group-inbox.apps.grok.bot/telegram";

const logs = [];
const originalError = console.error;
const originalFetch = globalThis.fetch;

function saveEnv() {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN,
    secret: process.env.TELEGRAM_WEBHOOK_SECRET,
    origin: process.env.CURSOR_APP_URL,
    database: process.env.DATABASE_URL,
  };
}

const saved = saveEnv();

function useCredentials() {
  process.env.TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_URL_UNPOOLED;
  delete process.env.CURSOR_APP_URL;
}

describe("webhook registration", { timeout: 30_000, concurrency: 1 }, () => {
  before(() => {
    console.error = (...args) => {
      logs.push(args.map(String).join(" "));
    };
    useCredentials();
  });

  after(async () => {
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (saved.token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = saved.token;
    if (saved.secret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
    else process.env.TELEGRAM_WEBHOOK_SECRET = saved.secret;
    if (saved.origin === undefined) delete process.env.CURSOR_APP_URL;
    else process.env.CURSOR_APP_URL = saved.origin;
    if (saved.database === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved.database;
    await resetRegistrationForTests();
  });

  it("allows only the published webhook URL", () => {
    assert.equal(WEBHOOK_URL, WEBHOOK);
  });

  it("posts setWebhook for that URL without putting the secret in it", async () => {
    await resetRegistrationForTests();
    logs.length = 0;
    process.env.CURSOR_APP_URL = "https://evil.example";
    let infoCount = 0;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      const endpoint = new URL(String(url));
      calls.push({ url: String(url), options, pathname: endpoint.pathname });
      if (endpoint.pathname.endsWith("/getWebhookInfo")) {
        infoCount += 1;
        return new Response(JSON.stringify({
          ok: true,
          result: { url: infoCount === 1 ? "" : WEBHOOK, pending_update_count: 0 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };

    const ok = await ensureRegistered();
    assert.equal(ok, true);
    assert.equal(calls.length, 3);
    const setCall = calls.find((call) => call.pathname.endsWith("/setWebhook"));
    assert.ok(setCall);
    const endpoint = new URL(setCall.url);
    assert.equal(endpoint.protocol, "https:");
    assert.equal(endpoint.hostname, "api.telegram.org");
    assert.equal(setCall.options.redirect, "error");
    const body = JSON.parse(setCall.options.body);
    assert.equal(body.url, WEBHOOK);
    assert.equal(body.secret_token, SECRET);
    assert.equal(body.url.includes(SECRET), false);
    assert.equal(body.url.includes(TOKEN), false);
    assert.equal(body.url.includes("evil.example"), false);
    assert.deepEqual(body.allowed_updates, ["message"]);
    assert.equal(calls.filter((call) => call.pathname.endsWith("/setWebhook")).length, 1);

    const again = await ensureRegistered();
    assert.equal(again, true);
    assert.equal(calls.filter((call) => call.pathname.endsWith("/setWebhook")).length, 1);

    const joined = logs.join("\n");
    assert.equal(joined.includes(TOKEN), false);
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes("setWebhook"), false);
    delete process.env.CURSOR_APP_URL;
  });

  it("does not log a failed request that echoes the token", async () => {
    await resetRegistrationForTests();
    logs.length = 0;
    globalThis.fetch = async () => {
      throw new Error(`nope ${TOKEN} ${SECRET} ${WEBHOOK}`);
    };
    const ok = await ensureRegistered();
    assert.equal(ok, false);
    const joined = logs.join("\n");
    assert.equal(joined.includes(TOKEN), false);
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes(WEBHOOK), false);
    assert.equal(joined.includes("webhook registration failed"), true);
  });

  it("does not call Telegram when the token could change the request host", async () => {
    await resetRegistrationForTests();
    logs.length = 0;
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    process.env.TELEGRAM_BOT_TOKEN = "1:bad@evil.example/setWebhook";
    try {
      const ok = await ensureRegistered();
      assert.equal(ok, false);
      assert.equal(called, false);
      assert.equal(logs.join("\n").includes("evil.example"), false);
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = TOKEN;
    }
  });

  it("does not register from Host or forwarded headers", async () => {
    await resetRegistrationForTests();
    logs.length = 0;
    const calls = [];
    globalThis.fetch = async (url, options) => {
      const endpoint = new URL(String(url));
      calls.push({ pathname: endpoint.pathname, body: options.body });
      if (endpoint.pathname.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          result: { url: WEBHOOK },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const res = {
      headersSent: false,
      status: 0,
      body: "",
      writeHead(code) { this.status = code; this.headersSent = true; },
      end(payload) { this.body = payload; },
    };
    await handle({
      method: "GET",
      url: "/health",
      headers: {
        host: "evil.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "inbox.example.com",
      },
    }, res);
    assert.equal(calls.length, 0);
    assert.equal(res.body, '{"ok":true}');
    assert.equal(res.body.includes(WEBHOOK), false);
    assert.equal(res.body.includes(TOKEN), false);
    assert.equal(res.body.includes(SECRET), false);
    assert.equal(res.body.includes("group-inbox.apps.grok.bot"), false);
    const joined = logs.join("\n");
    assert.equal(joined.includes(TOKEN), false);
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes(WEBHOOK), false);
  });

  it("skips registration when a secret is missing", async () => {
    await resetRegistrationForTests();
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    logs.length = 0;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const response = await app.fetch(new Request("https://group-inbox.apps.grok.bot/health"));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(text), { ok: true });
    assert.equal(calls, 0);
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes(WEBHOOK), false);
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  });

  it("registers on the first request and hides the webhook URL", async () => {
    await resetRegistrationForTests();
    process.env.CURSOR_APP_URL = "https://evil.example";
    logs.length = 0;
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls += 1;
      const endpoint = new URL(String(url));
      assert.equal(endpoint.hostname, "api.telegram.org");
      if (endpoint.pathname.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({
          ok: true,
          result: {
            url: WEBHOOK,
            last_error_message: `delivery failed for ${WEBHOOK} token ${TOKEN}`,
          },
        }), { status: 200 });
      }
      const body = JSON.parse(options.body);
      assert.equal(body.url, WEBHOOK);
      assert.equal(body.url.includes(SECRET), false);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const response = await app.fetch(new Request("https://group-inbox.apps.grok.bot/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: "{}",
    }));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(TOKEN), false);
    assert.equal(text.includes(WEBHOOK), false);
    assert.equal(text.includes("group-inbox.apps.grok.bot"), false);
    assert.equal(calls, 1);
    const health = await app.fetch(new Request("https://group-inbox.apps.grok.bot/health"));
    assert.deepEqual(await health.json(), { ok: true });
    const again = await app.fetch(new Request("https://group-inbox.apps.grok.bot/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: "{}",
    }));
    await again.arrayBuffer();
    assert.equal(calls, 1);
    delete process.env.CURSOR_APP_URL;
  });

  it("records a failed registration without returning the webhook URL", async () => {
    await resetRegistrationForTests();
    logs.length = 0;
    globalThis.fetch = async () => new Response(JSON.stringify({
      ok: false,
      description: `Bad Request: ${WEBHOOK} secret ${SECRET}`,
    }), { status: 400 });
    const response = await app.fetch(new Request("https://group-inbox.apps.grok.bot/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: "{}",
    }));
    const text = await response.text();
    assert.equal(text.includes(WEBHOOK), false);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes("group-inbox.apps.grok.bot"), false);
    assert.equal(text.includes("Bad Request"), false);
    const health = await app.fetch(new Request("https://group-inbox.apps.grok.bot/health"));
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(logs.join("\n").includes(SECRET), false);
    assert.equal(logs.join("\n").includes(WEBHOOK), false);
  });

  it("does not call setWebhook again while Telegram's retry is cooling down", async () => {
    await resetRegistrationForTests();
    logs.length = 0;
    let setCalls = 0;
    globalThis.fetch = async (url) => {
      const endpoint = new URL(String(url));
      if (endpoint.pathname.endsWith("/getWebhookInfo")) {
        return new Response(JSON.stringify({ ok: true, result: { url: "" } }), { status: 200 });
      }
      setCalls += 1;
      return new Response(JSON.stringify({
        ok: false,
        description: "Too Many Requests: retry after 1",
        parameters: { retry_after: 1 },
      }), { status: 429 });
    };
    const first = await app.fetch(new Request("https://group-inbox.apps.grok.bot/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: "{}",
    }));
    await first.arrayBuffer();
    assert.equal(setCalls, 1);

    forgetMemoryForTests();
    const second = await app.fetch(new Request("https://group-inbox.apps.grok.bot/telegram", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      body: "{}",
    }));
    await second.arrayBuffer();
    assert.equal(setCalls, 1);
    assert.equal(logs.join("\n").includes(TOKEN), false);
    assert.equal(logs.join("\n").includes(SECRET), false);
  });
});
