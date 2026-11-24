import assert from "node:assert/strict";
import { once } from "node:events";
import { after, before, describe, it } from "node:test";
import { Readable } from "node:stream";
import { sql } from "../src/db.mjs";
import app, { readBody, start } from "../server.mjs";

const WEBHOOK_SECRET = "test-webhook-secret-value";
const BOT_TOKEN = "test-bot-token-value";
const INBOX_KEY = "test-inbox-read-key-value";

process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
process.env.INBOX_READ_KEY = INBOX_KEY;
delete process.env.DATABASE_URL;
delete process.env.DATABASE_URL_UNPOOLED;
delete process.env.CURSOR_APP_URL;

let server;
let base;
const logs = [];
const originalError = console.error;
console.error = (...args) => {
  logs.push(args.map(String).join(" "));
};

function groupMessage({ update_id = 100, message = {} } = {}) {
  return {
    update_id,
    message: {
      message_id: 7,
      date: 1_700_000_000,
      text: "hello",
      from: { id: 999001, username: "ada" },
      chat: { id: -1001234567890, title: "Project Brozzers", type: "supergroup" },
      ...message,
    },
  };
}

async function post(body, options = {}) {
  const payload = options.raw ?? JSON.stringify(body);
  const headers = { "content-type": "application/json" };
  const secret = Object.hasOwn(options, "secret") ? options.secret : WEBHOOK_SECRET;
  if (typeof secret === "string") headers["x-telegram-bot-api-secret-token"] = secret;
  const response = await fetch(`${base}/telegram`, {
    method: "POST",
    headers,
    body: payload,
  });
  const text = await response.text();
  return { status: response.status, text };
}

