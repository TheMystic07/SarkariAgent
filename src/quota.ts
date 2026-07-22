// In-memory per-chat daily quota (resets on process restart — acceptable for
// a beta bot; the point is stopping strangers from draining API credits).
const counts = new Map<string, number>();

function dayKey(chatId: number, now: Date): string {
  return `${chatId}:${now.toISOString().slice(0, 10)}`;
}

export function dailyLimit(): number {
  return Number(process.env.DAILY_MSG_LIMIT ?? 50);
}

/** Consume one message from the chat's daily budget. */
export function consumeQuota(chatId: number, now = new Date()): { allowed: boolean; used: number; limit: number } {
  if (counts.size > 10_000) {
    const today = now.toISOString().slice(0, 10);
    for (const key of counts.keys()) {
      if (!key.endsWith(today)) counts.delete(key);
    }
  }
  const key = dayKey(chatId, now);
  const used = (counts.get(key) ?? 0) + 1;
  const limit = dailyLimit();
  if (used > limit) return { allowed: false, used: used - 1, limit };
  counts.set(key, used);
  return { allowed: true, used, limit };
}
