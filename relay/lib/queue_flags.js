const QUEUE_FLAG_REGEX = /(?:^|\s)(?:-q|--queue)(?:(?::|=|\s+)(?:(\d{1,3})h)?(?:(\d{1,2})m)?)?(?=\s|$)/i;

export function parseQueueFlag(text) {
  const match = text.match(QUEUE_FLAG_REGEX);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  return { delayMs: (hours * 3600 + minutes * 60) * 1000 };
}

export function stripQueueFlag(text) {
  return text.replace(QUEUE_FLAG_REGEX, " ").replace(/\s+/g, " ").trim();
}
