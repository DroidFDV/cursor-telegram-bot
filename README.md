# cursor-telegram-bot

Node HTTP app that receives Telegram webhook updates and stores group messages. Telegram POSTs to this process. The first request registers `https://group-inbox.apps.grok.bot/telegram` when both secrets are set.

## Routes

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Returns `{"ok":true}` plus webhook status, `inboxKeySet`, `inboxKeyLength` (trimmed length only), `messageCount`, and `lastReceivedAt` in UTC or `null`. No key, hash, secrets, message text, username, chat title, or chat id. |
| `GET` | `/inbox` | Returns stored messages when `x-inbox-key` or `Authorization: Bearer` matches `INBOX_READ_KEY` after trim. Otherwise 404. The key is not read from the query string. Each item has `id`, `receivedAt`, `chatTitle`, `username`, and `text`. Optional `after` returns only newer ids. No bot token, webhook secret, or chat id. |
| `POST` | `/telegram` | Telegram webhook. Requires header `X-Telegram-Bot-Api-Secret-Token` to match `TELEGRAM_WEBHOOK_SECRET`. A missing or wrong secret is rejected. A matching request is acknowledged with HTTP 200. |

Stored updates are `message` updates from a group or supergroup that include text, a caption, or a photo, document, or voice. Each saved row keeps chat id, chat title, from username, message id, and date, plus text, caption, and media kind (`photo`, `document`, or `voice`). Other update types are acknowledged and ignored. File bytes are not downloaded.

## Environment

Set these on the published host. This repository does not contain their values, and the process never logs them.

| Name | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token. The process reads it only from this variable. |
| `TELEGRAM_WEBHOOK_SECRET` | Compared with `X-Telegram-Bot-Api-Secret-Token` on `POST /telegram`. |
| `INBOX_READ_KEY` | Compared with `x-inbox-key` on `GET /inbox`. Not committed. |
| `DATABASE_URL` | Postgres connection set by the app host for the database declared in `cursor-app.json`. Do not commit it. |
| `DATABASE_URL_UNPOOLED` | Optional direct Postgres URL the host may set. Migrations use it when it is present. |
| `PORT` | Listen port. The host sets this. Default is `3000`. The process listens on `0.0.0.0`. |

## Storage

The app host has no durable disk. `cursor-app.json` asks the publish flow for the smallest store it supports: a Postgres database. Migrations in `migrations/` create the `messages` table during `npm run build` and again when the process starts with `DATABASE_URL` set. Rows stay in that database across restarts.

On a machine without `DATABASE_URL` (including local runs), the process uses in-memory PGlite so it can start with no setup. That copy disappears when the process exits. The published app uses Postgres.

Do not commit message contents. There is no export of the inbox in git.

## Group setup

`@ProjectBrozzers_agent` must be a member of the group **Project Brozzers** with privacy mode disabled. In BotFather, run `/setprivacy`, choose the bot, and disable privacy. Then remove the bot from the group and add it again so the new setting applies. With privacy left on, Telegram delivers only commands, mentions, and replies.

History from before the bot joined the group is unavailable. Telegram only delivers updates that arrive after the bot is a member.

## Webhook registration

On the first request, when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are both set, the handler checks Telegram and registers `https://group-inbox.apps.grok.bot/telegram` at most once per minute. A rate-limit wait from Telegram is honored when it is longer. `GET /health` reports `registered`, `pending`, or `failed`, and includes Telegram's error description when there is one. After Telegram shows this webhook, later requests do not call `setWebhook`. The response does not include the bot token, the webhook secret, or the webhook URL. The origin is a constant. The process does not read `Host`, forwarded headers, or `CURSOR_APP_URL`. If either secret is missing, registration is skipped and health stays `pending`. Do not put tokens in this repository.

Telegram's servers must be able to reach `POST /telegram` without a Cursor sign-in, so the published app needs public access. No route returns stored messages.

## Run

```sh
npm install
npm test
npm start
```

`npm start` serves `GET /health` and `POST /telegram`. The published host does not run that process. It imports this module and calls its `fetch` handler. `npm run build` applies database migrations when `DATABASE_URL` is set, and does nothing when it is unset.
