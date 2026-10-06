export function voiceMetadata(message, files) {
  const duration = message.voice?.duration;
  const validDuration = duration === undefined || (Number.isSafeInteger(duration) && duration >= 0);
  const hasOtherMedia = Boolean((Array.isArray(message.photo) && message.photo.length > 0)
    || message.document || message.video || message.audio || message.animation || message.sticker);
  const mimeType = message.voice?.mime_type ?? "audio/ogg";
  if (!message.voice || mimeType !== "audio/ogg" || !validDuration || files.length !== 1
    || files[0].isImage || files[0].mimeType !== "audio/ogg" || hasOtherMedia
    || (message.text !== undefined && message.text !== "")
    || (message.caption !== undefined && message.caption !== "") || message.media_group_id) return null;
  return { mimeType: "audio/ogg", durationSeconds: duration ?? null };
}
