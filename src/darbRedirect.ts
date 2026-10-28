// A cancelled order's shipment goes to another customer instead of coming back: someone who ordered the same pieces
// (product, color, size, quantity) in the same city, whose order is new, or confirmed but not picked up by the courier.
// The dashboard shows the matches; nothing changes until the team picks one and presses "تمام".
// Darb lets us change everything while the courier hasn't picked the shipment up (PATCH /:id); once it's on its way
// only the receiver, the note and the amount can change (PATCH /modify/:id), hence the same city.
import { config } from "./config.js";
import {
  amount,
  charge,
  contactId,
  courierNote,
  darb,
  darbZones,
  destination,
  guessZone,
  intlPhone,
  loadOrder,
  products,
  type OrderRow,
  type Zone,
} from "./darb.js";
import { fetchShipmentById, onShipmentStatus, syncDarb, type DarbShipmentRow } from "./darbTrack.js";
import { forgetNotices } from "./tracking.js";
import { db, stockName, type OrderItem, type Payment } from "./store.js";
import { log } from "./scheduler.js";
import { esc, notify } from "./telegram.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS darb_redirects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_order  INTEGER NOT NULL,
    to_order    INTEGER NOT NULL,
    shipment_id TEXT    NOT NULL,
    picked_up   INTEGER NOT NULL,  -- 1 = changed on its way (receiver, note, amount only)
    created_at  INTEGER NOT NULL
  );
