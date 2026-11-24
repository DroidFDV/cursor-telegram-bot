const TEXT_LIMIT = 4096;

function asSafeInt(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value;
}

function asNonNegativeInt(value) {
  const parsed = asSafeInt(value);
  if (parsed == null || parsed < 0) return null;
  return parsed;
}

function clip(value) {
  if (value == null) return null;
  return value.length > TEXT_LIMIT ? value.slice(0, TEXT_LIMIT) : value;
}

export function mediaKind(message) {
  if (Array.isArray(message.photo) && message.photo.length > 0) return "photo";
  if (message.document && typeof message.document === "object") return "document";
  if (message.voice && typeof message.voice === "object") return "voice";
  return null;
}

/**
 * Group/supergroup message updates only.
 * Keeps chat id, chat title, from username, message id, and date,
 * plus text, caption, and media kind. Other update types return null.
 */
export function toRecord(update) {
  if (!update || typeof update !== "object") return null;
  const message = update.message;
  if (!message || typeof message !== "object") return null;

  const chat = message.chat && typeof message.chat === "object" ? message.chat : null;
  if (!chat) return null;
  if (chat.type !== "group" && chat.type !== "supergroup") return null;

  const text = typeof message.text === "string" ? message.text : null;
  const caption = typeof message.caption === "string" ? message.caption : null;
  const kind = mediaKind(message);
  if (text == null && caption == null && kind == null) return null;

  const updateId = asNonNegativeInt(update.update_id);
  const messageId = asNonNegativeInt(message.message_id);
  const date = asNonNegativeInt(message.date);
  const chatId = asSafeInt(chat.id);
  if (updateId == null || messageId == null || date == null || chatId == null) return null;

  const from = message.from && typeof message.from === "object" ? message.from : {};
  return {
    update_id: updateId,
    message_id: messageId,
    date,
    chat_id: chatId,
    chat_title: clip(typeof chat.title === "string" ? chat.title : null),
    from_username: clip(typeof from.username === "string" ? from.username : null),
    text: clip(text),
    caption: clip(caption),
    media_kind: kind,
  };
}
