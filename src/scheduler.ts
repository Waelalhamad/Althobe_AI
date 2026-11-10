import { recordEvent } from "./store.js";

// Per-conversation reply scheduling shared by all channels:
// - debounce: wait for the customer to finish typing several quick messages;
// - one reply at a time per conversation.

const timers = new Map<string, NodeJS.Timeout>();
const busy = new Set<string>();
const queued = new Map<string, number>(); // runs waiting for the one in progress to finish

// Another reply is scheduled or waiting to run for this conversation.
export function replyPending(key: string): boolean {
  return timers.has(key) || (queued.get(key) ?? 0) > 0;
}

export function scheduleReply(key: string, delayMs: number, run: () => Promise<void>) {
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      void runExclusive(key, run);
    }, delayMs),
  );
}

async function runExclusive(key: string, run: () => Promise<void>, waiting = false) {
  if (busy.has(key)) {
    // A reply is being generated right now; try again after it finishes.
    if (!waiting) queued.set(key, (queued.get(key) ?? 0) + 1);
    setTimeout(() => void runExclusive(key, run, true), 1000);
    return;
  }
  if (waiting) {
    const n = (queued.get(key) ?? 1) - 1;
    if (n > 0) queued.set(key, n);
    else queued.delete(key);
  }
  busy.add(key);
  try {
    await run();
  } finally {
    busy.delete(key);
  }
}

// Console log, plus the dashboard's activity log.
export function log(conversation: string, message: string) {
  console.log(`${new Date().toISOString()} [${conversation}] ${message}`);
  try {
    recordEvent(conversation, message);
  } catch (error) {
    console.error("Could not store event:", error);
  }
}
