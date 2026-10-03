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

Telegram retains unreceived bot updates for [no longer than 24 hours](https://core.telegram.org/bots/api#getting-updates).
With an existing saved polling offset, Pitgram fetches messages sent while it was
disconnected when it reconnects. Backlog messages are submitted one at a time in
arrival order. Messages received while Pi is busy wait for the run's final
`agent_settled` event, including any automatic retry or compaction, before dispatch.
Use a current Pi runtime that provides this event.

Run the bridge in only one Pi session for a given bot. Another session using the
same bot can fetch its pending updates even if the first session is disconnected;
use `/pitgram-status` and `/pitgram-disconnect` in each session to check.

Direct mode is not a durable processing queue: the polling offset is saved before
agent processing completes, and fetched turns wait in memory. A crash, shutdown,
or reload can lose fetched but unfinished turns. A short offline/reconnect test
does not prove retention at the 24-hour boundary. Use the optional relay for
durable pending storage, subject to its separate interrupted-turn recovery limits.

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

## Read-only active source context (Pitgram 1.2.0+)

Agents can call the `pitgram_context` tool during an active authorized Telegram turn. The tool returns version 1 JSON in both its text content and structured `details`:

```json
{
  "version": 1,
  "available": true,
  "source": {
    "kind": "telegram",
    "delivery": "direct",
    "text": "  remember this  ",
    "chatId": 42,
    "messageId": 101,
    "relayTurnId": null,
    "timestamp": 1700000000,
    "attachments": [],
    "typedCaptureSupported": true
  }
}
```

Outside an active authorized turn, the response is `{"version":1,"available":false,"source":null}`. Tool parameters are an empty object. A normal Pi prompt prefixed with `[telegram]` does not itself provide source context. The extension matches its own pending dispatched prompt to Pi's `before_agent_start` event and exposes only the turn activated at `agent_start`; it clears context at `agent_end` and `session_shutdown`. This relies on Pi preserving the dispatched text in `before_agent_start.prompt`; consumers should treat unavailable context as unavailable, never parse source facts from the prompt.

`text` is the *current* event, separate from any earlier queued messages included in Pi's prompt after an abort. Direct single-message text retains exact Telegram `message.text` (or caption if present), including whitespace; the existing prompt still trims text for agent display. Direct albums have `text: null` because multiple messages cannot be truthfully represented as one typed event. `typedCaptureSupported` is true only for one text-only Telegram message, or a relay text turn without media. Captions, media-only messages and albums are unsupported for typed capture; downloaded attachment facts are temporary paths, with no durability or transcription guarantee.

Relay `text` comes from the delivered `userText` when present (including `/queue edit` changes), falling back to the relay payload's text. The relay webhook trims incoming Telegram text and strips queue flags before it persists `userText`; edits replace that queued text. Original pre-relay whitespace cannot be recovered. `messageId` is the actual Telegram message ID if supplied, otherwise `null`; the relay's stable `relayTurnId` is additional scoped metadata, not a Telegram ID or attempt counter. For downstream idempotency, prefer the Telegram chat ID and message ID across delivery modes. With no message ID, a consumer may use a relay-scoped key composed of chat ID and relay turn ID, but cannot deduplicate it against a direct Telegram replay without the original ID. `timestamp` is Telegram's original Unix seconds if supplied in the existing payload, otherwise `null`; this relay currently omits the source timestamp. Later edits are not reconciled.

Install the current release with `pi install npm:pitgram`. Pitgram 1.1.0 does not contain `pitgram_context`; upgrade to 1.2.0 or later and restart Pi to load the tool. Source development still uses `npm install`, `npm run build`, then `pi -e /path/to/pitgram`.

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
