// Darb Assabil tracking and money: every shipment of our account (the ones sent from the dashboard and the ones the
// team entered in Darb's app) is copied here every 15 minutes, with its status, its timeline and its money: what the
// courier collects for us, the delivery fee, and whether Darb has paid it to us yet.
// An order sent before the integration is linked to its shipment by the shipment's number.
import { config } from "./config.js";
import { darb, intlPhone } from "./darb.js";
import { db, setOrderStatus, type OrderStatus } from "./store.js";
import { log } from "./scheduler.js";
import { esc, notify, notifyError } from "./telegram.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS darb_shipments (
    id            TEXT PRIMARY KEY,  -- Darb's _id
    reference     TEXT NOT NULL,     -- the number Darb shows now (it changes once the branch takes the shipment)
    sh            TEXT,              -- the first number ("SH2457769"), kept in the shipment's tags
    status        TEXT NOT NULL,
    name          TEXT NOT NULL DEFAULT '',
    phone         TEXT NOT NULL DEFAULT '',
    city          TEXT NOT NULL DEFAULT '',
    area          TEXT NOT NULL DEFAULT '',
    amount        REAL NOT NULL DEFAULT 0, -- ours once delivered: what the courier collects, less the delivery fee
    shipping      REAL NOT NULL DEFAULT 0, -- Darb's delivery fee
    delivered_at  INTEGER,
    paid_at       INTEGER,           -- Darb paid the amount to our wallet
    payout_ref    TEXT,              -- the payout's transaction number ("TX5000116")
    last_event    TEXT NOT NULL DEFAULT '',
    last_event_at INTEGER,
    timeline      TEXT NOT NULL DEFAULT '[]',
    created_at    INTEGER NOT NULL,
    synced_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS darb_shipments_created ON darb_shipments (created_at);
