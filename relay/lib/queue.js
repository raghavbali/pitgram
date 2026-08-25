import { db } from "sdk";
import { turns, attachments } from "schema";
import { eq, and, asc, inArray, sql } from "sdk/db";

const PENDING = "pending";
const RUNNING = "running";

export async function listPending(chatId) {
  return db.select().from(turns)
    .where(and(eq(turns.chatId, chatId), eq(turns.status, PENDING)))
    .orderBy(asc(turns.created)).all();
}

export async function countPending(chatId) {
  return db.$count(turns, and(eq(turns.chatId, chatId), eq(turns.status, PENDING)));
}

export async function enqueue({ chatId, userText, payload, deliverAfter }) {
  const rows = await db.insert(turns).values({
    chatId,
    userText: userText ?? null,
    payloadJson: payload,
    status: PENDING,
    deliverAfter: deliverAfter ?? null,
  }).returning().run();
  return rows[0];
}

export async function addAttachment(turnId, { fileId, fileName, mimeType, isImage }) {
  await db.insert(attachments).values({
    turnId,
    fileId,
    fileName: fileName ?? null,
    mimeType: mimeType ?? null,
    isImage: isImage ?? false,
  }).run();
}

export async function attachmentsFor(turnId) {
  return db.select().from(attachments).where(eq(attachments.turnId, turnId)).all();
}

export async function editText(turnId, chatId, newText) {
  const rows = await db.update(turns)
    .set({ userText: newText, updated: sql`(unixepoch())` })
    .where(and(eq(turns.id, turnId), eq(turns.chatId, chatId), eq(turns.status, PENDING)))
    .returning({ id: turns.id }).run();
  return rows.length > 0;
}

export async function deleteTurn(turnId, chatId) {
  const rows = await db.select({ id: turns.id }).from(turns)
    .where(and(eq(turns.id, turnId), eq(turns.chatId, chatId), eq(turns.status, PENDING))).all();
  if (rows.length === 0) return false;
  await db.delete(attachments).where(eq(attachments.turnId, turnId)).run();
  const deleted = await db.delete(turns)
    .where(and(eq(turns.id, turnId), eq(turns.chatId, chatId), eq(turns.status, PENDING)))
    .returning({ id: turns.id }).run();
  return deleted.length > 0;
}

export async function clearPending(chatId) {
  const pending = await listPending(chatId);
  const ids = pending.map((turn) => turn.id);
  if (ids.length === 0) return 0;
  await db.delete(attachments).where(inArray(attachments.turnId, ids)).run();
  const deleted = await db.delete(turns)
    .where(and(eq(turns.chatId, chatId), eq(turns.status, PENDING)))
    .returning({ id: turns.id }).run();
  return deleted.length;
}

export async function claimNextDue(chatId) {
  const now = Date.now();
  const pending = await listPending(chatId);
  const next = pending.find((turn) => turn.deliverAfter === null || new Date(turn.deliverAfter).getTime() <= now);
  if (!next) return null;
  const claimed = await db.update(turns)
    .set({ status: RUNNING, updated: sql`(unixepoch())` })
    .where(and(eq(turns.id, next.id), eq(turns.status, PENDING)))
    .returning().run();
  return claimed[0] ?? null;
}

export async function markDone(turnId, chatId) {
  const rows = await db.update(turns)
    .set({ status: "done", updated: sql`(unixepoch())` })
    .where(and(eq(turns.id, turnId), eq(turns.chatId, chatId), eq(turns.status, RUNNING)))
    .returning({ id: turns.id }).run();
  return rows.length > 0;
}

export async function markError(turnId, chatId, message) {
  const rows = await db.update(turns)
    .set({ status: "error", error: message ?? null, updated: sql`(unixepoch())` })
    .where(and(eq(turns.id, turnId), eq(turns.chatId, chatId), eq(turns.status, RUNNING)))
    .returning({ id: turns.id }).run();
  return rows.length > 0;
}

export async function requeueRunning(chatId) {
  return db.update(turns)
    .set({ status: PENDING, updated: sql`(unixepoch())` })
    .where(and(eq(turns.chatId, chatId), eq(turns.status, RUNNING)))
    .returning({ id: turns.id }).run();
}
