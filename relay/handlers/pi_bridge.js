// Invoked by Pitgram through Telegram Serverless's authenticated manage/run API.
// This avoids the impossible combination of a bot webhook and getUpdates polling.

import { countPending, claimNextDue, attachmentsFor, markDone, markError, requeueRunning } from "lib/queue";
import { setPiOnline, setPiOffline } from "lib/pi_relay";

export default async function (input) {
  const { op, chatId, turnId, message } = input ?? {};
  if (!Number.isInteger(chatId)) return { ok: false, error: "chatId is required" };

  if (op === "online") {
    await setPiOnline(chatId);
    return { ok: true, pending: await countPending(chatId) };
  }
  if (op === "offline") {
    await setPiOffline(chatId);
    await requeueRunning(chatId);
    return { ok: true };
  }
  if (op === "status") {
    return { ok: true, pending: await countPending(chatId) };
  }
  if (op === "next") {
    await setPiOnline(chatId);
    const turn = await claimNextDue(chatId);
    if (!turn) return { ok: true, turn: null, pending: await countPending(chatId) };
    const attachments = await attachmentsFor(turn.id);
    return {
      ok: true,
      turn: {
        id: turn.id,
        chatId: turn.chatId,
        userText: turn.userText,
        payload: turn.payloadJson,
        attachments: attachments.map((item) => ({
          fileId: item.fileId,
          fileName: item.fileName,
          mimeType: item.mimeType,
          isImage: item.isImage,
        })),
      },
    };
  }
  if (op === "done") {
    if (!Number.isInteger(turnId)) return { ok: false, error: "turnId is required" };
    return { ok: await markDone(turnId, chatId) };
  }
  if (op === "error") {
    if (!Number.isInteger(turnId)) return { ok: false, error: "turnId is required" };
    return { ok: await markError(turnId, chatId, message) };
  }
  return { ok: false, error: "unknown operation" };
}
