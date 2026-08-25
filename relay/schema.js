// Telegram Serverless schema for Pitgram's durable offline queue.
// No foreign keys: Telegram Serverless runs SQLite with FK enforcement disabled.

import { table, integer, text, boolean, index, sql } from "sdk/db";

export const pairings = table(
  "pairings",
  {
    chatId: integer("chat_id").primaryKey(),
    tgUserId: integer("tg_user_id").notNull(),
    piOnline: boolean("pi_online").default(false),
    lastSeen: integer("last_seen", { mode: "timestamp" }).default(sql`(unixepoch())`),
    createdAt: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  },
  (t) => ({ onlineIdx: index("idx_pairings_online").on(t.piOnline) }),
);

export const turns = table(
  "turns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    chatId: integer("chat_id").notNull(),
    userText: text("user_text"),
    payloadJson: text("payload_json", { mode: "json" }).notNull(),
    status: text("status").notNull().default("pending"),
    deliverAfter: integer("deliver_after", { mode: "timestamp" }),
    error: text("error"),
    created: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
    updated: integer("updated_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  },
  (t) => ({
    chatStatusIdx: index("idx_turns_chat_status").on(t.chatId, t.status),
    chatCreatedIdx: index("idx_turns_chat_created").on(t.chatId, t.created),
  }),
);

export const attachments = table(
  "attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    turnId: integer("turn_id").notNull(),
    fileId: text("file_id").notNull(),
    fileName: text("file_name"),
    mimeType: text("mime_type"),
    isImage: boolean("is_image").default(false),
    created: integer("created_at", { mode: "timestamp" }).default(sql`(unixepoch())`),
  },
  (t) => ({ turnIdx: index("idx_attachments_turn").on(t.turnId) }),
);
