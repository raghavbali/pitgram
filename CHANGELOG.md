# Changelog

## 1.2.1

- Serialize Telegram backlog dispatch through Pi prompt preflight and wait for `agent_settled` before starting the next turn.
- Drain messages received during a local Pi turn after that turn settles, while preserving FIFO order and Telegram source context.
- Add `/pitgram-status` dispatch diagnostics and reconnect-batch tests using the installed Pi session runtime.
- Document Telegram's retention window, direct polling's in-memory queue limits, and the full Pi restart required to load an updated compiled extension.

## 1.2.0

- Add the read-only `pitgram_context` tool for trusted version 1 source facts during the active authorized Telegram turn.
- Preserve direct and relay text, Telegram message identity, timestamps, and attachment support metadata for safe downstream capture.
- Match dispatched Telegram prompts to their active turns and clear source context when each turn ends.
- Add lifecycle tests for direct, relay, media, and unavailable context cases.

## 1.1.0

- Bundle the optional Telegram Serverless relay with Pitgram.
- Add durable offline and delayed Telegram turns.
- Add `/queue` list, edit, delete, and clear commands.
- Preserve relay attachment `file_id` values and download them when Pi claims a turn.
- Add `/pitgram-relay-setup` and `/pitgram-relay-disable`.
- Add the `pitgram-relay` deployment helper backed by official `@tgcloud/cli` 0.1.2.
- Store Telegram configuration with owner-only file permissions.
- Replace the prototype sentinel-message transport. Telegram webhooks and `getUpdates` cannot consume the same bot concurrently, and outgoing bot messages do not return as incoming updates. Relay mode now uses the webhook only for Telegram ingress and the authenticated Telegram Serverless management API for local queue claims.
