// Small SQLite database (built into Node): WhatsApp conversations, AI usage, activity log, settings.
// WhatsApp's API doesn't let us fetch chat history, so we keep our own copy.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { aiCostUsd, config } from "./config.js";
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
    customer          TEXT    NOT NULL,    -- see Channel below
    channel           TEXT    NOT NULL,    -- 'whatsapp' | 'messenger' | 'instagram' | 'chatwoot'
    action            TEXT    NOT NULL,    -- 'reply' | 'handoff' | 'order' | 'error' | 'followup'
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

// Columns added later.
const columns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
for (const [name, type] of [
  ["history", "INTEGER NOT NULL DEFAULT 0"], // 1 = imported from the WhatsApp Business app's chat history
  ["media_type", "TEXT"], // 'image' | 'audio' | 'video' | 'document' | 'sticker'
  ["media_file", "TEXT"], // path inside DATA_DIR, e.g. media/wamid.jpg or catalog/abc.jpg
  ["media_mime", "TEXT"],
]) {
  if (!columns.some((c) => c.name === name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
}

const insertMessage = db.prepare(
  `INSERT OR IGNORE INTO messages (customer, role, source, text, wamid, created_at, history, media_type, media_file, media_mime)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export type StoredMedia = { type: string; file: string; mime: string };

type StoredMessage = {
  customer: string;
  role: ChatTurn["role"];
  source: "customer" | "ai" | "staff";
  text: string;
  wamid?: string;
  createdAt?: number;
  media?: StoredMedia;
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
    m.media?.type ?? null,
    m.media?.file ?? null,
    m.media?.mime ?? null,
  );
  return result.changes > 0;
}

// Fills in a message after its photo/voice note was downloaded (and transcribed).
const updateMedia = db.prepare(
  "UPDATE messages SET text = ?, media_type = ?, media_file = ?, media_mime = ? WHERE wamid = ?",
);

export function attachMedia(wamid: string, text: string, media: StoredMedia) {
  updateMedia.run(text, media.type, media.file, media.mime, wamid);
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
  `SELECT role, text, media_type, media_file FROM messages WHERE customer = ?
   ORDER BY history ASC, CASE WHEN history = 1 THEN created_at ELSE id END DESC, id DESC LIMIT ?`,
);

// The customer's photos are given to the AI as files (only the most recent few, to keep cost down).
export function getHistory(customer: string): (ChatTurn & { imageFile?: string })[] {
  const rows = selectHistory.all(customer, config.historyLimit) as {
    role: ChatTurn["role"];
    text: string;
    media_type: string | null;
    media_file: string | null;
  }[];
  let images = 0;
  return rows
    .map((r) => {
      const isImage = r.role === "customer" && r.media_type === "image" && r.media_file && images < config.media.maxImagesPerReply;
      if (isImage) images++;
      return { role: r.role, text: r.text, ...(isImage ? { imageFile: r.media_file! } : {}) };
    })
    .reverse();
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
  // Summed per call at each model's price: one decision can mix models (the reply and its check).
  costUsd: number;
};

// Cost in US$, saved with each call since prices differ per model. Older rows get it from their model once.
if (!(db.prepare("PRAGMA table_info(ai_calls)").all() as { name: string }[]).some((c) => c.name === "cost_usd")) {
  db.exec("ALTER TABLE ai_calls ADD COLUMN cost_usd REAL");
  const old = db.prepare("SELECT id, model, prompt_tokens, cached_tokens, completion_tokens FROM ai_calls").all() as {
    id: number;
    model: string | null;
    prompt_tokens: number;
    cached_tokens: number;
    completion_tokens: number;
  }[];
  const setCost = db.prepare("UPDATE ai_calls SET cost_usd = ? WHERE id = ?");
  db.exec("BEGIN");
  for (const r of old) setCost.run(aiCostUsd(r.model, r.prompt_tokens, r.cached_tokens, r.completion_tokens), r.id);
  db.exec("COMMIT");
}

const insertAiCall = db.prepare(
  `INSERT INTO ai_calls (customer, channel, action, reason, model, prompt_tokens, cached_tokens,
     completion_tokens, reasoning_tokens, latency_ms, cost_usd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function recordAiCall(call: {
  customer: string;
  channel: Channel;
  action: "reply" | "handoff" | "order" | "none" | "error" | "followup" | "lesson" | "draft" | "photo";
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
    u?.costUsd ?? 0,
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

// How long the AI stays out of a chat after the team writes in it (Settings). Each team message restarts it,
// so the AI only comes back once the team has been quiet that long.
export function teamPauseMinutes(): number {
  const minutes = Number(getSetting("team_pause_minutes"));
  return Number.isFinite(minutes) && minutes >= 5 ? minutes : 30;
}

// Also moves the chats paused by a team reply right now to the new length.
export function setTeamPauseMinutes(minutes: number) {
  const change = (minutes - teamPauseMinutes()) * 60 * 1000;
  setSetting("team_pause_minutes", String(minutes));
  db.prepare("UPDATE pauses SET until = until + ? WHERE reason LIKE 'team replied%'").run(change);
}

// Before this setting, a team reply paused the AI for HUMAN_PAUSE_HOURS; the chats paused that way get the new length.
if (getSetting("team_pause_minutes") === undefined) {
  const change = (teamPauseMinutes() - config.whatsapp.humanPauseHours * 60) * 60 * 1000;
  setSetting("team_pause_minutes", String(teamPauseMinutes()));
  db.prepare("UPDATE pauses SET until = until + ? WHERE reason LIKE 'team replied%'").run(change);
}

// --- Orders the AI collected (the team confirms them) --------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer    TEXT    NOT NULL,          -- see Channel below
    channel     TEXT    NOT NULL,          -- 'whatsapp' | 'messenger' | 'instagram' | 'chatwoot'
    name        TEXT    NOT NULL,
    phone       TEXT    NOT NULL,
    city        TEXT    NOT NULL,
    address     TEXT    NOT NULL,
    items       TEXT    NOT NULL,          -- JSON: [{ color, size, quantity }]
    total       TEXT    NOT NULL,          -- as the AI stated it, e.g. "385 دينار"
    notes       TEXT    NOT NULL DEFAULT '',
    status      TEXT    NOT NULL DEFAULT 'new', -- 'new' | 'confirmed' | 'delivered' | 'cancelled'
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_created ON orders (created_at);
`);
// Who recorded the order: the AI (customer confirmed the summary) or the team (from the dashboard).
if (!(db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).some((c) => c.name === "source")) {
  db.exec("ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'ai'");
}
// The Darb Assabil shipment made from the order: its id, reference number (what the courier and customer see) and status.
if (!(db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).some((c) => c.name === "darb_ref")) {
  db.exec(`ALTER TABLE orders ADD COLUMN darb_id TEXT;
    ALTER TABLE orders ADD COLUMN darb_ref TEXT;
    ALTER TABLE orders ADD COLUMN darb_status TEXT;
    ALTER TABLE orders ADD COLUMN darb_at INTEGER;`);
}

// Team orders for customers who write from a WhatsApp username were saved without the "LY." of their id
// (fixed in the dashboard route): link them back to their chat.
db.exec(`UPDATE orders SET customer = (
    SELECT m.customer FROM messages m WHERE m.customer GLOB '[A-Z][A-Z].*' AND substr(m.customer, 4) = orders.customer LIMIT 1)
  WHERE source = 'team' AND customer NOT GLOB '*[^0-9]*'
    AND EXISTS (SELECT 1 FROM messages m WHERE m.customer GLOB '[A-Z][A-Z].*' AND substr(m.customer, 4) = orders.customer)`);

// How the customer pays: "cash" on delivery (what we prefer) or bank "transfer"; empty on older orders.
if (!(db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).some((c) => c.name === "payment")) {
  db.exec("ALTER TABLE orders ADD COLUMN payment TEXT NOT NULL DEFAULT ''");
}
export const PAYMENTS = ["cash", "transfer"] as const;
export type Payment = (typeof PAYMENTS)[number];
export const PAYMENT_LABEL: Record<Payment, string> = { cash: "كاش عند الاستلام", transfer: "تحويل مصرفي" };

// product: which product (empty on orders saved before there could be several).
export type OrderItem = { product?: string; color: string; size: string; quantity: number };

export type NewOrder = {
  customer: string;
  channel: Channel;
  name: string;
  phone: string;
  city: string;
  address: string;
  items: OrderItem[];
  total: string;
  notes: string;
  payment?: Payment;
  source?: "ai" | "team";
  status?: OrderStatus;
};

const insertOrder = db.prepare(
  `INSERT INTO orders (customer, channel, name, phone, city, address, items, total, notes, payment, source, status, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

export function saveOrder(o: NewOrder): number {
  const now = Date.now();
  const result = insertOrder.run(
    o.customer, o.channel, o.name, o.phone, o.city, o.address, JSON.stringify(o.items), o.total, o.notes, o.payment ?? "",
    o.source ?? "ai", o.status ?? "new", now, now,
  );
  const id = Number(result.lastInsertRowid);
  if ((o.status ?? "new") !== "cancelled") takeStock(id, o.items);
  return id;
}

// The same items already ordered by this customer and still open: the AI re-sending an order it took earlier in the chat.
// The same pieces (color, size, quantity), whatever the product is called: the AI wrote "الثوب العربي" one day and
// "طقم عربي ثلاث قطع" the next for the same order.
export const sameItemsKey = (items: OrderItem[]) =>
  items
    .map((i) => `${stockName(i.color)}|${stockName(i.size).replace(/\D/g, "") || stockName(i.size)}|${i.quantity}`)
    .sort()
    .join(";");

export function findSameOrder(customer: string, items: OrderItem[], since: number): number | undefined {
  const key = sameItemsKey(items);
  const rows = db
    .prepare("SELECT id, items FROM orders WHERE customer = ? AND status IN ('new', 'confirmed') AND created_at > ? ORDER BY id DESC")
    .all(customer, since) as { id: number; items: string }[];
  return rows.find((r) => sameItemsKey(JSON.parse(r.items) as OrderItem[]) === key)?.id;
}

// A map location the customer sent after ordering replaces the one in the order's address (or is added to it).
export function updateOrderLocation(id: number, link: string): { changed: boolean; sentToDarb: boolean } {
  const row = db.prepare("SELECT address, darb_id FROM orders WHERE id = ?").get(id) as { address: string; darb_id: string | null } | undefined;
  if (!row || row.address.includes(link)) return { changed: false, sentToDarb: Boolean(row?.darb_id) };
  const MAP = /https?:\/\/(?:www\.)?(?:maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)\S*/i;
  const address = MAP.test(row.address) ? row.address.replace(MAP, link) : [row.address.trim(), link].filter(Boolean).join(" - ");
  db.prepare("UPDATE orders SET address = ?, updated_at = ? WHERE id = ?").run(address, Date.now(), id);
  return { changed: true, sentToDarb: Boolean(row.darb_id) };
}

export type OrderFields = Pick<NewOrder, "name" | "phone" | "city" | "address" | "items" | "total" | "notes" | "payment">;

// The team corrects an order (a wrong number, a changed size...).
export function updateOrder(id: number, o: OrderFields): boolean {
  // Changed items (another color or size) move the stock with them.
  const before = stockState(id);
  if (before?.applied) returnStock(id, before.items);
  const changed =
    db
      .prepare("UPDATE orders SET name = ?, phone = ?, city = ?, address = ?, items = ?, total = ?, notes = ?, payment = ?, updated_at = ? WHERE id = ?")
      .run(o.name, o.phone, o.city, o.address, JSON.stringify(o.items), o.total, o.notes, o.payment ?? "", Date.now(), id).changes > 0;
  if (before?.applied) takeStock(id, changed ? o.items : before.items);
  return changed;
}

export const ORDER_STATUSES = ["new", "confirmed", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function setOrderStatus(id: number, status: OrderStatus): boolean {
  const before = stockState(id);
  const changed = db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id).changes > 0;
  // A cancelled order gives its pieces back; un-cancelling takes them again.
  if (changed && before) {
    if (status === "cancelled" && before.applied) returnStock(id, before.items);
    else if (status !== "cancelled" && before.status === "cancelled" && !before.applied) takeStock(id, before.items);
  }
  return changed;
}

// --- Stock: pieces left per product, color and size (set by the team in the dashboard) ---
// An order takes its pieces when it is saved and gives them back when it is cancelled. Orders from before stock
// was kept never took any (stock_applied 0), so cancelling them changes nothing.

db.exec(`
  CREATE TABLE IF NOT EXISTS stock (
    product     TEXT    NOT NULL,
    color       TEXT    NOT NULL,
    size        TEXT    NOT NULL,
    quantity    INTEGER NOT NULL,          -- may go below 0 when more was sold than counted
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (product, color, size)
  );
`);
if (!(db.prepare("PRAGMA table_info(orders)").all() as { name: string }[]).some((c) => c.name === "stock_applied")) {
  db.exec("ALTER TABLE orders ADD COLUMN stock_applied INTEGER NOT NULL DEFAULT 0");
}

export type StockRow = { product: string; color: string; size: string; quantity: number; updatedAt: number };

export function listStock(): StockRow[] {
  return db.prepare("SELECT product, color, size, quantity, updated_at AS updatedAt FROM stock ORDER BY product, color, size").all() as StockRow[];
}

// Replaces one product's whole table (its colors and sizes).
export function setProductStock(product: string, rows: { color: string; size: string; quantity: number }[]) {
  const now = Date.now();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM stock WHERE product = ?").run(product);
    const insert = db.prepare("INSERT OR REPLACE INTO stock (product, color, size, quantity, updated_at) VALUES (?, ?, ?, ?, ?)");
    for (const r of rows) insert.run(product, r.color, r.size, Math.round(r.quantity), now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function deleteProductStock(product: string) {
  db.prepare("DELETE FROM stock WHERE product = ?").run(product);
}

// "الأسود" / "أسود" / "اللون: اسود" → "اسود"; Arabic digits → 0-9.
export function stockName(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^اللون\s*[:：]?\s*/, "")
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u064B-\u0652\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة$/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/^ال(?=\S{3,})/, "")
    .replace(/\s+/g, " ");
}

// The stock row an ordered item counts against. The product name the AI writes can differ from the dashboard's
// ("الثوب العربي" / "طقم عربي ثلاث قطع"): with one product kept in stock, every item is that product.
// Undefined: that item isn't kept in stock.
export function stockRowFor(item: OrderItem, rows = listStock()): StockRow | undefined {
  const products = [...new Set(rows.map((r) => r.product))];
  const product = item.product?.trim()
    ? (products.find((p) => stockName(p) === stockName(item.product!)) ?? (products.length === 1 ? products[0] : undefined))
    : products.length === 1
      ? products[0]
      : undefined;
  if (!product) return undefined;
  const size = stockName(item.size).replace(/\D/g, "") || stockName(item.size);
  return rows.find(
    (r) => r.product === product && stockName(r.color) === stockName(item.color) && (stockName(r.size).replace(/\D/g, "") || stockName(r.size)) === size,
  );
}

// Called when a piece runs out (stock.ts sends the Telegram alert).
let onStockOut: ((row: StockRow) => void) | undefined;
export function whenStockRunsOut(fn: (row: StockRow) => void) {
  onStockOut = fn;
}

function stockState(id: number): { items: OrderItem[]; status: OrderStatus; applied: boolean } | undefined {
  const row = db.prepare("SELECT items, status, stock_applied FROM orders WHERE id = ?").get(id) as
    | { items: string; status: OrderStatus; stock_applied: number }
    | undefined;
  return row && { items: JSON.parse(row.items) as OrderItem[], status: row.status, applied: row.stock_applied === 1 };
}

function moveStock(items: OrderItem[], sign: 1 | -1) {
  const rows = listStock();
  const update = db.prepare("UPDATE stock SET quantity = quantity + ?, updated_at = ? WHERE product = ? AND color = ? AND size = ?");
  for (const item of items) {
    const row = stockRowFor(item, rows);
    if (!row) continue;
    const delta = sign * item.quantity;
    update.run(delta, Date.now(), row.product, row.color, row.size);
    const before = row.quantity;
    row.quantity += delta;
    if (before > 0 && row.quantity <= 0) onStockOut?.(row);
  }
}

function takeStock(id: number, items: OrderItem[]) {
  moveStock(items, -1);
  db.prepare("UPDATE orders SET stock_applied = 1 WHERE id = ?").run(id);
}

function returnStock(id: number, items: OrderItem[]) {
  moveStock(items, 1);
  db.prepare("UPDATE orders SET stock_applied = 0 WHERE id = ?").run(id);
}

// The customer's latest WhatsApp message id (to mark it read / show "typing…").
export function lastCustomerWamid(customer: string): string | undefined {
  const row = db
    .prepare("SELECT wamid FROM messages WHERE customer = ? AND role = 'customer' AND wamid IS NOT NULL ORDER BY id DESC LIMIT 1")
    .get(customer) as { wamid: string } | undefined;
  return row?.wamid;
}

// The message a customer reacted to, and whether it is our latest one in the chat.
export function reactedMessage(customer: string, wamid: string): { text: string; role: string; isOurLast: boolean } | undefined {
  const row = db.prepare("SELECT id, text, role FROM messages WHERE customer = ? AND wamid = ?").get(customer, wamid) as
    | { id: number; text: string; role: string }
    | undefined;
  if (!row) return undefined;
  const last = db
    .prepare("SELECT MAX(id) AS id FROM messages WHERE customer = ? AND role = 'business' AND history = 0")
    .get(customer) as { id: number | null };
  return { text: row.text, role: row.role, isOurLast: row.role === "business" && last.id === row.id };
}

// What we know about a customer before today's chat, for the AI: new, wrote before, or has orders.
export function customerBackground(customer: string): string {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const earlier = db
    .prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM messages WHERE customer = ? AND created_at < ?")
    .get(customer, dayAgo) as { n: number; first: number | null };
  const orders = db
    .prepare("SELECT id, status, created_at FROM orders WHERE customer = ? ORDER BY id DESC LIMIT 3")
    .all(customer) as { id: number; status: string; created_at: number }[];
  const daysAgo = (ms: number) => Math.max(0, Math.round((Date.now() - ms) / (24 * 60 * 60 * 1000)));
  const lines = [
    earlier.n && earlier.first
      ? `Returning customer: wrote to us before (${earlier.n} earlier messages, first ${daysAgo(earlier.first)} days ago).`
      : "New customer: first time writing to us (today).",
    ...orders.map((o) => `Has order #${o.id} (status: ${o.status}, ${daysAgo(o.created_at)} days ago).`),
  ];
  return lines.join("\n");
}

// messages.id of the customer's latest live message (to tell whether they wrote since).
export function lastCustomerMessageId(customer: string): number | undefined {
  const row = db
    .prepare("SELECT MAX(id) AS id FROM messages WHERE customer = ? AND role = 'customer' AND history = 0")
    .get(customer) as { id: number | null };
  return row.id ?? undefined;
}

// --- Customers' WhatsApp profile (name, username), from the webhook's contacts -------

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    customer    TEXT PRIMARY KEY,          -- WhatsApp number, or the user ID of a customer without one
    wa_name     TEXT NOT NULL DEFAULT '',  -- the name on their WhatsApp profile
    username    TEXT NOT NULL DEFAULT '',  -- WhatsApp username, when they have one
    first_seen  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
`);

// Keeps what we had when WhatsApp sends an empty value.
// Where a conversation happens, from its customer key: a WhatsApp number (or "LY.…" username id),
// "fb:<PSID>" for Messenger, "ig:<IGSID>" for Instagram, "cw:<conversation id>" for Chatwoot.
export type Channel = "whatsapp" | "messenger" | "instagram" | "chatwoot";
export function channelOf(customer: string): Channel {
  if (customer.startsWith("fb:")) return "messenger";
  if (customer.startsWith("ig:")) return "instagram";
  if (customer.startsWith("cw:")) return "chatwoot";
  return "whatsapp";
}

export function saveContact(customer: string, waName = "", username = "") {
  const now = Date.now();
  db.prepare(
    `INSERT INTO customers (customer, wa_name, username, first_seen, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (customer) DO UPDATE SET
       wa_name = CASE WHEN excluded.wa_name <> '' THEN excluded.wa_name ELSE wa_name END,
       username = CASE WHEN excluded.username <> '' THEN excluded.username ELSE username END,
       updated_at = excluded.updated_at`,
  ).run(customer, waName.trim(), username.trim(), now, now);
}
