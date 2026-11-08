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
// Who has the shipment now (Darb's "handler": the courier delivering it, or an office) and its office, the courier's
// last note (why it's delayed: "الزبون لم يرد ع التلفون", "يستلم بعد العصر"), until when it's delayed, and when the
// courier who delivers it took it ("accepted"). Only in a shipment's details, fetched for the ones that moved.
for (const [name, type] of [
  ["courier_name", "TEXT"],
  ["courier_phone", "TEXT"],
  ["office_name", "TEXT"],
  ["office_phone", "TEXT"],
  ["delayed_until", "INTEGER"],
  ["note", "TEXT"],
  ["note_at", "INTEGER"],
  ["accepted_at", "INTEGER"],
] as const) {
  if (!(db.prepare("PRAGMA table_info(darb_shipments)").all() as { name: string }[]).some((c) => c.name === name)) {
    db.exec(`ALTER TABLE darb_shipments ADD COLUMN ${name} ${type}`);
  }
}

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
  timeline?: {
    type: string;
    description?: { ar?: string; en?: string } | string;
    timestamp: string;
    remarks?: string;
    createdBy?: { fname?: string; lname?: string; phone?: string };
  }[];
  createdAt: string;
  // In a shipment's details only (not in the list).
  handler?: { fname?: string; lname?: string; phone?: string };
  handlerAccount?: { name?: string; phone?: string };
  delayedUntil?: string;
};

// note: what the courier wrote with it; by: who did it.
export type TimelineEvent = { type: string; text: string; at: number; note?: string; by?: string };

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
  courier_name: string | null;
  courier_phone: string | null;
  office_name: string | null;
  office_phone: string | null;
  delayed_until: number | null;
  note: string | null;
  note_at: number | null;
  accepted_at: number | null;
};

// Where the money of a shipment stands.
export type MoneyStage = "paid" | "at_darb" | "on_way" | "returned" | "cancelled";
export function moneyStage(row: Pick<DarbShipmentRow, "status" | "paid_at">): MoneyStage {
  if (row.paid_at) return "paid";
  if (row.status === "completed") return "at_darb";
  // "released" is Darb's last step of a return: the goods were handed back to us (it always follows a cancel).
  if (row.status === "returning" || row.status === "returned" || row.status === "released") return "returned";
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
    ...(t.remarks?.trim() && { note: t.remarks.trim() }),
    ...(t.createdBy && { by: personName(t.createdBy) }),
  }));
  const handler = s.handler && personName(s.handler);
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
    courier_name: handler || null,
    courier_phone: phoneOf(s.handler?.phone),
    office_name: s.handlerAccount?.name?.trim() || null,
    office_phone: phoneOf(s.handlerAccount?.phone),
    delayed_until: time(s.delayedUntil),
    ...notesOf(timeline),
  };
}

const personName = (p: { fname?: string; lname?: string }) => [p.fname, p.lname].map((x) => x?.trim()).filter(Boolean).join(" ");
// "+2180919884455" (a 0 after the country code) → "+218919884455"; empty → null.
const phoneOf = (p?: string) => (p?.trim() ? p.trim().replace(/^\+2180/, "+218") : null);
// From the timeline: the courier's latest note, and when the courier delivering it accepted it.
function notesOf(timeline: TimelineEvent[]) {
  const noted = timeline.findLast((t) => t.note);
  return {
    note: noted?.note ?? null,
    note_at: noted?.at ?? null,
    accepted_at: timeline.findLast((t) => t.type === "accepted")?.at ?? null,
  };
}