`);

// Statuses where the shipment is still out with Darb and can be given to someone else.
const DONE = new Set(["completed", "released", "returned", "cancelled"]);
// Not picked up yet: everything can still change.
const NOT_PICKED = new Set(["pending", "booked"]);

const itemsKey = (items: OrderItem[]) =>
  items
    .map((i) => `${stockName(i.color)}|${stockName(i.size).replace(/\D/g, "") || stockName(i.size)}|${i.quantity}`)
    .sort()
    .join(";");

const savedShipment = (id: string | null) =>
  id ? (db.prepare("SELECT * FROM darb_shipments WHERE id = ?").get(id) as DarbShipmentRow | undefined) : undefined;

// The order's shipment if it can go to someone else: the order was cancelled, or the customer refused it at the door
// (Darb sends it back: returning), and it isn't delivered or back with us yet.
function source(order: OrderRow | undefined, shipment = savedShipment(order?.darb_id ?? null)) {
  if (!order || !shipment || DONE.has(shipment.status)) return undefined;
  if (order.status !== "cancelled" && shipment.status !== "returning") return undefined;
  return shipment;
}

export type RedirectMatch = {
  orderId: number;
  name: string;
  phone: string;
  status: string;
  total: number;
  payment: Payment;
  address: string;
  area: string; // our guess in the shipment's city ("" when unsure)
  shipment: { reference: string; status: string } | null; // its own shipment, not picked up yet: cancelled on redirect
  createdAt: number;
};

function matchesFor(order: OrderRow, shipment: DarbShipmentRow, zones: Zone[]): RedirectMatch[] {
  const key = itemsKey(JSON.parse(order.items) as OrderItem[]);
  const rows = db
    .prepare("SELECT * FROM orders WHERE id != ? AND status IN ('new', 'confirmed') ORDER BY id DESC LIMIT 300")
    .all(order.id) as (OrderRow & { created_at: number })[];
  const out: RedirectMatch[] = [];
  for (const o of rows) {
    if (itemsKey(JSON.parse(o.items) as OrderItem[]) !== key) continue;
    const own = savedShipment(o.darb_id);
    if (o.darb_id && (!own || !NOT_PICKED.has(own.status))) continue; // already on its way to them
    const place = guessZone(zones, o.city, o.address);
    if (place?.city !== shipment.city) continue;
    out.push({
      orderId: o.id,
      name: o.name,
      phone: o.phone,
      status: o.status,
      total: amount(o.total) ?? 0,
      payment: (o.payment || (/حوال|تحويل|مصرف/.test(`${o.notes} ${o.total}`) ? "transfer" : "cash")) as Payment,
      address: o.address.trim(),
      area: place.area,
      shipment: own ? { reference: own.reference, status: own.status } : null,
      createdAt: o.created_at,
    });
  }
  return out;
}

// For the order card: the shipment (fresh from Darb) and who could get it instead.
export async function redirectMatches(orderId: number) {
  const order = loadOrder(orderId);
  const fresh = order?.darb_id ? await fetchShipmentById(order.darb_id).catch(() => undefined) : undefined;
  const shipment = source(order, fresh ?? savedShipment(order?.darb_id ?? null));
  if (!order || !shipment) throw new Error("هالطلب ما إلو شحنة ملغية فيك تحولها (لازم يكون ملغي أو راجع، وشحنتو لسا عند درب)");
  const zones = await darbZones();
  return {
    shipment: { reference: shipment.reference, sh: shipment.sh, status: shipment.status, city: shipment.city, area: shipment.area },
    pickedUp: !NOT_PICKED.has(shipment.status),
    areas: zones.find((z) => z.city === shipment.city)?.areas ?? [],
    matches: matchesFor(order, shipment, zones),
  };
}

// For the orders page banner: cancelled or refused shipments that someone else in the same city could take.
export async function redirectCandidates(): Promise<{ orderId: number; reference: string; city: string; matches: number }[]> {
  const orders = db
    .prepare(
      `SELECT o.* FROM orders o JOIN darb_shipments d ON d.id = o.darb_id
       WHERE (o.status = 'cancelled' OR d.status = 'returning') AND d.status NOT IN ('completed', 'released', 'returned', 'cancelled')`,
    )
    .all() as OrderRow[];
  if (!orders.length) return [];
  const zones = await darbZones();
  return orders.flatMap((o) => {
    const shipment = source(o);
    if (!shipment) return [];
    const n = matchesFor(o, shipment, zones).length;
    return n ? [{ orderId: o.id, reference: shipment.reference, city: shipment.city, matches: n }] : [];
  });
}

export type RedirectInput = { area: string; notes: string; total: number; payment: Payment };

export async function redirectShipment(fromId: number, toId: number, input: RedirectInput) {
  const from = loadOrder(fromId);
  const fresh = from?.darb_id ? await fetchShipmentById(from.darb_id).catch(() => undefined) : undefined;
  const shipment = source(from, fresh ?? savedShipment(from?.darb_id ?? null));
  if (!from || !shipment) throw new Error("الشحنة ما عادت فيك تحولها (يمكن انسلمت أو رجعت أو انلغت عند درب)");
  const zones = await darbZones();
  const match = matchesFor(from, shipment, zones).find((m) => m.orderId === toId);
  const to = loadOrder(toId);
  if (!to || !match) throw new Error("الطلب التاني ما عاد بيناسب هالشحنة (تغيّر أو انبعت)");
  const phone = intlPhone(to.phone) ?? intlPhone(to.customer);
  if (!phone) throw new Error("رقم الزبون التاني مش صحيح");
  const pickedUp = !NOT_PICKED.has(shipment.status);
  if (!pickedUp && !input.area) throw new Error("اختار المنطقة");

  const contact = await contactId(phone, to.name);
  const items = JSON.parse(to.items) as OrderItem[];
  const place = { city: shipment.city, area: input.area || shipment.area, total: input.total, payment: input.payment };
  try {
    if (!pickedUp) {
      const note = courierNote({ ...place, notes: input.notes });
      await darb("PATCH", `/api/local/shipments/${shipment.id}`, {
        contacts: [contact],
        to: destination({ ...place, notes: input.notes }),
        notes: note,
        products: products(items, charge({ ...place, notes: "" }).collect),
        paymentBy: charge({ ...place, notes: "" }).paymentBy,
      });
    } else {
      // On its way: the area can't change, so the courier reads it in the note.
      const note = courierNote({ ...place, notes: [`المستلم الجديد: ${to.name} ${phone}`, input.area && `المنطقة: ${input.area}`, input.notes].filter(Boolean).join("\n") });
      const current = await darb<{ results?: { products?: { _id: string }[] }[] }>("GET", `/api/local/shipments/${shipment.id}`);
      const productIds = current.results?.[0]?.products?.map((p) => p._id) ?? [];
      const each = productIds.length ? Math.round((charge({ ...place, notes: "" }).collect / productIds.length) * 100) / 100 : 0;
      await darb("PATCH", `/api/local/shipments/modify/${shipment.id}`, {
        contacts: [contact],
        notes: note,
        ...(productIds.length ? { products: productIds.map((_id) => ({ _id, amount: each, isChargeable: true })) } : {}),
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`درب ما قبل التعديل، اتصلو فيهن ليعدّلوها: ${message}`);
  }

  // Their own shipment, not picked up yet, isn't needed anymore.
  const own = savedShipment(to.darb_id);
  let ownCancelled = "";
  if (own && own.id !== shipment.id) {
    try {
      await darb("DELETE", `/api/local/shipments/${own.id}?cancellationCause=${encodeURIComponent(`انحولتلو شحنة طلب #${fromId}`)}`);
      ownCancelled = own.reference;
    } catch (error) {
      log("darb", `redirect: couldn't cancel ${own.reference}: ${error instanceof Error ? error.message : error}`);
      notify("order", `⚠️ ما قدرت الغي شحنة طلب #${toId} (<code>${esc(own.reference)}</code>) بعد التحويل، الغوها من تطبيق درب.`);
    }
  }

  const now = Date.now();
  db.exec("BEGIN");
  try {
    db.prepare("UPDATE orders SET darb_id = ?, darb_ref = ?, darb_status = ?, darb_at = ?, status = 'confirmed', updated_at = ? WHERE id = ?").run(
      shipment.id,
      shipment.reference,
      shipment.status,
      now,
      now,
      toId,
    );
    db.prepare("UPDATE orders SET darb_id = NULL, darb_ref = NULL, darb_status = NULL, notes = TRIM(notes || ?), updated_at = ? WHERE id = ?").run(
      `\nشحنتو (${shipment.reference}) انحولت لطلب #${toId}`,
      now,
      fromId,
    );
    db.prepare("INSERT INTO darb_redirects (from_order, to_order, shipment_id, picked_up, created_at) VALUES (?, ?, ?, ?, ?)").run(
      fromId,
      toId,
      shipment.id,
      pickedUp ? 1 : 0,
      now,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  forgetNotices(shipment.id);
  log("darb", `shipment ${shipment.reference} of order #${fromId} redirected to order #${toId}${pickedUp ? " (on its way)" : ""}`);
  notify(
    "order",
    `↪️ <b>شحنة طلب #${fromId} انحولت لطلب #${toId}</b>: ${esc(to.name)} · ${esc(shipment.city)} · <code>${esc(shipment.reference)}</code>` +
      (ownCancelled ? `\nوشحنة الطلب #${toId} القديمة (<code>${esc(ownCancelled)}</code>) انلغت` : ""),
  );
  void syncDarb().catch(() => {});
  return { ok: true, pickedUp, ownCancelled };
}

// Telegram, when a cancelled or refused shipment has someone in the same city who could take it.
export async function tellRedirectChance(orderId: number) {
  const order = loadOrder(orderId);
  const shipment = source(order);
  if (!order || !shipment) return;
  const matches = matchesFor(order, shipment, await darbZones());
  if (!matches.length) return;
  const item = (JSON.parse(order.items) as OrderItem[]).map((i) => `${i.color} ${i.size}`).join("، ");
  const link = config.publicUrl ? `\n<a href="${config.publicUrl}/dashboard/orders">افتح الطلبات</a>` : "";
  notify(
    "order",
    `↪️ <b>في طلب متلو بنفس المدينة</b>: شحنة طلب #${orderId} (${esc(item)}، ${esc(shipment.city)}) فيك تحولها لـ ` +
      `${matches.map((m) => `طلب #${m.orderId}`).join(" أو ")} بدل ما ترجع${link}`,
  );
}

// A shipment the customer refused at the door (Darb sends it back): maybe someone else in that city wants it.
onShipmentStatus((row) => {
  if (row.status !== "returning") return;
  const order = db.prepare("SELECT id FROM orders WHERE darb_id = ?").get(row.id) as { id: number } | undefined;
  if (order) void tellRedirectChance(order.id).catch(() => {});
});
