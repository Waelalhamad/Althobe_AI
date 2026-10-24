// Small SQLite database (built into Node) for WhatsApp conversations.
// WhatsApp's API doesn't let us fetch chat history, so we keep our own copy.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import type { ChatTurn } from "./agent.js";

fs.mkdirSync(path.dirname(path.resolve(config.databasePath)), { recursive: true });
const db = new DatabaseSync(config.databasePath);

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

  CREATE TABLE IF NOT EXISTS pauses (
    customer    TEXT    PRIMARY KEY,
    until       INTEGER NOT NULL,          -- unix ms; AI is silent until then
    reason      TEXT    NOT NULL
  );
`);

const insertMessage = db.prepare(
  "INSERT OR IGNORE INTO messages (customer, role, source, text, wamid, created_at) VALUES (?, ?, ?, ?, ?, ?)",
);

// Returns false if this WhatsApp message id was already stored (duplicate delivery).
export function saveMessage(m: {
  customer: string;
  role: ChatTurn["role"];
  source: "customer" | "ai" | "staff";
  text: string;
  wamid?: string;
  createdAt?: number;
}): boolean {
  const result = insertMessage.run(
    m.customer,
    m.role,
    m.source,
    m.text,
    m.wamid ?? null,
    m.createdAt ?? Date.now(),
  );
  return result.changes > 0;
}

const selectHistory = db.prepare(
  "SELECT role, text FROM messages WHERE customer = ? ORDER BY id DESC LIMIT ?",
);

export function getHistory(customer: string): ChatTurn[] {
  const rows = selectHistory.all(customer, config.historyLimit) as { role: ChatTurn["role"]; text: string }[];
  return rows.reverse();
}

const upsertPause = db.prepare(
  "INSERT INTO pauses (customer, until, reason) VALUES (?, ?, ?) ON CONFLICT(customer) DO UPDATE SET until = excluded.until, reason = excluded.reason",
);

export function pauseAi(customer: string, reason: string) {
  const until = Date.now() + config.whatsapp.humanPauseHours * 60 * 60 * 1000;
  upsertPause.run(customer, until, reason);
}

const selectPause = db.prepare("SELECT until FROM pauses WHERE customer = ?");

export function isAiPaused(customer: string): boolean {
  const row = selectPause.get(customer) as { until: number } | undefined;
  return row !== undefined && row.until > Date.now();
}
