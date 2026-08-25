// Always-on Telegram front desk for Pitgram.
// Telegram owns this bot's webhook; every non-management message is persisted
// until the local Pitgram extension claims and completes it.

import { api, db } from "sdk";
import { pairings } from "schema";
import { eq } from "sdk/db";
import { enqueue, listPending, countPending, editText, deleteTurn, clearPending, addAttachment } from "lib/queue";
import { isPiOnline } from "lib/pi_relay";
import { parseQueueFlag, stripQueueFlag } from "lib/queue_flags";

const MAX_PREVIEW = 80;

export default async function (message) {
  if (!message.chat || message.chat.type !== "private" || !message.from || message.from.is_bot) return;
  const chatId = message.chat.id;
  const text = (message.text ?? message.caption ?? "").trim();

  if (text === "/start" || text === "/help" || text.startsWith("/help ")) {
    const paired = await ensurePaired(message);
    if (!paired) return;
    await api.sendMessage({ chat_id: chatId, text: HELP_TEXT });
    return;
  }
  if (!(await ensurePaired(message))) return;

  if (text === "/queue" || text === "/queue list" || text.startsWith("/queue list ")) {
    await cmdQueueList(chatId);
    return;
  }
  if (text.startsWith("/queue edit ")) {
    await cmdQueueEdit(chatId, text.slice("/queue edit ".length));
    return;
  }
  if (text.startsWith("/queue delete ")) {
    await cmdQueueDelete(chatId, text.slice("/queue delete ".length));
    return;
  }
  if (text === "/queue clear") {
    await cmdQueueClear(chatId);
    return;
  }

  const forced = parseQueueFlag(text);
  const cleanText = forced ? stripQueueFlag(text) : text;
  const delayMs = forced?.delayMs ?? 0;
  const payload = minimalMessage(message, cleanText);
  const row = await enqueue({
    chatId,
    userText: cleanText || null,
    payload,
    deliverAfter: delayMs ? new Date(Date.now() + delayMs) : null,
  });
  await persistAttachments(row.id, message);

  const online = await isPiOnline(chatId);
  if (forced || !online) {
    const pending = await countPending(chatId);
    await api.sendMessage({ chat_id: chatId, text: queuedSummary(row.id, pending, delayMs) });
  }
}

async function ensurePaired(message) {
  const chatId = message.chat.id;
  const existing = await db.select().from(pairings).where(eq(pairings.chatId, chatId)).get();
  if (existing) {
    if (existing.tgUserId === message.from.id) return true;
    await api.sendMessage({ chat_id: chatId, text: "This relay is paired with another Telegram account." });
    return false;
  }
  await db.insert(pairings).values({ chatId, tgUserId: message.from.id, piOnline: false }).run();
  await api.sendMessage({ chat_id: chatId, text: "Pitgram relay paired with this chat." });
  return true;
}

async function cmdQueueList(chatId) {
  const pending = await listPending(chatId);
  if (pending.length === 0) {
    await api.sendMessage({ chat_id: chatId, text: "No queued messages." });
    return;
  }
  const lines = pending.map((turn) => {
    const preview = (turn.userText ?? "(media only)").replace(/\s+/g, " ").slice(0, MAX_PREVIEW);
    const delayed = turn.deliverAfter ? ` · deliver after ${fmtTime(turn.deliverAfter)}` : "";
    return `id=${turn.id}${delayed}\n  ${preview}${(turn.userText?.length ?? 0) > MAX_PREVIEW ? "…" : ""}`;
  });
  await api.sendMessage({ chat_id: chatId, text: `Queued messages (${pending.length}):\n\n${lines.join("\n\n")}` });
}

async function cmdQueueEdit(chatId, args) {
  const match = args.match(/^(\d+)\s+([\s\S]+)$/);
  if (!match) {
    await api.sendMessage({ chat_id: chatId, text: "Usage: /queue edit <id> <new text>" });
    return;
  }
  const ok = await editText(Number(match[1]), chatId, match[2]);
  await api.sendMessage({ chat_id: chatId, text: ok ? `Edited queued message ${match[1]}.` : "Message not found or already running." });
}

async function cmdQueueDelete(chatId, args) {
  const id = Number(args.trim());
  if (!Number.isInteger(id)) {
    await api.sendMessage({ chat_id: chatId, text: "Usage: /queue delete <id>" });
    return;
  }
  const ok = await deleteTurn(id, chatId);
  await api.sendMessage({ chat_id: chatId, text: ok ? `Deleted queued message ${id}.` : "Message not found or already running." });
}

async function cmdQueueClear(chatId) {
  const count = await clearPending(chatId);
  await api.sendMessage({ chat_id: chatId, text: count ? `Cleared ${count} queued message(s).` : "No queued messages to clear." });
}

function minimalMessage(message, text) {
  return {
    chatId: message.chat.id,
    messageId: message.message_id,
    text,
    hasMedia: Boolean(message.photo || message.document || message.video || message.audio || message.voice || message.animation || message.sticker),
  };
}

async function persistAttachments(turnId, message) {
  for (const attachment of collectFileIds(message)) await addAttachment(turnId, attachment);
}

function collectFileIds(message) {
  const files = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
    if (photo) files.push({ fileId: photo.file_id, fileName: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg", isImage: true });
  }
  if (message.document) files.push({ fileId: message.document.file_id, fileName: message.document.file_name, mimeType: message.document.mime_type, isImage: String(message.document.mime_type ?? "").startsWith("image/") });
  if (message.video) files.push({ fileId: message.video.file_id, fileName: message.video.file_name, mimeType: message.video.mime_type, isImage: false });
  if (message.audio) files.push({ fileId: message.audio.file_id, fileName: message.audio.file_name, mimeType: message.audio.mime_type, isImage: false });
  if (message.voice) files.push({ fileId: message.voice.file_id, fileName: `voice-${message.message_id}.ogg`, mimeType: message.voice.mime_type, isImage: false });
  if (message.animation) files.push({ fileId: message.animation.file_id, fileName: message.animation.file_name, mimeType: message.animation.mime_type, isImage: false });
  if (message.sticker) files.push({ fileId: message.sticker.file_id, fileName: `sticker-${message.message_id}.webp`, mimeType: "image/webp", isImage: true });
  return files;
}

function queuedSummary(id, pending, delayMs) {
  const delay = delayMs ? ` Delayed ${humanDelay(delayMs)}.` : "";
  return `Queued as #${id}.${delay} ${pending} message(s) pending. Use /queue to manage the queue.`;
}

function humanDelay(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return [hours ? `${hours}h` : "", minutes ? `${minutes}m` : ""].filter(Boolean).join(" ") || "0m";
}

function fmtTime(value) {
  return new Date(value).toISOString().replace("T", " ").slice(0, 16) + "Z";
}

const HELP_TEXT = `Pitgram relay\n\nMessages are delivered immediately while pi is connected and stored durably while it is offline.\n\nQueue commands:\n- -q or --queue: force a message into the queue\n- -q 2h30m: delay delivery\n- /queue: list pending messages\n- /queue edit <id> <text>\n- /queue delete <id>\n- /queue clear\n\nAll regular Pitgram commands are forwarded to pi.`;
