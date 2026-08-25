# Pitgram

Pitgram connects a private Telegram bot chat to a [Pi](https://github.com/earendil-works/pi) agent. It supports remote session and model controls, media in both directions, streaming draft previews, and an optional Telegram Serverless relay for durable offline delivery.

Pitgram is derived from Mario Zechner's original [`badlogic/pi-telegram`](https://github.com/badlogic/pi-telegram) extension.

## Features

- **Telegram bridge:** Send prompts to Pi and receive streamed replies.
- **Attachments:** Receive Telegram media and return local files with `pitgram_attach`.
- **Remote sessions:** List, switch, create, and fork Pi sessions.
- **Model controls:** Inspect or change the model and thinking level.
- **Optional offline queue:** Telegram Serverless stores messages while Pi is stopped, then delivers them in FIFO order when Pi reconnects.
- **Queue management:** Force or delay queued work and list, edit, delete, or clear pending messages from Telegram.

## Install

```bash
pi install npm:pitgram
```

For source development:

```bash
pi -e /path/to/pitgram
```

## Direct-mode setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its API token.
2. Start Pi interactively.
3. Run `/pitgram-setup` and enter the bot token.
4. Send `/start` to the bot in Telegram. The first private account is paired.

Pitgram now uses Telegram `getUpdates` directly. This mode requires Pi to be running and remains the default.

## Optional Telegram Serverless relay

The relay is bundled in Pitgram 1.1.0 and later. It owns the bot webhook and persists every incoming turn in Telegram Serverless SQLite. The local extension polls that durable queue through Telegram Serverless's authenticated management API. This design deliberately does **not** combine a webhook with `getUpdates`, and it does not rely on bot-sent messages reappearing as incoming updates.

### 1. Pair Pitgram first

Complete direct-mode setup above before enabling the webhook relay.

### 2. Deploy the bundled relay

Get a CLI access token from **BotFather → Serverless → CLI Access**, then run:

```bash
npx --yes --package pitgram pitgram-relay login
npx --yes --package pitgram pitgram-relay push
npx --yes --package pitgram pitgram-relay migrate
npx --yes --package pitgram pitgram-relay webhook sync
```

`push` deploys code but does not alter the database; `migrate` is required for the queue tables. The wrapper copies the bundled project to `~/.pi/agent/pitgram-relay`, preserving CLI credentials and deployment state there, then runs the official `@tgcloud/cli`.

### 3. Link the local extension

In Pi, run:

```text
/pitgram-relay-setup
```

Enter the Telegram Serverless CLI access token when prompted. Pitgram validates the deployed relay before saving it and switches to relay mode on reconnect or restart.

The token is stored locally in `~/.pi/agent/telegram.json`. Treat that file as a secret and never commit or share it.

To return to direct polling:

```text
/pitgram-relay-disable
/pitgram-connect
```

### Relay behavior

- When Pi is connected, new turns are normally claimed within about two seconds.
- When Pi is offline, turns remain durable in Telegram Serverless.
- Attachments are stored as Telegram `file_id` references and downloaded by local Pitgram during delivery.
- A claimed turn is marked done only after Pi's reply and requested attachments are sent.
- If Pi disconnects with a running turn, the relay returns that turn to pending.
- Forced delayed turns are not claimed before their delivery time.

Telegram queue controls:

```text
-q message
-q 2h30m message
--queue message
/queue
/queue edit <id> <new text>
/queue delete <id>
/queue clear
```

## Telegram commands

- `/sessions` — list sessions in the current working directory.
- `/switch <index|path|id>` — switch the active session.
- `/new [name]` — create and switch to a new session.
- `/fork` or `/clone` — fork the active session.
- `/model [index|name]` — inspect or switch the model.
- `/thinking [level]` — inspect or set reasoning effort.
- `/settings` — show current model, tools, directory, and mode.
- `/status` — show context, token, and cost metrics.
- `/compact` — compact session history.
- `stop` or `/stop` — abort the current turn.

## Local Pi commands

- `/pitgram-setup` — configure and pair the Telegram bot.
- `/pitgram-status` — show connection mode and queue state.
- `/pitgram-connect` — connect using direct or relay mode.
- `/pitgram-disconnect` — disconnect cleanly.
- `/pitgram-relay-setup` — validate and enable the deployed relay.
- `/pitgram-relay-disable` — disable the relay.

## Screenshots

![Telegram Chat Overview](https://raw.githubusercontent.com/raghavbali/pitgram/main/assets/screenshot1.png)

![Reasoning & Thinking Updates](https://raw.githubusercontent.com/raghavbali/pitgram/main/assets/screenshot2.png)

![Remote Session Management](https://raw.githubusercontent.com/raghavbali/pitgram/main/assets/screenshot3.png)

## Development and release checks

```bash
npm install
npm test
npm pack --dry-run
```

The npm tarball must include `dist/`, `src/`, `relay/`, `bin/`, and this README.