const getRow = db.prepare("SELECT * FROM darb_shipments WHERE id = ?");
const upsert = db.prepare(`
  INSERT INTO darb_shipments (id, reference, sh, status, name, phone, city, area, amount, shipping, delivered_at, paid_at,
    payout_ref, last_event, last_event_at, timeline, created_at, synced_at, courier_name, courier_phone, office_name,
    office_phone, delayed_until, note, note_at, accepted_at)
  VALUES (@id, @reference, @sh, @status, @name, @phone, @city, @area, @amount, @shipping, @delivered_at, @paid_at,
    @payout_ref, @last_event, @last_event_at, @timeline, @created_at, @synced_at, @courier_name, @courier_phone, @office_name,
    @office_phone, @delayed_until, @note, @note_at, @accepted_at)
  ON CONFLICT (id) DO UPDATE SET reference = excluded.reference, sh = COALESCE(excluded.sh, sh), status = excluded.status,
    name = excluded.name, phone = excluded.phone, city = excluded.city, area = excluded.area, amount = excluded.amount,
    shipping = excluded.shipping, delivered_at = excluded.delivered_at, paid_at = excluded.paid_at,
    payout_ref = excluded.payout_ref, last_event = excluded.last_event, last_event_at = excluded.last_event_at,
    timeline = excluded.timeline, created_at = excluded.created_at, synced_at = excluded.synced_at,
    courier_name = COALESCE(excluded.courier_name, courier_name), courier_phone = COALESCE(excluded.courier_phone, courier_phone),
    office_name = COALESCE(excluded.office_name, office_name), office_phone = COALESCE(excluded.office_phone, office_phone),
    delayed_until = COALESCE(excluded.delayed_until, delayed_until), note = COALESCE(excluded.note, note),
    note_at = COALESCE(excluded.note_at, note_at), accepted_at = COALESCE(excluded.accepted_at, accepted_at)`);

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
      // The list carries no notes: the ones already fetched with the details stay on their events.
      if (before) {
        const known = new Map((JSON.parse(before.timeline) as TimelineEvent[]).map((t) => [`${t.type}|${t.at}`, t]));
        const timeline = (JSON.parse(row.timeline) as TimelineEvent[]).map((t) => {
          const old = known.get(`${t.type}|${t.at}`);
          return { ...t, ...(!t.note && old?.note && { note: old.note }), ...(!t.by && old?.by && { by: old.by }) };
        });
        row.timeline = JSON.stringify(timeline);
        Object.assign(row, notesOf(timeline));
      }
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
// The pieces in a shipment's order, for the alerts ("أسود 58، 2 × بني 56").
function pieces(darbId: string): string {
  const order = db.prepare("SELECT items FROM orders WHERE darb_id = ? LIMIT 1").get(darbId) as { items: string } | undefined;
  if (!order) return "";
  return (JSON.parse(order.items) as { color?: string; size?: string | number; quantity?: number }[])
    .map((i) => `${(i.quantity ?? 1) > 1 ? `${i.quantity} × ` : ""}${i.color ?? ""} ${i.size ?? ""}`.trim())
    .join("، ");
}

// Shipments that won't move any more.
const FINAL = ["completed", "released", "returned", "cancelled"];
// How many times a shipment was delayed.
const delays = (r: DarbShipmentRow) => (JSON.parse(r.timeline) as TimelineEvent[]).filter((t) => t.type === "delayed").length;

