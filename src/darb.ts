// Darb Assabil (درب السبيل), our courier: a confirmed order becomes a shipment from the dashboard, the way the team
// used to enter it by hand in their app (same service, product titles, free box, delivery paid from the sales).
import { config } from "./config.js";
import { db, setOrderStatus, type OrderItem, type OrderStatus } from "./store.js";
import { log } from "./scheduler.js";

const MALE_DELIVERY = "6783c612dcf305c9e775c987"; // "توصيل رجالي", the account's default service
const FREE_BOX = { _id: "68dfb479abb897cb692c39b0", title: "حجم مجاني 2", widthCM: 10, heightCM: 10, lengthCM: 90, amount: 0, currency: "lyd" };
const DEFAULT_PRODUCT = "الثوب العربي متكون من ثلاث قطع";

type DarbResponse<T> = { status: boolean; data?: T; messages?: { message?: string; location?: string }[] };

async function darb<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (!config.darb.enabled) throw new Error("درب السبيل مش مربوط (DARB_API_KEY و DARB_ACCOUNT_ID)");
  const res = await fetch(`${config.darb.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `apikey ${config.darb.apiKey}`,
      "X-API-VERSION": "1.0.0",
      "X-ACCOUNT-ID": config.darb.accountId,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = (await res.json().catch(() => ({ status: false, messages: [{ message: `HTTP ${res.status}` }] }))) as DarbResponse<T>;
  if (!json.status || json.data === undefined) {
    const why = json.messages?.map((m) => [m.message, m.location].filter(Boolean).join(" @ ")).join("; ") || `HTTP ${res.status}`;
    throw new Error(`درب السبيل: ${why}`);
  }
  return json.data;
}

// --- Cities and areas ---------------------------------------------------------------------------------

export type Zone = { city: string; areas: string[] };
let zoneCache: { at: number; zones: Zone[] } | undefined;

// Where Darb Assabil delivers: each city with its areas (from their branches), refreshed twice a day.
export async function darbZones(): Promise<Zone[]> {
  if (zoneCache && Date.now() - zoneCache.at < 12 * 60 * 60 * 1000) return zoneCache.zones;
  const data = await darb<{ results: { city: string; area: string; areas?: { area: string }[] }[] }>(
    "GET",
    `/api/local/branches/public?offset=0&limit=500&project=${encodeURIComponent(JSON.stringify({ "areas.geoFeature": 0 }))}`,
  );
  const byCity = new Map<string, Set<string>>();
  for (const b of data.results) {
    const areas = byCity.get(b.city) ?? new Set<string>();
    for (const a of [b.area, ...(b.areas ?? []).map((x) => x.area)]) if (a?.trim() && !a.includes("استلام من المكتب")) areas.add(a.trim());
    byCity.set(b.city, areas);
  }
  const zones = [...byCity].map(([city, areas]) => ({ city, areas: [...areas].sort((a, b) => a.localeCompare(b, "ar")) }));
  zones.sort((a, b) => b.areas.length - a.areas.length);
  zoneCache = { at: Date.now(), zones };
  return zones;
}

const norm = (s: string) =>
  s
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/^ال/, "")
    .replace(/\s+ال/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();

// The order's city / address as a Darb city + area: an area named like the order's city wins (جنزور → طرابلس / جنزور),
// then the city itself (area = the city's own area when it has one), then any area named in the address.
export function guessZone(zones: Zone[], city: string, address: string): { city: string; area: string } | undefined {
  const c = norm(city);
  const words = norm(address);
  // The longest area of `among` named in the address.
  const inAddress = (among: Zone[]) => {
    let best: { city: string; area: string; len: number } | undefined;
    for (const z of among)
      for (const a of z.areas) {
        const n = norm(a);
        if (n.length >= 3 && n !== norm(z.city) && words.includes(n) && (!best || n.length > best.len)) best = { city: z.city, area: a, len: n.length };
      }
    return best && { city: best.city, area: best.area };
  };
  if (c) {
    for (const z of zones) for (const a of z.areas) if (norm(a) === c && norm(z.city) !== c) return { city: z.city, area: a };
    const zone = zones.find((z) => norm(z.city) === c);
    if (zone) return (words && inAddress([zone])) || { city: zone.city, area: zone.areas.find((a) => norm(a) === c) ?? "" };
  }
  return words ? inAddress(zones) : undefined;
}

// --- Shipments ----------------------------------------------------------------------------------------

type OrderRow = {
  id: number;
  customer: string;
  name: string;
  phone: string;
  city: string;
  address: string;
  items: string;
  total: string;
  notes: string;
  status: OrderStatus;
  darb_ref: string | null;
};

const loadOrder = (id: number) => db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;

// "0912345678" / "218912345678" / "+218 91 234 5678" → "+218912345678"
export function intlPhone(phone: string): string | undefined {
  const d = phone
    .replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x0660))
    .replace(/\D/g, "")
    .replace(/^00/, "");
  if (/^0?9\d{8}$/.test(d)) return `+218${d.replace(/^0/, "")}`;
  if (/^[1-9]\d{6,14}$/.test(d)) return `+${d}`;
  return undefined;
}

// "385 دينار" → 385
function amount(total: string): number | undefined {
  const m = total.replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x0660)).replace(/[,٬]/g, "").match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

export type ShipmentInput = { city: string; area: string; notes: string; total: number };

// What the dashboard shows before sending: the guessed place, the product lines and the amount to collect.
export async function shipmentPreview(orderId: number) {
  const order = loadOrder(orderId);
  if (!order) throw new Error("Unknown order");
  const zones = await darbZones();
  const items = JSON.parse(order.items) as OrderItem[];
  return {
    zones,
    guess: guessZone(zones, order.city, order.address),
    notes: [order.address, order.notes].filter((s) => s.trim()).join("\n"),
    total: amount(order.total) ?? 0,
    phone: intlPhone(order.phone) ?? intlPhone(order.customer) ?? "",
    lines: items.map((i) => ({ title: productTitle(i), quantity: i.quantity })),
    darbRef: order.darb_ref,
  };
}

function productTitle(i: OrderItem): string {
  return [i.product?.trim() || DEFAULT_PRODUCT, i.size && `المقاس ${i.size}`, i.color && `اللون ${i.color}`].filter(Boolean).join(" ").slice(0, 100);
}

// One product line per item; the amount to collect is split over the pieces (Darb's amount is per piece).
function products(items: OrderItem[], total: number) {
  const pieces = items.reduce((n, i) => n + i.quantity, 0) || 1;
  const perPiece = Math.round((total / pieces) * 100) / 100;
  return items.map((i) => ({
    title: productTitle(i),
    quantity: i.quantity,
    widthCM: 10,
    heightCM: 10,
    lengthCM: 10,
    allowInspection: true, // the customer tries it on while the courier is there
    allowTesting: true,
    isFragile: false,
    amount: perPiece,
    currency: "lyd",
    isChargeable: true,
    box: FREE_BOX,
  }));
}

function destination(input: ShipmentInput) {
  return { countryCode: "lby", city: input.city, area: input.area || input.city, address: "" };
}

// Darb's own price for this delivery (taken from the sales when it's paid by "sales").
export async function shipmentQuote(orderId: number, input: ShipmentInput): Promise<{ shipping: number; charges: number }> {
  const order = loadOrder(orderId);
  if (!order) throw new Error("Unknown order");
  const data = await darb<{ invoices: { items: { type: string; amount: number }[] }[] }>("POST", "/api/local/shipments/calculate/shipping", {
    service: MALE_DELIVERY,
    products: products(JSON.parse(order.items) as OrderItem[], input.total),
    paymentBy: "sales",
    to: destination(input),
  });
  const items = data.invoices.flatMap((inv) => inv.items);
  const sum = (type: string) => items.filter((i) => i.type === type).reduce((n, i) => n + i.amount, 0);
  return { shipping: sum("shipping"), charges: sum("charge") };
}

// The customer as a Darb contact (with their name on our account). Darb contacts are shared between shops:
// when the number already exists there, its id comes from the trust score lookup.
async function contactId(phone: string, name: string): Promise<string> {
  try {
    return (await darb<{ _id: string }>("POST", "/api/contacts", { name: name.trim().slice(0, 100) || "زبون", phone }))._id;
  } catch (error) {
    const found = await darb<{ contact?: { _id: string } }>("GET", `/api/contacts/trust/score?phone=${encodeURIComponent(phone)}`).catch(() => undefined);
    if (found?.contact?._id) return found.contact._id;
    throw error;
  }
}

// Creates the shipment, saves its reference on the order and marks a new order confirmed.
export async function sendToDarb(orderId: number, input: ShipmentInput): Promise<{ id: string; reference: string; status: string }> {
  const order = loadOrder(orderId);
  if (!order) throw new Error("Unknown order");
  if (order.darb_ref) throw new Error(`الطلب مبعوت من قبل لدرب السبيل (#${order.darb_ref})`);
  if (order.status === "cancelled") throw new Error("الطلب ملغي");
  if (!input.city) throw new Error("اختار المدينة");
  if (!(input.total > 0)) throw new Error("المبلغ لازم يكون أكبر من صفر");
  const phone = intlPhone(order.phone) ?? intlPhone(order.customer);
  if (!phone) throw new Error("رقم الزبون مش صحيح");

  const contact = await contactId(phone, order.name);
  const shipment = await darb<{ _id: string; reference: string; status: string }>("POST", "/api/local/shipments", {
    service: MALE_DELIVERY,
    notes: input.notes.slice(0, 1000),
    contacts: [contact],
    products: products(JSON.parse(order.items) as OrderItem[], input.total),
    allowSplitting: false,
    paymentBy: "sales",
    to: destination(input),
    tags: [order.name.trim(), `#${order.id}`].filter(Boolean),
  });
  db.prepare("UPDATE orders SET darb_id = ?, darb_ref = ?, darb_status = ?, darb_at = ?, updated_at = ? WHERE id = ?").run(
    shipment._id,
    shipment.reference,
    shipment.status ?? "pending",
    Date.now(),
    Date.now(),
    orderId,
  );
  if (order.status === "new") setOrderStatus(orderId, "confirmed");
  log("darb", `order #${orderId} sent to Darb Assabil: shipment ${shipment.reference} (${input.city} / ${input.area})`);
  return { id: shipment._id, reference: shipment.reference, status: shipment.status };
}
