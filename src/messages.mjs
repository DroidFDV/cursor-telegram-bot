import { sql } from "./db.mjs";

export async function insertMessage(record) {
  await sql(
    `insert into messages (
      update_id, message_id, "date", chat_id, chat_title, from_username, "text", caption, media_kind
    ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    on conflict (update_id) do nothing`,
    [
      record.update_id,
      record.message_id,
      record.date,
      record.chat_id,
      record.chat_title,
      record.from_username,
      record.text,
      record.caption,
      record.media_kind,
    ],
  );
}

export async function messageStats() {
  const rows = await sql(
    `select count(*)::int as message_count, max(received_at) as last_received_at from messages`,
  );
  const row = rows[0] || {};
  const count = Number(row.message_count);
  let lastReceivedAt = null;
  if (row.last_received_at) {
    const parsed = new Date(row.last_received_at);
    if (!Number.isNaN(parsed.getTime())) lastReceivedAt = parsed.toISOString();
  }
  return {
    messageCount: Number.isFinite(count) ? count : 0,
    lastReceivedAt,
  };
}

const WINDOW_MS = 60_000;
const INBOX_LIMIT = 30;
const WEBHOOK_INSERT_LIMIT = 120;

async function takeWindow(ready, limit) {
  await ready();
  const table = ready === ensureInboxRateTable ? "inbox_rate" : "webhook_ingest";
  const rows = await sql(`select window_start, hits from ${table} where id = 1`);
  const now = Date.now();
  let start = now;
  let hits = 0;
  if (rows[0]) {
    const parsed = new Date(rows[0].window_start).getTime();
    hits = Number(rows[0].hits) || 0;
    if (Number.isFinite(parsed) && now - parsed < WINDOW_MS) start = parsed;
    else hits = 0;
  }
  if (hits >= limit) return false;
  hits += 1;
  await sql(
    `insert into ${table} (id, window_start, hits)
     values (1, $1, $2)
     on conflict (id) do update
     set window_start = excluded.window_start, hits = excluded.hits`,
    [new Date(start).toISOString(), hits],
  );
  return true;
}

let inboxRateReady = null;

async function ensureInboxRateTable() {
  inboxRateReady ??= sql(
    `create table if not exists inbox_rate (
      id integer primary key,
      window_start timestamptz not null,
      hits integer not null,
      constraint inbox_rate_id_chk check (id = 1)
    )`,
  ).then(() => {});
  return inboxRateReady;
}

let webhookIngestReady = null;

async function ensureWebhookIngestTable() {
  webhookIngestReady ??= sql(
    `create table if not exists webhook_ingest (
      id integer primary key,
      window_start timestamptz not null,
      hits integer not null,
      constraint webhook_ingest_id_chk check (id = 1)
    )`,
  ).then(() => {});
  return webhookIngestReady;
}

export async function resetInboxRateForTests() {
  inboxRateReady = null;
  try {
    await sql("delete from inbox_rate");
  } catch {
    // The table is created on the first authorized read.
  }
}

export async function resetWebhookIngestForTests() {
  webhookIngestReady = null;
  try {
    await sql("delete from webhook_ingest");
  } catch {
    // The table is created on the first accepted insert.
  }
}

/** About 30 authorized inbox reads per minute. */
export async function takeInboxRead() {
  return takeWindow(ensureInboxRateTable, INBOX_LIMIT);
}

/** About 120 authenticated webhook inserts per minute. */
export async function takeWebhookInsert() {
  return takeWindow(ensureWebhookIngestTable, WEBHOOK_INSERT_LIMIT);
}

function asUtc(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

/** Stored messages newer than `afterId`, without chat id. */
export async function listMessages(afterId) {
  const rows = afterId == null
    ? await sql(
      `select update_id, received_at, chat_title, from_username, "text", caption
       from messages
       order by update_id
       limit 100`,
    )
    : await sql(
      `select update_id, received_at, chat_title, from_username, "text", caption
       from messages
       where update_id > $1
       order by update_id
       limit 100`,
      [afterId],
    );
  return rows.map((row) => ({
    id: Number(row.update_id),
    receivedAt: asUtc(row.received_at),
    chatTitle: row.chat_title ?? null,
    username: row.from_username ?? null,
    text: row.text ?? row.caption ?? null,
  }));
}

/** Keep the newest 200 messages. Fewer rows are left untouched. */
export async function pruneMessages() {
  await sql(
    `delete from messages
     where update_id in (
       select update_id from (
         select update_id from messages
         order by received_at desc, update_id desc
         offset 200
       ) as old_messages
     )`,
  );
}
