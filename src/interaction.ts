interface Waiter {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// At most one pending waiter per chat — a turn is single-threaded under the
// chat lock, so a tool that awaits user input is the only thing waiting.
const waiters = new Map<number, Waiter>();

export function hasWaiter(chatId: number): boolean {
  return waiters.has(chatId);
}

/** Called by the bot when an inbound message should answer a blocked tool. Returns true if it was consumed. */
export function deliverToWaiter(chatId: number, text: string): boolean {
  const w = waiters.get(chatId);
  if (!w) return false;
  waiters.delete(chatId);
  clearTimeout(w.timer);
  w.resolve(text);
  return true;
}

export function cancelWaiter(chatId: number, reason: string): void {
  const w = waiters.get(chatId);
  if (!w) return;
  waiters.delete(chatId);
  clearTimeout(w.timer);
  w.reject(new Error(reason));
}

/** Used by a tool to pause the turn until the user replies (or the timeout elapses). */
export function waitForUserReply(chatId: number, timeoutMs: number): Promise<string> {
  cancelWaiter(chatId, "superseded by a new wait");
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(chatId);
      reject(new Error("timeout"));
    }, timeoutMs);
    waiters.set(chatId, { resolve, reject, timer });
  });
}