// Libya's time, "الثلاثاء 3/11 2:30 م".
export function libyaTime(ms: number): string {
  try {
    return new Intl.DateTimeFormat("ar-LY-u-nu-latn", { timeZone: "Africa/Tripoli", weekday: "long", day: "numeric", month: "numeric", hour: "numeric", minute: "2-digit" }).format(ms);
  } catch {
    return new Date(ms + 2 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
  }
}
const local = (phone: string) => phone.replace(/^\+218/, "0");

// Why it's delayed, until when, and who has it: the lines under a delay or a return alert.
function courierLines(r: DarbShipmentRow, whyLabel = "سبب المندوب"): string {
  const lines: string[] = [];
  if (r.note) lines.push(`📝 ${whyLabel}: «${esc(r.note)}»`);
  else if (r.status === "delayed") lines.push("📝 المندوب ما كتب سبب");
  if (r.status === "delayed" && r.delayed_until && r.delayed_until > Date.now()) lines.push(`🗓 مأجّلة لـ ${esc(libyaTime(r.delayed_until))}`);
  if (r.courier_phone && r.courier_phone !== r.office_phone) lines.push(`🚚 المندوب: ${esc(r.courier_name ?? "")} · <code>${esc(local(r.courier_phone))}</code>`);
  if (r.office_name) lines.push(`🏢 ${esc(r.office_name)}${r.office_phone ? ` · <code>${esc(local(r.office_phone))}</code>` : ""}`);
  return lines.length ? `\n${lines.join("\n")}` : "";
}

function tell(changes: Change[], again: DarbShipmentRow[] = []) {
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
    else if (row.status === "delayed")
      notify("order", `⏳ <b>شحنة مأجّلة</b>: ${label(row, true)}${courierLines(row)}\nراسلوا الزبون وخبّروه يتواصل مع المندوب.`);
    else if (row.status === "returning" || row.status === "cancelled")
      notify(
        "order",
        `${row.status === "returning" ? "↩️ <b>بضاعة راجعة لعنا</b>" : "🚫 <b>شحنة ملغية، البضاعة رح ترجع</b>"}: ${label(row, true)}` +
          `${pieces(row.id) ? `\n📦 ${esc(pieces(row.id))}` : ""}\n${esc(row.last_event)}${courierLines(row, "ملاحظة المندوب")}\n` +
          `قرّروا وين تروح: لزبون تاني بنفس المدينة ولا ترجع للمخزن${config.publicUrl ? `\n<a href="${config.publicUrl}/dashboard/stock">البضاعة الراجعة</a>` : ""}`,
      );
    else if (row.status === "returned" || row.status === "released") notify("order", `📥 <b>البضاعة رجعت</b>: ${label(row)}${pieces(row.id) ? `\n📦 ${esc(pieces(row.id))}` : ""}`);
  }
  for (const row of again) notify("order", `⏳ <b>تأجّلت مرة تانية</b> (${delays(row)} مرات): ${label(row, true)}${courierLines(row)}`);
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
  released: "returned to us (the order was cancelled)",
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
         d.last_event_at, d.created_at, d.courier_name, d.courier_phone, d.office_phone, d.note, d.delayed_until, d.accepted_at
       FROM orders o LEFT JOIN darb_shipments d ON d.id = o.darb_id
       WHERE (o.customer = ? OR REPLACE(o.phone, ' ', '') LIKE ?) AND o.status != 'cancelled' ORDER BY o.id DESC LIMIT 3`,
    )
    .all(customer, like) as ({
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
  } & CourierInfo)[];
  const loose = like
    ? (db
        .prepare(
          `SELECT * FROM darb_shipments d WHERE phone LIKE ? AND created_at > ?
             AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.darb_id = d.id) ORDER BY created_at DESC LIMIT 3`,
        )
        .all(like, Date.now() - 60 * 24 * 3_600_000) as DarbShipmentRow[])
    : [];
  const describe = (d: { sh: string | null; reference: string | null; status: string | null; city: string | null; area: string | null; last_event_at: number | null; created_at: number | null } & Partial<CourierInfo>) =>
    [
      `shipment ${d.reference ?? d.sh}${d.sh && d.sh !== d.reference ? ` (first number ${d.sh})` : ""} with Darb Assabil to ${d.city}${d.area && d.area !== d.city ? `/${d.area}` : ""}`,
      `Stage: ${TRACKING_STAGE[d.status ?? ""] ?? d.status}`,
      d.created_at && `sent ${hoursAgo(d.created_at)}`,
      d.last_event_at && `last update ${hoursAgo(d.last_event_at)}`,
      // The courier who delivers it (once he took it): the customer may call him.
      d.accepted_at && d.courier_phone && !FINAL.includes(d.status ?? "") && `The Darb courier delivering it: ${d.courier_name ?? ""}, phone ${d.courier_phone.replace(/^\+218/, "0")} (give it if they ask how to reach him or where it is)`,
      d.status === "delayed" && d.note && `The courier's note on the delay: "${d.note}"`,
      d.status === "delayed" && d.delayed_until && d.delayed_until > Date.now() && `delayed until ${libyaTime(d.delayed_until)} (Libya time)`,
    ]
      .filter(Boolean)
      .join(". ");
  const lines = [
    ...orders.map((o) =>
      o.shipment
        ? `Order #${o.id}: ${describe({ ...o, status: o.darb })}.${o.darb === "completed" ? "" : o.payment === "transfer" ? " Paid by bank transfer." : ` Pays ${o.total} cash on delivery.`}`
        : o.status === "delivered"
          ? `Order #${o.id}: delivered.`
          : `Order #${o.id}: ${o.status}, not sent to Darb Assabil yet (the team prepares and sends it).`,
    ),
    ...loose.map((d) => `A shipment for them (sent before our records): ${describe(d)}.`),
  ];
  return lines.length ? `Order tracking (from Darb Assabil, updated every 15 minutes):\n${lines.join("\n")}` : "";
}

