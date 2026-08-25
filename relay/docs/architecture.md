# Pitgram relay architecture

Telegram delivers bot updates either to a webhook or through `getUpdates`; these transports cannot consume the same bot concurrently. Bot API `sendMessage` calls also do not become incoming updates for that bot. Therefore Pitgram relay mode uses this contract:

1. Telegram sends user updates to the Telegram Serverless webhook.
2. `handlers/message.js` persists each turn and its attachment `file_id` values.
3. Local Pitgram invokes `handlers/pi_bridge.js` through Telegram Serverless's authenticated `manage/run` API.
4. The extension claims one due turn at a time, processes it through Pi, sends the reply through the Bot API, then marks the turn done.
5. An offline notification requeues any running turn.

The CLI access token authenticates local-to-cloud queue operations and remains in the local `~/.pi/agent/telegram.json` file. It is never deployed in relay source or sent to the language model.
