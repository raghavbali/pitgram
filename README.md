# Pitgram

Pitgram is a custom Pi extension that bridges Telegram chats with your Pi agent. It is a derivative of the excellent original `pi-telegram` extension, extending it with powerful remote session management commands.

## Acknowledgements
This extension is based on and extends the original `pi-telegram` bridge (originally developed by Mario Zechner as `badlogic/pi-telegram`). We gratefully acknowledge the original project's architecture and design for connecting Pi agents to the Telegram bot API.

## Features
- **Remote Polling Loop**: Continues running across session swaps.
- **Typing Indicators & Draft Previews**: Sends typing status updates and draft edits to Telegram.
- **Attachment Support**: Forwards media attachments from Telegram and allows queuing system files to send back via `telegram_attach`.
- **Session Management**: List, switch, create, and fork agent sessions remotely.

## Commands

### Telegram Bot Commands
Send these directly to your paired Telegram bot:
- `/sessions` - List all sessions in the agent's current working directory.
- `/switch <index|path|id>` - Switch active session (resolved by index from `/sessions` or by direct path/ID).
- `/new [name]` - Create and switch to a new session (optionally named).
- `/fork` (or `/clone`) - Fork the active session at the current leaf index.
- `/model [index|name]` - Show available models or switch the active LLM model.
- `/thinking [level]` - Show available thinking levels or set the reasoning level (e.g., off, minimal, low, medium, high, xhigh).
- `/settings` - Show current session settings (active model, thinking level, enabled tools, directory, mode).
- `/status` - Retrieve context window size, tokens, and billing cost stats.
- `/compact` - Manually trigger context compaction.
- `stop` (or `/stop`) - Abort the active agent reasoning turn.

### Local TUI Commands
Type these in the local Pi console:
- `pitgram-setup` - Configure your bot token.
- `pitgram-status` - Print connection details, paired user, and queue sizes.
- `pitgram-connect` - Force start polling in the active session.
- `pitgram-disconnect` - Disconnect the polling loop.

## Installation & Local Testing
To load Pitgram locally with the Pi agent, run:
```bash
pi -e ./custom_plugins/pitgram
```
Alternatively, configure it inside your global configuration file.
