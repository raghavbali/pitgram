import { voiceMetadata } from "./voice_metadata.js";

export function minimalMessage(message, text) {
  const files = collectFileIds(message);
  const voice = voiceMetadata(message, files);
  return {
    chatId: message.chat.id,
    messageId: message.message_id,
    date: message.date,
    text,
    hasMedia: Boolean(message.photo || message.document || message.video || message.audio || message.voice || message.animation || message.sticker),
    ...(voice ? { voice } : {}),
  };
}

export function collectFileIds(message) {
  const files = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = [...message.photo].sort((a, b) => (a.file_size ?? 0) - (b.file_size ?? 0)).pop();
    if (photo) files.push({ fileId: photo.file_id, fileName: `photo-${message.message_id}.jpg`, mimeType: "image/jpeg", isImage: true });
  }
  if (message.document) files.push({ fileId: message.document.file_id, fileName: message.document.file_name, mimeType: message.document.mime_type, isImage: String(message.document.mime_type ?? "").startsWith("image/") });
  if (message.video) files.push({ fileId: message.video.file_id, fileName: message.video.file_name, mimeType: message.video.mime_type, isImage: false });
  if (message.audio) files.push({ fileId: message.audio.file_id, fileName: message.audio.file_name, mimeType: message.audio.mime_type, isImage: false });
  if (message.voice) files.push({ fileId: message.voice.file_id, fileName: `voice-${message.message_id}.ogg`, mimeType: message.voice.mime_type ?? "audio/ogg", isImage: false });
  if (message.animation) files.push({ fileId: message.animation.file_id, fileName: message.animation.file_name, mimeType: message.animation.mime_type, isImage: false });
  if (message.sticker) files.push({ fileId: message.sticker.file_id, fileName: `sticker-${message.message_id}.webp`, mimeType: "image/webp", isImage: true });
  return files;
}
