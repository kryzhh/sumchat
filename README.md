# sumchat — Discord chat summarizer

Summarizes a channel's messages between two times using AI via OpenRouter.
All times are read as **IST**.

## How people use it

**Slash command**

```
/summarize from:<when> [to:<when>]
```

- `from` is required; `to` defaults to **now**.
- While you type, the suggestion box shows what the bot understood, e.g.
  `→ Sun, 18 Oct, 2026, 6:00 pm IST`, so you can check before sending.
- Accepted formats: `2h ago`, `30 minutes ago`, `today 9am`, `yesterday 6pm`,
  `18/10 9:30am` (day first), `6pm` (means the most recent 6 pm), `now`,
  a message link, a message ID, or a Discord timestamp like `<t:1760860800:F>`.

**Right-click a message → Apps →**

- **Summarize from here**: from that message until now.
- **Set summary start**, then right-click another message → **Summarize up to here**:
  exactly the messages between the two, inclusive.

The summary is posted in the channel for everyone. Errors are shown only to
the person who asked.

## 1. Create the Discord bot

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. **Bot** page:
   - **Reset Token** and copy it → this is `DISCORD_TOKEN`.
   - Turn on **Message Content Intent** (without it the bot can't read messages).
3. **OAuth2** page: copy the **Client ID**, then open this link with your ID
   to add the bot to your server:

   ```
   https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=66560
   ```

   (66560 = View Channels + Read Message History.)

## 2. Get an OpenRouter key

Create one at <https://openrouter.ai/keys> → `OPENROUTER_API_KEY`.

The default model `openrouter/free` costs nothing but free models are limited
to 20 requests/minute and 50/day (1,000/day after a one-time 10-credit top-up).
A summary uses 1 request, or up to 9 for very long chats. To use a paid or
specific model, set `OPENROUTER_MODEL`; comma-separate several for fallback.

## 3. Run it locally

Needs Node 20+.

```bash
npm install
cp .env.example .env     # then fill in DISCORD_TOKEN and OPENROUTER_API_KEY
npm test                 # checks the date parsing
npm start
```

Tip: set `GUILD_ID` (right-click your server → Copy Server ID, with Developer
Mode on) so commands appear instantly in that server.

## 4. Host it on Render

1. Push this folder to a GitHub repo (`.env` is git-ignored — never commit it).
2. Render → **New → Web Service** → pick the repo.
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free**
   - Environment: add `DISCORD_TOKEN`, `OPENROUTER_API_KEY` (and optionally
     `OPENROUTER_MODEL`, `GUILD_ID`).
   (Or use **New → Blueprint**, which reads `render.yaml`.)
3. **Keep it awake.** Free web services sleep after 15 minutes without web
   traffic, and Discord activity doesn't count. Create a free monitor at
   <https://uptimerobot.com> (or cron-job.org) that loads your Render URL
   (`https://<name>.onrender.com`) every 5–10 minutes. The page shows
   `ok: <bot name>` when the bot is online.

   Render's 750 free hours/month cover one always-on service. If you'd rather
   not rely on a pinger, use a **Background Worker** on the Starter plan
   ($7/month) instead; the code works unchanged.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `DISCORD_TOKEN` | — | Bot token (required) |
| `OPENROUTER_API_KEY` | — | OpenRouter key (required) |
| `OPENROUTER_MODEL` | `openrouter/free` | Model ID(s), comma-separated for fallback |
| `GUILD_ID` | empty | Register commands in one server only (instant) |
| `MAX_MESSAGES` | `1500` | Most messages read per summary (keeps the latest) |
| `CHUNK_CHARS` | `40000` | Transcript size per AI call before splitting |
| `COOLDOWN_SECONDS` | `20` | Per-user wait between summaries |

## Notes

- Messages from this bot and system messages (joins, pins) are ignored.
  Attachments, stickers and embeds appear as `[attachment: file.pdf]` etc.
- Very long ranges are split into parts, each summarized, then merged.
  Beyond 8 parts the oldest are skipped and the summary says so.
- "Set summary start" is remembered for 30 minutes in memory; a restart
  forgets it.
- If the bot only lives in one server, just keep `GUILD_ID` set permanently:
  command updates show up instantly. Switching between server-only and global
  registration later can leave duplicate commands visible in that server.