describe("telegram webhook", { timeout: 60_000, concurrency: 1 }, () => {
  before(async () => {
    server = await start({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    console.error = originalError;
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it("GET /health through the function entrypoint returns ok", async () => {
    const response = await app.fetch(new Request("https://group-inbox.apps.grok.bot/health"));
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(text).ok, true);
    assert.equal(JSON.parse(text).webhook, "pending");
    assert.equal(JSON.parse(text).messageCount, 0);
    assert.equal(JSON.parse(text).lastReceivedAt, null);
    assert.equal(text.includes(WEBHOOK_SECRET), false);
    assert.equal(text.includes(BOT_TOKEN), false);
  });

  it("GET /health returns ok and no secrets", async () => {
    const response = await fetch(`${base}/health`);
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(text).ok, true);
    assert.equal(JSON.parse(text).webhook, "pending");
    assert.equal(JSON.parse(text).messageCount, 0);
    assert.equal(JSON.parse(text).lastReceivedAt, null);
    assert.equal(text.includes(WEBHOOK_SECRET), false);
    assert.equal(text.includes(BOT_TOKEN), false);
    assert.equal(JSON.stringify(logs).includes(WEBHOOK_SECRET), false);
    assert.equal(JSON.stringify(logs).includes(BOT_TOKEN), false);
  });

  it("rejects a missing or wrong secret before saving", async () => {
    const missing = await post(groupMessage({ update_id: 1 }), { secret: undefined });
    assert.equal(missing.status, 401);
    const wrong = await post(groupMessage({ update_id: 2 }), { secret: "wrong-webhook-secret-value" });
    assert.equal(wrong.status, 401);
    const rows = await sql("select update_id from messages where update_id in (1, 2)");
    assert.deepEqual(rows, []);
  });

  it("rejects every webhook when the env secret is unset", async () => {
    const previous = process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    try {
      const response = await post(groupMessage({ update_id: 3 }), { secret: previous });
      assert.equal(response.status, 401);
    } finally {
      process.env.TELEGRAM_WEBHOOK_SECRET = previous;
    }
    const rows = await sql("select update_id from messages where update_id = 3");
    assert.deepEqual(rows, []);
  });

  it("stores text, caption, and media from the group", async () => {
    const text = await post(groupMessage({ update_id: 10, message: { message_id: 10, text: "привет" } }));
    assert.equal(text.status, 200);

    const photo = await post({
      update_id: 11,
      message: {
        message_id: 11,
        date: 1_700_000_001,
        caption: "look",
        photo: [{ file_id: "file-secret-id", width: 1, height: 1 }],
        from: { id: 999001, username: "ada" },
        chat: { id: -1001234567890, title: "Project Brozzers", type: "supergroup" },
      },
    });
    assert.equal(photo.status, 200);

    const document = await post({
      update_id: 12,
      message: {
        message_id: 12,
        date: 1_700_000_002,
        document: { file_id: "doc-secret-id", file_name: "a.pdf" },
        from: { id: 999001, username: "ada" },
        chat: { id: -42, title: "Project Brozzers", type: "group" },
      },
    });
    assert.equal(document.status, 200);

    const voice = await post({
      update_id: 13,
      message: {
        message_id: 13,
        date: 1_700_000_003,
        voice: { file_id: "voice-secret-id", duration: 2 },
        from: { username: "ada" },
        chat: { id: -1001234567890, title: "Project Brozzers", type: "supergroup" },
      },
    });
    assert.equal(voice.status, 200);

    const rows = await sql(
      `select update_id, message_id, "date", chat_id, chat_title, from_username, "text", caption, media_kind
       from messages where update_id between 10 and 13 order by update_id`,
    );
    assert.equal(rows.length, 4);
    assert.equal(rows[0].text, "привет");
    assert.equal(rows[0].media_kind, null);
    assert.equal(Number(rows[0].chat_id), -1001234567890);
    assert.equal(rows[0].chat_title, "Project Brozzers");
    assert.equal(rows[0].from_username, "ada");
    assert.equal(Number(rows[0].message_id), 10);
    assert.equal(Number(rows[0].date), 1_700_000_000);
    assert.equal(rows[1].caption, "look");
    assert.equal(rows[1].media_kind, "photo");
    assert.equal(rows[2].media_kind, "document");
    assert.equal(Number(rows[2].chat_id), -42);
    assert.equal(rows[3].media_kind, "voice");

    const health = await fetch(`${base}/health`);
    const healthText = await health.text();
    const healthBody = JSON.parse(healthText);
    assert.equal(healthBody.messageCount >= 4, true);
    assert.match(healthBody.lastReceivedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(healthText.includes("привет"), false);
    assert.equal(healthText.includes("ada"), false);
    assert.equal(healthText.includes("Project Brozzers"), false);
    assert.equal(healthText.includes("-1001234567890"), false);

    const denied = await fetch(`${base}/inbox`);
    assert.equal(denied.status, 404);
    const wrong = await fetch(`${base}/inbox`, { headers: { "x-inbox-key": "wrong-inbox-read-key" } });
    assert.equal(wrong.status, 404);
    const inbox = await fetch(`${base}/inbox?after=10`, { headers: { "x-inbox-key": INBOX_KEY } });
    const inboxText = await inbox.text();
    const inboxBody = JSON.parse(inboxText);
    assert.equal(inbox.status, 200);
    assert.equal(inboxBody.messages.length >= 1, true);
    assert.equal(inboxBody.messages.some((item) => item.text === "look"), true);
    assert.equal(inboxBody.messages.every((item) => item.chatId === undefined), true);
    assert.equal(inboxText.includes("-1001234567890"), false);
    assert.equal(inboxText.includes(INBOX_KEY), false);
    assert.equal(inboxText.includes(WEBHOOK_SECRET), false);
    assert.equal(inboxText.includes(BOT_TOKEN), false);

    const dumped = JSON.stringify(rows);
    assert.equal(dumped.includes("file-secret-id"), false);
    assert.equal(dumped.includes("999001"), false);
    assert.equal(dumped.includes(BOT_TOKEN), false);
    assert.equal(dumped.includes(WEBHOOK_SECRET), false);
  });

  it("keeps the first row when Telegram retries an update", async () => {
    await post(groupMessage({ update_id: 20, message: { message_id: 20, text: "first" } }));
    const retry = await post(groupMessage({ update_id: 20, message: { message_id: 20, text: "second" } }));
    assert.equal(retry.status, 200);
    const rows = await sql(`select "text" from messages where update_id = 20`);
    assert.deepEqual(rows.map((row) => row.text), ["first"]);
  });

  it("ignores private chats, other update types, and messages without accepted content", async () => {
    const privateChat = await post({
      update_id: 30,
      message: {
        message_id: 30,
        date: 1_700_000_030,
        text: "dm",
        chat: { id: 50, type: "private" },
      },
    });
    const edited = await post({
      update_id: 31,
      edited_message: {
        message_id: 31,
        date: 1_700_000_031,
        text: "edited",
        chat: { id: -1, title: "Project Brozzers", type: "supergroup" },
      },
    });
    const callback = await post({ update_id: 32, callback_query: { id: "1", data: "x" } });
    const sticker = await post({
      update_id: 33,
      message: {
        message_id: 33,
        date: 1_700_000_033,
        sticker: { file_id: "sticker" },
        chat: { id: -1, title: "Project Brozzers", type: "supergroup" },
      },
    });
    assert.deepEqual([privateChat.status, edited.status, callback.status, sticker.status], [200, 200, 200, 200]);
    const rows = await sql("select update_id from messages where update_id between 30 and 33");
    assert.deepEqual(rows, []);
  });

  it("stores text that looks like SQL as data", async () => {
    const hostile = "'); drop table messages; --";
    const response = await post(groupMessage({
      update_id: 40,
      message: { message_id: 40, text: hostile },
    }));
    assert.equal(response.status, 200);
    const rows = await sql(`select "text" from messages where update_id = 40`);
    assert.equal(rows[0].text, hostile);
    const still = await sql("select count(*)::int as n from messages");
    assert.equal(Number(still[0].n) > 0, true);
  });

  it("rejects an oversized body", async () => {
    const req = Readable.from([Buffer.alloc(64, 1)]);
    req.destroy = () => {};
    await assert.rejects(readBody(req, 32), (err) => err && err.code === "LIMIT");
  });

  it("does not log secrets", () => {
    const joined = logs.join("\n");
    assert.equal(joined.includes(WEBHOOK_SECRET), false);
    assert.equal(joined.includes(BOT_TOKEN), false);
    assert.equal(joined.includes("привет"), false);
  });
});
