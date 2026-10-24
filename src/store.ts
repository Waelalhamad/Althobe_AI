// Small SQLite database (built into Node): WhatsApp conversations, AI usage, activity log, settings.
// WhatsApp's API doesn't let us fetch chat history, so we keep our own copy.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import type { ChatTurn } from "./agent.js";

fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
export const db = new DatabaseSync(config.databasePath);

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer    TEXT    NOT NULL,          -- customer's WhatsApp number
    role        TEXT    NOT NULL,          -- 'customer' | 'business'
    source      TEXT    NOT NULL,          -- 'customer' | 'ai' | 'staff'
    text        TEXT    NOT NULL,
    wamid       TEXT    UNIQUE,            -- WhatsApp message id (dedupes webhook retries)
    created_at  INTEGER NOT NULL           -- unix ms
  );
  CREATE INDEX IF NOT EXISTS messages_customer ON messages (customer, id);
  CREATE INDEX IF NOT EXISTS messages_created ON messages (created_at);

  CREATE TABLE IF NOT EXISTS pauses (
    customer    TEXT    PRIMARY KEY,
    until       INTEGER NOT NULL,          -- unix ms; AI is silent until then
    reason      TEXT    NOT NULL
  );

  -- One row per AI decision, for the dashboard's numbers and cost.
  CREATE TABLE IF NOT EXISTS ai_calls (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    customer          TEXT    NOT NULL,    -- WhatsApp number, or "cw:<conversation id>" for Chatwoot
    channel           TEXT    NOT NULL,    -- 'whatsapp' | 'chatwoot'
    action            TEXT    NOT NULL,    -- 'reply' | 'handoff' | 'error'
    reason            TEXT,
    model             TEXT,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0, -- includes reasoning tokens
    reasoning_tokens  INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ai_calls_created ON ai_calls (created_at);
  CREATE INDEX IF NOT EXISTS ai_calls_customer ON ai_calls (customer, id);

  -- What the server did (the same lines as the console log).
  CREATE TABLE IF NOT EXISTS events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation  TEXT    NOT NULL,
    message       TEXT    NOT NULL,
    created_at    INTEGER NOT NULL
  );

  -- Settings changed from the dashboard (they override the environment variables).
  CREATE TABLE IF NOT EXISTS settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
`);

// Added later: 1 = imported from the WhatsApp Business app's chat history (Coexistence history sync).
const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
if (!columns.some((c) => c.name === "history")) {
  db.exec("ALTER TABLE messages ADD COLUMN history INTEGER NOT NULL DEFAULT 0");
}

const insertMessage = db.prepare(
  "INSERT OR IGNORE INTO messages (customer, role, source, text, wamid, created_at, history) VALUES (?, ?, ?, ?, ?, ?, ?)",
);

type StoredMessage = {
  customer: string;
  role: ChatTurn["role"];
  source: "customer" | "ai" | "staff";
  text: string;
  wamid?: string;
  createdAt?: number;
};

// Returns false if this WhatsApp message id was already stored (duplicate delivery).
export function saveMessage(m: StoredMessage, fromHistory = false): boolean {
  const result = insertMessage.run(
    m.customer,
    m.role,
    m.source,
    m.text,
    m.wamid ?? null,
    m.createdAt ?? Date.now(),
    fromHistory ? 1 : 0,
  );
  return result.changes > 0;
}

// Stores one chunk of imported chat history in a single transaction. Returns how many were new.
export function saveHistory(messages: StoredMessage[]): number {
  let added = 0;
  db.exec("BEGIN");
  try {
    for (const m of messages) if (saveMessage(m, true)) added++;
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return added;
}

// Newest first. Imported history is older than every live message, but arrives in any order,
// so it sorts by its WhatsApp timestamp; live messages sort by arrival (id).
const selectHistory = db.prepare(
  `SELECT role, text FROM messages WHERE customer = ?
   ORDER BY history ASC, CASE WHEN history = 1 THEN created_at ELSE id END DESC, id DESC LIMIT ?`,
);

export function getHistory(customer: string): ChatTurn[] {
  const rows = selectHistory.all(customer, config.historyLimit) as { role: ChatTurn["role"]; text: string }[];
  return rows.reverse();
}

const upsertPause = db.prepare(
  "INSERT INTO pauses (customer, until, reason) VALUES (?, ?, ?) ON CONFLICT(customer) DO UPDATE SET until = excluded.until, reason = excluded.reason",
);

export function pauseAi(customer: string, reason: string, hours = config.whatsapp.humanPauseHours) {
  const until = Date.now() + hours * 60 * 60 * 1000;
  upsertPause.run(customer, until, reason);
}

const deletePause = db.prepare("DELETE FROM pauses WHERE customer = ?");

export function resumeAi(customer: string) {
  deletePause.run(customer);
}

const selectPause = db.prepare("SELECT until FROM pauses WHERE customer = ?");

export function isAiPaused(customer: string): boolean {
  const row = selectPause.get(customer) as { until: number } | undefined;
  return row !== undefined && row.until > Date.now();
}

// --- AI usage --------------------------------------------------------------

export type AiUsage = {
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  latencyMs: number;
};

const insertAiCall = db.prepare(
  `INSERT INTO ai_calls (customer, channel, action, reason, model, prompt_tokens, cached_tokens,
     completion_tokens, reasoning_tokens, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function recordAiCall(call: {
  customer: string;
  channel: "whatsapp" | "chatwoot";
  action: "reply" | "handoff" | "error";
  reason?: string;
  usage?: AiUsage;
}) {
  const u = call.usage;
  insertAiCall.run(
    call.customer,
    call.channel,
    call.action,
    call.reason ?? null,
    u?.model ?? null,
    u?.promptTokens ?? 0,
    u?.cachedTokens ?? 0,
    u?.completionTokens ?? 0,
    u?.reasoningTokens ?? 0,
    u?.latencyMs ?? 0,
    Date.now(),
  );
}

// --- Activity log ------------------------------------------------------------

const insertEvent = db.prepare("INSERT INTO events (conversation, message, created_at) VALUES (?, ?, ?)");

export function recordEvent(conversation: string, message: string) {
  insertEvent.run(conversation, message, Date.now());
}

// Keep the log from growing forever: drop events older than 30 days, once an hour.
setInterval(() => {
  db.prepare("DELETE FROM events WHERE created_at < ?").run(Date.now() - 30 * 24 * 60 * 60 * 1000);
}, 60 * 60 * 1000).unref();

// --- Settings ------------------------------------------------------------------

const selectSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const upsertSetting = db.prepare(
  "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);

export function getSetting(key: string): string | undefined {
  return (selectSetting.get(key) as { value: string } | undefined)?.value;
}

export function setSetting(key: string, value: string) {
  upsertSetting.run(key, value);
}
