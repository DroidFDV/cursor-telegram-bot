# cursor-telegram-bot

Node HTTP app that receives Telegram webhook updates and stores group messages. Telegram POSTs to this process. This app does not call Telegram.

## Routes

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Returns `{"ok":true}`. No secrets and no message contents. |
| `POST` | `/telegram` | Telegram webhook. Requires header `X-Telegram-Bot-Api-Secret-Token` to match `TELEGRAM_WEBHOOK_SECRET`. A missing or wrong secret is rejected. A matching request is acknowledged with HTTP 200. |

Stored updates are `message` updates from a group or supergroup that include text, a caption, or a photo, document, or voice. Each saved row keeps chat id, chat title, from username, message id, and date, plus text, caption, and media kind (`photo`, `document`, or `voice`). Other update types are acknowledged and ignored. File bytes are not downloaded.

## Environment

Set these on the published host. This repository does not contain their values, and the process never logs them.

| Name | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token. The process reads it only from this variable. |
| `TELEGRAM_WEBHOOK_SECRET` | Compared with `X-Telegram-Bot-Api-Secret-Token` on `POST /telegram`. |
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

Register the webhook with Telegram after the app is published. Point it at the published HTTPS origin plus `/telegram`, and set Telegram's secret token to the same value as `TELEGRAM_WEBHOOK_SECRET`. Do that from the host environment. Do not put tokens in this repository, and do not register the webhook from a checkout that has no host URL yet.

Telegram's servers must be able to reach `POST /telegram` without a Cursor sign-in, so the published app needs public access. No route returns stored messages.

## Run

```sh
npm install
npm test
npm start
```

`npm start` serves `GET /health` and `POST /telegram`. `npm run build` applies database migrations when `DATABASE_URL` is set, and does nothing when it is unset.
