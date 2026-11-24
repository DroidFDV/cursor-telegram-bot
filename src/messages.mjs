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