`);

type Shipment = {
  _id: string;
  reference: string;
  status: string;
  tags?: string[];
  contacts?: { phone?: string; nameMap?: Record<string, string> }[];
  to?: { city?: string; area?: string };
  invoices?: { _sums?: { product?: { sum?: number }; shipping?: { sum?: number } } }[];
  salesWithdrawalAt?: string;
  salesWithdrawalReferences?: string[];
  timeline?: { type: string; description?: { ar?: string; en?: string } | string; timestamp: string }[];
  createdAt: string;
};

export type TimelineEvent = { type: string; text: string; at: number };

export type DarbShipmentRow = {
  id: string;
  reference: string;
  sh: string | null;
  status: string;
  name: string;
  phone: string;
  city: string;
  area: string;
  amount: number;
  shipping: number;
  delivered_at: number | null;
  paid_at: number | null;
  payout_ref: string | null;
  last_event: string;
  last_event_at: number | null;
  timeline: string;
  created_at: number;
  synced_at: number;
};

// Where the money of a shipment stands.
export type MoneyStage = "paid" | "at_darb" | "on_way" | "returned" | "cancelled";
export function moneyStage(row: Pick<DarbShipmentRow, "status" | "paid_at">): MoneyStage {
  if (row.paid_at) return "paid";
  if (row.status === "completed") return "at_darb";
  if (row.status === "returning" || row.status === "returned") return "returned";
  if (row.status === "cancelled") return "cancelled";
  return "on_way";
}

const sum = (xs: (number | undefined)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const time = (iso?: string) => (iso ? Date.parse(iso) || null : null);
// "#SH2457769", " sh2457769 " → "SH2457769"; "#2719364" → "2719364"
export const shipmentNumber = (s: string) => s.replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x0660)).replace(/[#\s]/g, "").toUpperCase();

function toRow(s: Shipment): DarbShipmentRow {
  const timeline: TimelineEvent[] = (s.timeline ?? []).map((t) => ({
    type: t.type,
    text: (typeof t.description === "string" ? t.description : t.description?.ar || t.description?.en) ?? t.type,
    at: Date.parse(t.timestamp) || 0,
  }));
  const last = timeline.at(-1);
  const contact = s.contacts?.[0];
  const shTag = s.tags?.map(shipmentNumber).find((t) => /^SH\d+$/.test(t));
  return {
    id: s._id,
    reference: s.reference,
    sh: /^SH\d+$/.test(s.reference) ? s.reference : (shTag ?? null),
    status: s.status,
    // Shipments entered in Darb's app have "Unknown" as the contact's name and the real one in the tags.
    name: [...Object.values(contact?.nameMap ?? {}), ...(s.tags ?? [])].find((t) => t.trim() && t !== "Unknown" && !t.startsWith("#"))?.trim() ?? "",
    phone: contact?.phone ?? "",
    city: s.to?.city ?? "",
    area: s.to?.area ?? "",
    amount: sum((s.invoices ?? []).map((i) => i._sums?.product?.sum)),
    shipping: sum((s.invoices ?? []).map((i) => i._sums?.shipping?.sum)),
    delivered_at: timeline.findLast((t) => t.type === "completed")?.at ?? null,
    paid_at: time(s.salesWithdrawalAt),
    payout_ref: s.salesWithdrawalReferences?.[0] ?? null,
    last_event: last?.text ?? "",
    last_event_at: last?.at ?? null,
    timeline: JSON.stringify(timeline),
    created_at: Date.parse(s.createdAt) || Date.now(),
    synced_at: Date.now(),
  };
}

const getRow = db.prepare("SELECT * FROM darb_shipments WHERE id = ?");
const upsert = db.prepare(`
  INSERT INTO darb_shipments (id, reference, sh, status, name, phone, city, area, amount, shipping, delivered_at, paid_at,
    payout_ref, last_event, last_event_at, timeline, created_at, synced_at)
  VALUES (@id, @reference, @sh, @status, @name, @phone, @city, @area, @amount, @shipping, @delivered_at, @paid_at,
    @payout_ref, @last_event, @last_event_at, @timeline, @created_at, @synced_at)
  ON CONFLICT (id) DO UPDATE SET reference = excluded.reference, sh = COALESCE(excluded.sh, sh), status = excluded.status,
    name = excluded.name, phone = excluded.phone, city = excluded.city, area = excluded.area, amount = excluded.amount,
    shipping = excluded.shipping, delivered_at = excluded.delivered_at, paid_at = excluded.paid_at,
    payout_ref = excluded.payout_ref, last_event = excluded.last_event, last_event_at = excluded.last_event_at,
    timeline = excluded.timeline, created_at = excluded.created_at, synced_at = excluded.synced_at`);

type Change = { row: DarbShipmentRow; before?: DarbShipmentRow };

// Saves shipments, and keeps the orders linked to them up to date: the current number and status, and a delivered
// shipment marks its order delivered.
function save(shipments: Shipment[]): Change[] {
  const changes: Change[] = [];
  const delivered: number[] = [];
  db.exec("BEGIN");
  try {
    for (const s of shipments) {
      const row = toRow(s);
      const before = getRow.get(row.id) as DarbShipmentRow | undefined;
      upsert.run(row);
      if (before && (before.status !== row.status || (!before.paid_at && row.paid_at))) changes.push({ row, before });
      const orders = db.prepare("SELECT id, status, darb_status FROM orders WHERE darb_id = ?").all(row.id) as {
        id: number;
        status: OrderStatus;
        darb_status: string | null;
      }[];
      for (const o of orders) {
        db.prepare("UPDATE orders SET darb_ref = ?, darb_status = ?, updated_at = ? WHERE id = ? AND (darb_ref IS NOT ? OR darb_status IS NOT ?)").run(
          row.reference,
          row.status,
          Date.now(),
          o.id,
          row.reference,
          row.status,
        );
        if (row.status === "completed" && (o.status === "new" || o.status === "confirmed")) delivered.push(o.id);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  for (const id of delivered) setOrderStatus(id, "delivered");
  return changes;
}

const orderFor = (id: string) => (db.prepare("SELECT id FROM orders WHERE darb_id = ? LIMIT 1").get(id) as { id: number } | undefined)?.id;

// Telegram: a shipment delivered, delayed, coming back or cancelled, and money Darb paid us. The problems carry
// the chat's link, so the team can reach the customer.
function tell(changes: Change[]) {
  const label = (r: DarbShipmentRow, chat = false) => {
    const order = db.prepare("SELECT id, customer FROM orders WHERE darb_id = ? LIMIT 1").get(r.id) as { id: number; customer: string } | undefined;
    const link =
      chat && order && config.publicUrl
        ? `\n<a href="${config.publicUrl}/dashboard/inbox/${encodeURIComponent(order.customer)}">افتح المحادثة</a>`
        : "";
    return `${esc(r.name || r.phone)} · ${esc(r.city)} · <code>${esc(r.reference)}</code>${order ? ` · طلب #${order.id}` : ""}${link}`;
  };
  for (const { row, before } of changes) {
    if (before?.status === row.status) continue;
    if (row.status === "completed") notify("order", `✅ <b>انسلمت</b>: ${label(row)} · ${row.amount} دينار لإلنا`);
    else if (row.status === "delayed") notify("order", `⏳ <b>شحنة متأخرة</b>: ${label(row, true)}`);
    else if (row.status === "returning" || row.status === "returned") notify("order", `↩️ <b>شحنة راجعة</b>: ${label(row, true)}\n${esc(row.last_event)}`);
    else if (row.status === "cancelled") notify("order", `🚫 <b>شحنة ملغية</b>: ${label(row, true)}\n${esc(row.last_event)}`);
  }
  const paid = changes.filter((c) => !c.before?.paid_at && c.row.paid_at);
  if (paid.length) {
    notify("order", `💰 <b>درب السبيل حوّلولنا ${sum(paid.map((c) => c.row.amount))} دينار</b> (${paid.length} شحنة)`);
  }
}

// Where a shipment is, in plain words for the AI (Darb's own event text names its staff and flips states).
export const TRACKING_STAGE: Record<string, string> = {
  pending: "waiting for Darb's courier to pick it up from us",
  booked: "waiting for Darb's courier to pick it up from us",
  processing: "on the way between cities",
  resent: "on the way between cities",
  "on-branch": "at the Darb office in the customer's city: the courier calls the customer before delivering",
  delayed: "delayed",
  completed: "delivered",
  released: "delivered",
  returning: "being returned to us",
  returned: "returned to us",
  cancelled: "cancelled at Darb",
};

const hoursAgo = (ms: number) => {
  const h = Math.max(0, Math.round((Date.now() - ms) / 3_600_000));
  return h < 24 ? `${h} hours ago` : `${Math.round(h / 24)} days ago`;
};

// What we know about this customer's shipments, for the AI: their latest orders (by chat or phone) with the
// shipment's stage, and shipments sent from Darb's app to their number without an order here.
export function trackingNote(customer: string): string {
  // The last 9 digits match "0912345678", "218912345678" and "+218 91 234 5678" alike. Only a chat that is a
  // phone number (not a username id or a Messenger / Instagram one) is looked up by phone.
  const digits = /^\d{8,15}$/.test(customer) ? customer.slice(-9) : undefined;
  const like = digits ? `%${digits}` : null;
  const orders = db
    .prepare(
      `SELECT o.id, o.status, o.total, o.payment, d.id AS shipment, d.reference, d.sh, d.status AS darb, d.city, d.area,
         d.last_event_at, d.created_at
       FROM orders o LEFT JOIN darb_shipments d ON d.id = o.darb_id
       WHERE (o.customer = ? OR REPLACE(o.phone, ' ', '') LIKE ?) AND o.status != 'cancelled' ORDER BY o.id DESC LIMIT 3`,
    )
    .all(customer, like) as {
    id: number;
    status: string;
    total: string; // as stated, "385 دينار"
    payment: string;
    shipment: string | null;
    reference: string | null;
    sh: string | null;
    darb: string | null;
    city: string | null;
    area: string | null;
    last_event_at: number | null;
    created_at: number | null;
  }[];
  const loose = like
    ? (db
        .prepare(
          `SELECT * FROM darb_shipments d WHERE phone LIKE ? AND created_at > ?
             AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.darb_id = d.id) ORDER BY created_at DESC LIMIT 3`,
        )
        .all(like, Date.now() - 60 * 24 * 3_600_000) as DarbShipmentRow[])
    : [];
  const describe = (d: { sh: string | null; reference: string | null; status: string | null; city: string | null; area: string | null; last_event_at: number | null; created_at: number | null }) =>
    [
      `shipment ${d.sh ?? d.reference} with Darb Assabil to ${d.city}${d.area && d.area !== d.city ? `/${d.area}` : ""}`,
      `Stage: ${TRACKING_STAGE[d.status ?? ""] ?? d.status}`,
      d.created_at && `sent ${hoursAgo(d.created_at)}`,
      d.last_event_at && `last update ${hoursAgo(d.last_event_at)}`,
    ]
      .filter(Boolean)
      .join(". ");
  const lines = [
    ...orders.map((o) =>
      o.shipment
        ? `Order #${o.id}: ${describe({ ...o, status: o.darb })}.${o.darb === "completed" || o.darb === "released" ? "" : o.payment === "transfer" ? " Paid by bank transfer." : ` Pays ${o.total} cash on delivery.`}`
        : o.status === "delivered"
          ? `Order #${o.id}: delivered.`
          : `Order #${o.id}: ${o.status}, not sent to Darb Assabil yet (the team prepares and sends it).`,
    ),
    ...loose.map((d) => `A shipment for them (sent before our records): ${describe(d)}.`),
  ];
  return lines.length ? `Order tracking (from Darb Assabil, updated every 15 minutes):\n${lines.join("\n")}` : "";
}

