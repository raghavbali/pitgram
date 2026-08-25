import { db } from "sdk";
import { pairings } from "schema";
import { eq, sql } from "sdk/db";

export async function setPiOnline(chatId) {
  await db.update(pairings)
    .set({ piOnline: true, lastSeen: sql`(unixepoch())` })
    .where(eq(pairings.chatId, chatId)).run();
}

export async function setPiOffline(chatId) {
  await db.update(pairings)
    .set({ piOnline: false, lastSeen: sql`(unixepoch())` })
    .where(eq(pairings.chatId, chatId)).run();
}

export async function isPiOnline(chatId) {
  const pairing = await db.select().from(pairings).where(eq(pairings.chatId, chatId)).get();
  return Boolean(pairing?.piOnline);
}
