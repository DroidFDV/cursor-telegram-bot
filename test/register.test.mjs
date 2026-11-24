import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { WEBHOOK_URL } from "../src/origin.mjs";
import { ensureRegistered, resetRegistrationForTests } from "../src/register.mjs";
import { handle, start } from "../server.mjs";

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

  after(() => {
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
    resetRegistrationForTests();
  });

  it("allows only the published webhook URL", () => {
    assert.equal(WEBHOOK_URL, WEBHOOK);
  });

  it("posts setWebhook for that URL without putting the secret in it", async () => {
    resetRegistrationForTests();
    logs.length = 0;
    process.env.CURSOR_APP_URL = "https://evil.example";
    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };

    const ok = await ensureRegistered();
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    const endpoint = new URL(calls[0].url);
    assert.equal(endpoint.protocol, "https:");
    assert.equal(endpoint.hostname, "api.telegram.org");
    assert.equal(endpoint.pathname.endsWith("/setWebhook"), true);
    assert.equal(calls[0].options.redirect, "error");
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.url, WEBHOOK);
    assert.equal(body.secret_token, SECRET);
    assert.equal(body.url.includes(SECRET), false);
    assert.equal(body.url.includes(TOKEN), false);
    assert.equal(body.url.includes("evil.example"), false);
    assert.deepEqual(body.allowed_updates, ["message"]);

    const again = await ensureRegistered();
    assert.equal(again, true);
    assert.equal(calls.length, 1);

    const joined = logs.join("\n");
    assert.equal(joined.includes(TOKEN), false);
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes("setWebhook"), false);
    delete process.env.CURSOR_APP_URL;
  });

  it("does not log a failed request that echoes the token", async () => {
    resetRegistrationForTests();
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
    resetRegistrationForTests();
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
    resetRegistrationForTests();
    logs.length = 0;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const res = { headersSent: false, writeHead() {}, end() {} };
    await handle({
      method: "GET",
      url: "/health",
      headers: {
        host: "evil.example",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "inbox.example.com",
      },
    }, res);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    const joined = logs.join("\n");
    assert.equal(joined.includes(TOKEN), false);
    assert.equal(joined.includes(SECRET), false);
    assert.equal(joined.includes("inbox.example.com"), false);
    assert.equal(joined.includes("evil.example"), false);
  });

  it("skips registration on boot when a secret is missing", async () => {
    resetRegistrationForTests();
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    logs.length = 0;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const server = await start({ port: 0, host: "127.0.0.1" });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 0);
      assert.equal(logs.join("\n").includes("webhook registration skipped"), true);
      assert.equal(logs.join("\n").includes(TOKEN), false);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    }
  });

  it("registers the constant webhook on boot when both secrets are set", async () => {
    resetRegistrationForTests();
    process.env.CURSOR_APP_URL = "https://evil.example";
    logs.length = 0;
    let calls = 0;
    globalThis.fetch = async (url, options) => {
      calls += 1;
      const endpoint = new URL(String(url));
      assert.equal(endpoint.hostname, "api.telegram.org");
      assert.equal(JSON.parse(options.body).url, WEBHOOK);
      assert.equal(JSON.parse(options.body).url.includes(SECRET), false);
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    };
    const server = await start({ port: 0, host: "127.0.0.1" });
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      const response = await originalFetch(`http://127.0.0.1:${server.address().port}/health`);
      assert.equal(response.status, 200);
      assert.equal((await response.text()).includes(SECRET), false);
      assert.equal(calls, 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      delete process.env.CURSOR_APP_URL;
    }
  });
});