let syncing: Promise<{ shipments: number; changes: number }> | undefined;

// Run after every sync (the customers' tracking updates, src/tracking.ts).
const afterSync: (() => Promise<unknown>)[] = [];
export const onDarbSynced = (run: () => Promise<unknown>) => void afterSync.push(run);

// Every shipment of the account, newest first, 100 per page.
export function syncDarb(): Promise<{ shipments: number; changes: number }> {
  syncing ??= (async () => {
    const all: Shipment[] = [];
    for (let page = 0; page < 50; page++) {
      const data = await darb<{ totalCount?: number; results: Shipment[] }>(
        "GET",
        `/api/local/shipments?offset=${page * 100}&limit=100&includeTotalCount=true`,
      );
      all.push(...data.results);
      if (!data.results.length || all.length >= (data.totalCount ?? 0)) break;
    }
    const changes = save(all);
    tell(changes);
    for (const run of afterSync) await run().catch((error) => log("darb", `after sync: ${error instanceof Error ? error.message : error}`));
    if (changes.length) log("darb", `synced ${all.length} shipments, ${changes.length} changed`);
    return { shipments: all.length, changes: changes.length };
  })().finally(() => (syncing = undefined));
  return syncing;
}

export function startDarbSync() {
  if (!config.darb.enabled) return;
  const run = () =>
    void syncDarb().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      log("darb", `sync failed: ${message}`);
      notifyError("درب السبيل (التتبع)", message);
    });
  setTimeout(run, 20_000).unref();
  setInterval(run, 15 * 60_000).unref();
}