type CourierInfo = {
  courier_name: string | null;
  courier_phone: string | null;
  office_phone: string | null;
  note: string | null;
  delayed_until: number | null;
  accepted_at: number | null;
};

let syncing: Promise<{ shipments: number; changes: number }> | undefined;

// Run for each shipment whose status changed (a refused one may go to someone else: src/darbRedirect.ts).
const onChange: ((row: DarbShipmentRow) => void)[] = [];
export const onShipmentStatus = (run: (row: DarbShipmentRow) => void) => void onChange.push(run);

// Run after every sync (the customers' tracking updates, src/tracking.ts).
const afterSync: (() => Promise<unknown>)[] = [];
export const onDarbSynced = (run: () => Promise<unknown>) => void afterSync.push(run);

// Every shipment of the account, newest first, 100 per page.
export function syncDarb(): Promise<{ shipments: number; changes: number }> {
  syncing ??= (async () => {
    const all: Shipment[] = [];
    let expected = 0; // Darb's own count: the list is complete when we have them all
    for (let page = 0; page < 50; page++) {
      const data = await darb<{ totalCount?: number; results: Shipment[] }>(
        "GET",
        `/api/local/shipments?offset=${page * 100}&limit=100&includeTotalCount=true`,
      );
      all.push(...data.results);
      expected = data.totalCount ?? 0;
      if (!data.results.length || all.length >= expected) break;
    }
    const before = new Map((db.prepare("SELECT * FROM darb_shipments").all() as DarbShipmentRow[]).map((r) => [r.id, r]));
    const changes = save(all);
    // The details (the courier, his note, until when it's delayed) of the shipments that moved since the last sync,
    // and of the ones on their way we don't know the courier of yet. One call each, so a few dozen at most.
    const moving = (s: Shipment) => !FINAL.includes(s.status) || ["cancelled", "returning"].includes(s.status);
    const toFetch = all
      .filter((s) => {
        const b = before.get(s._id);
        if (!b) return !FINAL.includes(s.status);
        const lastAt = Date.parse(s.timeline?.at(-1)?.timestamp ?? "") || null;
        return moving(s) && (b.last_event_at !== lastAt || b.status !== s.status || (!FINAL.includes(s.status) && !b.courier_phone));
      })
      .slice(0, 40);
    for (const s of toFetch) {
      const detail = await darb<{ results?: Shipment[] }>("GET", `/api/local/shipments/${encodeURIComponent(s._id)}`).catch(() => undefined);
      const found = detail?.results?.find((x) => x._id === s._id);
      if (found) save([found]);
    }
    // The rows as they are now (with the details) for the alerts, and the shipments delayed once more with a new note.
    for (const c of changes) c.row = getRow.get(c.row.id) as DarbShipmentRow;
    const again = toFetch
      .map((s) => ({ row: getRow.get(s._id) as DarbShipmentRow, b: before.get(s._id) }))
      .filter(({ row, b }) => b && b.status === "delayed" && row.status === "delayed" && delays(row) > delays(b))
      .map(({ row }) => row);
    // Shipments deleted at Darb leave our copy too (so our numbers are Darb's); only from a full list, and never
    // most of them at once (a short answer from Darb must not wipe our copy).
    const total = all.length;
    if (total > 0 && expected > 0 && total >= expected) {
      const live = new Set(all.map((s) => s._id));
      const ours = (db.prepare("SELECT id, reference FROM darb_shipments").all() as { id: string; reference: string }[]).filter((r) => !live.has(r.id));
      if (ours.length && ours.length <= Math.max(3, total * 0.1)) {
        for (const r of ours) {
          db.prepare("DELETE FROM darb_shipments WHERE id = ?").run(r.id);
          db.prepare("UPDATE orders SET darb_status = 'deleted', updated_at = ? WHERE darb_id = ?").run(Date.now(), r.id);
        }
        log("darb", `${ours.length} shipment(s) deleted at Darb, removed from our copy: ${ours.map((r) => r.reference).join(", ")}`);
      } else if (ours.length) log("darb", `${ours.length} shipments missing from Darb's list: kept (too many to be deletions)`);
    }
    tell(changes, again);
    for (const c of changes) if (c.before?.status !== c.row.status) for (const run of onChange) run(c.row);
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
export async function fetchShipmentById(id: string): Promise<DarbShipmentRow | undefined> {
  const data = await darb<{ results?: Shipment[] }>("GET", `/api/local/shipments/${encodeURIComponent(id)}`);
  const found = data.results?.find((s) => s._id === id);
  if (!found) return undefined;
  save([found]);
  return getRow.get(found._id) as DarbShipmentRow;
}

export async function fetchShipmentByNumber(number: string): Promise<DarbShipmentRow | undefined> {
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
  const row = await fetchShipmentByNumber(number);
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
    courierName: row.courier_name,
    courierPhone: row.courier_phone,
    officeName: row.office_name,
    officePhone: row.office_phone,
    delayedUntil: row.delayed_until,
    note: row.note,
    noteAt: row.note_at,
    orderId: orderFor(row.id) ?? null,
  };
}

// The order's shipment with its timeline, fresh from Darb (the saved copy if Darb doesn't answer).
// The shipment isn't at Darb any more: the dashboard offers to send it again (resendToDarb).
export class ShipmentGone extends Error {}

export async function trackOrder(orderId: number) {
  const order = loadOrder(orderId);
  if (!order?.darb_id) throw new Error("الطلب مش مربوط بشحنة");
  const saved = getRow.get(order.darb_id) as DarbShipmentRow | undefined;
  const ref = (db.prepare("SELECT darb_ref FROM orders WHERE id = ?").get(orderId) as { darb_ref: string | null }).darb_ref;
  // By Darb's id first: it stays the same when the number changes from "SH…" to the branch's number.
  const row =
    (await fetchShipmentById(order.darb_id).catch(() => undefined)) ??
    (await fetchShipmentByNumber(saved?.reference ?? ref ?? "").catch(() => undefined)) ??
    saved;
  if (!row) {
    throw new ShipmentGone(
      `الشحنة ${ref ?? ""} مش موجودة عند درب السبيل هلأ (يمكن انلغت أو انحذفت من تطبيق درب). شيك بتطبيق درب، وإذا لازم ابعت الطلب من جديد أو اربطو برقم الشحنة الصح.`,
    );
  }
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

// Shipments the team made in Darb's app that no order here is linked to (most from before the assistant took orders):
// the orders search finds them too, by number (SH or the branch's), phone or name.
export function unlinkedShipments(query: string) {
  const q = query.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
  if (!q || /^#\d+$/.test(q)) return [];
  const fold = (t: string) => t.replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي");
  const digits = /^\+?[\d\s]{4,}$/.test(q) ? q.replace(/\D/g, "").replace(/^0+/, "") : "";
  const number = shipmentNumber(q);
  const words = fold(q).split(/\s+/).filter(Boolean);
  const rows = db
    .prepare("SELECT * FROM darb_shipments d WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.darb_id = d.id) ORDER BY created_at DESC")
    .all() as DarbShipmentRow[];
  return rows
    .filter(
      (r) =>
        r.reference.toUpperCase().includes(number) ||
        (r.sh ?? "").includes(number) ||
        (digits && r.phone.replace(/\D/g, "").includes(digits)) ||
        words.every((w) => fold(`${r.name} ${r.city} ${r.area}`).includes(w)),
    )
    .slice(0, 20)
    .map((r) => ({ ...shipmentView(r), note: r.note, courierName: r.courier_name, courierPhone: r.courier_phone }));
}
