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