// One shipment fresh from Darb, by its current number or its first "SH" number.
async function fetchShipment(number: string): Promise<DarbShipmentRow | undefined> {
  const n = shipmentNumber(number);
  if (!n) return undefined;
  const data = await darb<{ results: Shipment[] }>("GET", `/api/local/shipments?search=${encodeURIComponent(n)}&offset=0&limit=20`);
  const found = data.results.find((s) => shipmentNumber(s.reference) === n || s.tags?.some((t) => shipmentNumber(t) === n));
  if (!found) return undefined;
  save([found]);
  return getRow.get(found._id) as DarbShipmentRow;
}

const loadOrder = (id: number) =>
  db.prepare("SELECT id, phone, customer, status, darb_id FROM orders WHERE id = ?").get(id) as
    | { id: number; phone: string; customer: string; status: OrderStatus; darb_id: string | null }
    | undefined;

// An order sent to Darb by hand (before the integration) gets its shipment by the shipment's number.
// A shipment to another phone number is linked only when the team confirms it (force).
export class PhoneMismatch extends Error {}
export async function linkDarb(orderId: number, number: string, force = false) {
  const order = loadOrder(orderId);
  if (!order) throw new Error("Unknown order");
  if (order.darb_id) throw new Error("الطلب مربوط بشحنة من قبل");
  const row = await fetchShipment(number);
  if (!row) throw new Error(`ما لقيت شحنة بالرقم ${shipmentNumber(number)} بدرب السبيل`);
  const other = orderFor(row.id);
  if (other) throw new Error(`الشحنة ${row.reference} مربوطة بالطلب #${other}`);
  const phone = intlPhone(order.phone) ?? intlPhone(order.customer);
  if (!force && phone && row.phone && phone !== row.phone) {
    throw new PhoneMismatch(`الشحنة ${row.reference} لـ ${row.name || "زبون"} (${row.phone.replace(/^\+218/, "0")})، مش لرقم الطلب. متأكد إنها هي؟`);
  }
  db.prepare("UPDATE orders SET darb_id = ?, darb_ref = ?, darb_status = ?, darb_at = ?, updated_at = ? WHERE id = ?").run(
    row.id,
    row.reference,
    row.status,
    row.created_at,
    Date.now(),
    orderId,
  );
  if (row.status === "completed" && (order.status === "new" || order.status === "confirmed")) setOrderStatus(orderId, "delivered");
  else if (order.status === "new") setOrderStatus(orderId, "confirmed");
  log("darb", `order #${orderId} linked to shipment ${row.reference}`);
  return shipmentView(row);
}

