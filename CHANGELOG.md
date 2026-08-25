# Changelog

## 1.1.0

- Bundle the optional Telegram Serverless relay with Pitgram.
- Add durable offline and delayed Telegram turns.
- Add `/queue` list, edit, delete, and clear commands.
- Preserve relay attachment `file_id` values and download them when Pi claims a turn.
- Add `/pitgram-relay-setup` and `/pitgram-relay-disable`.
- Add the `pitgram-relay` deployment helper backed by official `@tgcloud/cli` 0.1.2.
- Store Telegram configuration with owner-only file permissions.
- Replace the prototype sentinel-message transport. Telegram webhooks and `getUpdates` cannot consume the same bot concurrently, and outgoing bot messages do not return as incoming updates. Relay mode now uses the webhook only for Telegram ingress and the authenticated Telegram Serverless management API for local queue claims.