// A wrong link is undone here (the shipment stays as it is at Darb).
export function unlinkDarb(orderId: number) {
  db.prepare("UPDATE orders SET darb_id = NULL, darb_ref = NULL, darb_status = NULL, darb_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), orderId);
  log("darb", `order #${orderId} unlinked from its shipment`);
  return { ok: true };
}

// Shipments to the order's phone that no order has yet, to pick from when linking.
export function darbMatches(orderId: number) {
  const order = loadOrder(orderId);
  const phone = order && (intlPhone(order.phone) ?? intlPhone(order.customer));
  if (!phone) return [];
  const rows = db
    .prepare("SELECT * FROM darb_shipments WHERE phone = ? AND id NOT IN (SELECT darb_id FROM orders WHERE darb_id IS NOT NULL) ORDER BY created_at DESC LIMIT 5")
    .all(phone) as DarbShipmentRow[];
  return rows.map(shipmentView);
}

export function shipmentView(row: DarbShipmentRow) {
  return {
    id: row.id,
    reference: row.reference,
    sh: row.sh,
    status: row.status,
    stage: moneyStage(row),
    name: row.name,
    phone: row.phone,
    city: row.city,
    area: row.area,
    amount: row.amount,
    shipping: row.shipping,
    deliveredAt: row.delivered_at,
    paidAt: row.paid_at,
    payoutRef: row.payout_ref,
    lastEvent: row.last_event,
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
    orderId: orderFor(row.id) ?? null,
  };
}

// The order's shipment with its timeline, fresh from Darb (the saved copy if Darb doesn't answer).
export async function trackOrder(orderId: number) {
  const order = loadOrder(orderId);
  if (!order?.darb_id) throw new Error("الطلب مش مربوط بشحنة");
  const saved = getRow.get(order.darb_id) as DarbShipmentRow | undefined;
  const ref = (db.prepare("SELECT darb_ref FROM orders WHERE id = ?").get(orderId) as { darb_ref: string | null }).darb_ref;
  const row = (await fetchShipment(saved?.reference ?? ref ?? "").catch(() => undefined)) ?? saved;
  if (!row) throw new Error("ما قدرت جيب الشحنة من درب السبيل");
  return { ...shipmentView(row), timeline: JSON.parse(row.timeline) as TimelineEvent[] };
}

// The money page: shipments of the period (by the day they were made) and where their money stands.
export async function darbMoney(from?: number, to?: number) {
  const rows = db
    .prepare("SELECT * FROM darb_shipments WHERE created_at >= ? AND created_at < ? ORDER BY created_at DESC")
    .all(from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as DarbShipmentRow[];
  const stages: Record<MoneyStage, { count: number; amount: number }> = {
    paid: { count: 0, amount: 0 },
    at_darb: { count: 0, amount: 0 },
    on_way: { count: 0, amount: 0 },
    returned: { count: 0, amount: 0 },
    cancelled: { count: 0, amount: 0 },
  };
  for (const r of rows) {
    const s = stages[moneyStage(r)];
    s.count++;
    s.amount += r.amount;
  }
  const payouts = db
    .prepare(
      `SELECT payout_ref AS reference, MAX(paid_at) AS at, SUM(amount) AS amount, COUNT(*) AS count FROM darb_shipments
       WHERE paid_at IS NOT NULL AND paid_at >= ? AND paid_at < ? GROUP BY payout_ref ORDER BY at DESC`,
    )
    .all(from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as { reference: string | null; at: number; amount: number; count: number }[];
  // Bank transfers are paid to us directly, not through Darb: from our own orders.
  const transferOrders = db
    .prepare("SELECT total FROM orders WHERE payment = 'transfer' AND status != 'cancelled' AND created_at >= ? AND created_at < ?")
    .all(from ?? 0, to ?? Number.MAX_SAFE_INTEGER) as { total: string }[];
  const wallet = await darb<{ balance: number }>("GET", "/api/wallet/balance/local/lyd")
    .then((w) => w.balance)
    .catch(() => null);
  const lastSync = (db.prepare("SELECT MAX(synced_at) AS at FROM darb_shipments").get() as { at: number | null }).at;
  return {
    stages,
    shipping: sum(rows.filter((r) => moneyStage(r) !== "cancelled").map((r) => r.shipping)),
    payouts,
    transfers: {
      count: transferOrders.length,
      amount: sum(transferOrders.map((o) => Number(o.total.replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x0660)).match(/\d+(\.\d+)?/)?.[0] ?? 0))),
    },
    wallet,
    lastSync,
    shipments: rows.map(shipmentView),
  };
}
