// Order tracking updates to the customer: when their shipment leaves with Darb Assabil, reaches the Darb office in
// their city (the courier calls next), and is delivered. Our own wording from the status, never Darb's event text.
// Free-form WhatsApp messages are only allowed within 24 hours of the customer's last message, so an update waits
// (pending) until the customer is inside that window, the AI may write to them and it's working hours; it's dropped
// once a later stage comes or after 3 days. Delays and returns go to the team instead (darbTrack.ts, tell()).
import { onDarbSynced } from "./darbTrack.js";
import { db, getSetting, isAiPaused, setSetting } from "./store.js";
import { aiBlockedReason } from "./settings.js";
import { inWorkingHours } from "./supervisor.js";
import { log } from "./scheduler.js";
import { notifyError } from "./telegram.js";
import { sendNotice } from "./channels/whatsapp.js";
import "./followup.js"; // its followups table: an update stops a follow-up on the same customer message

const HOUR = 60 * 60 * 1000;
const WINDOW = 23 * HOUR;
const GIVE_UP = 3 * 24 * HOUR;

db.exec(`
  -- One row per shipment and stage: sent, waiting for the customer's window (pending) or not sent (skipped).
  CREATE TABLE IF NOT EXISTS tracking_notices (
    shipment_id TEXT    NOT NULL,
    stage       TEXT    NOT NULL,  -- sent | in_city | delivered
    state       TEXT    NOT NULL,  -- sent | pending | skipped
    reason      TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (shipment_id, stage)
  );
`);

export type Stage = "sent" | "in_city" | "delivered";
const ORDER: Stage[] = ["sent", "in_city", "delivered"];

// The furthest stage a shipment is at; none for cancelled or returned shipments.
// in_city: at Darb's office in the customer's city, or the courier (or office) who delivers it took it ("accepted"):
// most shipments go from "processing" straight to the courier, never "on-branch".
function stageOf(s: Pick<Candidate, "status" | "accepted_at" | "courier_phone" | "office_phone">): Stage | undefined {
  const status = s.status;
  if (status === "completed") return "delivered";
  // "released": the goods of a cancelled order were handed back to us.
  if (["cancelled", "returning", "returned", "released"].includes(status)) return undefined;
  if (status === "on-branch") return "in_city";
  if (s.accepted_at && (s.courier_phone || s.office_phone)) return "in_city";
  return "sent";
}

type NoticeInfo = { number: string; city: string; courier?: string; phone?: string; office?: boolean };

// The courier or office who has it now, for the customer: name and a local number (0…).
function courierOf(s: Candidate): Pick<NoticeInfo, "courier" | "phone" | "office"> {
  const phone = s.courier_phone ?? s.office_phone;
  if (!s.accepted_at || !phone) return {};
  const name = (phone === s.courier_phone ? s.courier_name : s.office_name)?.trim() ?? "";
  const office = phone === s.office_phone || name.startsWith("مكتب");
  return { courier: name, phone: phone.replace(/^\+?218/, "0"), office };
}

// When we know who delivers it: who, his number and the shipment's number now (Darb's branch gives it a new one).
const COURIER_TEXTS: ((s: NoticeInfo) => string)[] = [
  (s) =>
    `طلبك توا عند ${s.office ? "" : "مندوب "}درب السبيل${s.courier ? ` ${s.courier}` : ""} 🚚 وهو اللي بيوصّلهولك إن شاء الله.\nرقمه: ${s.phone}\nرقم شحنتك: ${s.number}\nخلي تليفونك مفتوح، وكان ما كلمكش تقدر تكلمه انت.`,
  (s) =>
    `خبر باهي 🌟 طلبك ${s.office ? "وصل" : "صار مع"} ${s.office ? "" : "مندوب "}درب السبيل${s.courier ? ` ${s.courier}` : ""}، وقريب يوصلك إن شاء الله.\nرقمه: ${s.phone}\nرقم الشحنة: ${s.number}\nلو تبي تتفق معاه على الوقت أو المكان كلمه مباشرة.`,
  (s) =>
    `طلبك في الطريق ليك 📦 اللي بيوصّله ${s.office ? "" : "مندوب "}درب السبيل${s.courier ? ` ${s.courier}` : ""}.\nرقمه: ${s.phone}\nرقم الشحنة: ${s.number}\nالله يخليك رد عليه لما يتصل، وكان تأخر عليك كلمه انت.`,
];

// 3 wordings per stage, the same one for a customer every time (from their number).
const TEXTS: Record<Stage, ((s: NoticeInfo) => string)[]> = {
  sent: [
    (s) => `طلبك طلع مع درب السبيل 🚚 رقم الشحنة ${s.number}. التوصيل عادة من يومين لـ 3 أيام إن شاء الله، والمندوب بيتصل فيك قبل ما يوصل.`,
    (s) => `بشرى حلوة 🌟 طلبك انبعت مع درب السبيل، ورقم الشحنة ${s.number}. خلال يومين لـ 3 أيام إن شاء الله بيوصلك، والمندوب بيكلمك قبل.`,
    (s) => `جهّزنا طلبك وطلع مع درب السبيل 📦 رقم الشحنة ${s.number}. عادة بياخد من يومين لـ 3 أيام إن شاء الله، والمندوب بيتصل فيك قبل التسليم.`,
  ],
  in_city: [
    (s) => `وصل طلبك لمكتب درب السبيل في ${s.city} 📦 المندوب رح يتصل فيك قريب إن شاء الله، خلّي تلفونك مفتوح.`,
    (s) => `طلبك صار في ${s.city} عند درب السبيل 🚚 المندوب بيكلمك قريب إن شاء الله، الله يخليك ردّ عليه.`,
    (s) => `خبر حلو، طلبك وصل ${s.city} 🌟 مندوب درب السبيل رح يتصل فيك قريب، خلّي تلفونك قريب منك.`,
  ],
  delivered: [
    () => `إن شاء الله وصلك طلبك بخير 🌟 شكراً لثقتك فينا، وإذا عندك أي ملاحظة احكينا.`,
    () => `مبروك عليك، يلبسك العافية 🌟 شكراً إنك اخترتنا، وأي ملاحظة إحنا بالخدمة.`,
    () => `الحمد لله وصلك الطلب 🙏 نتمنى يعجبك، وإذا في أي شي احكينا.`,
  ],
};

function wording(customer: string): number {
  let sum = 0;
  for (const ch of customer) sum += ch.charCodeAt(0);
  return sum % 3;
}

export function noticeText(stage: Stage, customer: string, s: NoticeInfo) {
  if (stage === "in_city" && s.phone) return COURIER_TEXTS[wording(customer)]!(s);
  return TEXTS[stage][wording(customer)]!(s);
}

// --- Settings ----------------------------------------------------------------

export type TrackingSettings = { enabled: boolean };

export function trackingSettings(): TrackingSettings {
  try {
    return { enabled: true, ...(JSON.parse(getSetting("tracking_notices") ?? "{}") as Partial<TrackingSettings>) };
  } catch {
    return { enabled: true };
  }
}

export function saveTrackingSettings(patch: Record<string, unknown>): TrackingSettings {
  const next = trackingSettings();
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  setSetting("tracking_notices", JSON.stringify(next));
  return next;
}

export function trackingStats(days: number) {
  const rows = db
    .prepare("SELECT state, COUNT(*) AS n FROM tracking_notices WHERE updated_at > ? AND reason != 'before tracking updates' GROUP BY state")
    .all(Date.now() - days * 24 * HOUR) as { state: string; n: number }[];
  const n = (state: string) => rows.find((r) => r.state === state)?.n ?? 0;
  return { days, sent: n("sent"), pending: n("pending"), skipped: n("skipped") };
}

// --- Sending -------------------------------------------------------------------

type Candidate = {
  id: string;
  status: string;
  reference: string;
  sh: string | null;
  city: string;
  customer: string;
  orderId: number;
  courier_name: string | null;
  courier_phone: string | null;
  office_name: string | null;
  office_phone: string | null;
  accepted_at: number | null;
};

const linkedShipments = (orderId?: number) =>
  db
    .prepare(
      `SELECT d.id, d.status, d.reference, d.sh, d.city, o.customer, o.id AS orderId,
              d.courier_name, d.courier_phone, d.office_name, d.office_phone, d.accepted_at
       FROM darb_shipments d JOIN orders o ON o.darb_id = d.id
       WHERE o.status != 'cancelled' ${orderId ? "AND o.id = ?" : ""}`,
    )
    .all(...(orderId ? [orderId] : [])) as Candidate[];

const getNotice = db.prepare("SELECT state, created_at FROM tracking_notices WHERE shipment_id = ? AND stage = ?");
const putNotice = db.prepare(
  `INSERT INTO tracking_notices (shipment_id, stage, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT (shipment_id, stage) DO UPDATE SET state = excluded.state, reason = excluded.reason, updated_at = excluded.updated_at`,
);
const mark = (id: string, stage: Stage, state: string, reason: string) => putNotice.run(id, stage, state, reason, Date.now(), Date.now());

// Every shipment already there when updates start (or when the team turns them on) counts as told, so nobody gets
// old news at once.
function seed() {
  if (getSetting("tracking_seeded")) return;
  db.exec("BEGIN");
  try {
    for (const s of linkedShipments()) {
      const stage = stageOf(s);
      if (!stage) continue;
      for (const st of ORDER.slice(0, ORDER.indexOf(stage) + 1)) {
        if (!getNotice.get(s.id, st)) mark(s.id, st, "skipped", "before tracking updates");
      }
    }
    setSetting("tracking_seeded", String(Date.now()));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// Why we can't write to this customer now (an update then waits), or nothing.
function blocked(customer: string): string | undefined {
  if (/^(fb|ig|cw):/.test(customer)) return "not a WhatsApp chat";
  const blockedBy = aiBlockedReason(customer);
  if (blockedBy) return blockedBy;
  if (isAiPaused(customer)) return "the team is handling this chat";
  const last = db
    .prepare("SELECT MAX(created_at) AS at FROM messages WHERE customer = ? AND role = 'customer' AND history = 0")
    .get(customer) as { at: number | null };
  if (!last.at || last.at < Date.now() - WINDOW) return "outside WhatsApp's 24-hour window";
  if (!inWorkingHours(Date.now())) return "outside working hours";
  return undefined;
}

let running = false;

// orderId: only that order's shipment (right after it's sent to Darb).
export async function notifyCustomers(orderId?: number): Promise<number> {
  if (!trackingSettings().enabled || running) return 0;
  running = true;
  let sent = 0;
  try {
    seed();
    for (const s of linkedShipments(orderId)) {
      const stage = stageOf(s);
      if (!stage) continue;
      // Earlier stages not told yet are passed: only the latest news goes out.
      for (const st of ORDER.slice(0, ORDER.indexOf(stage))) {
        const n = getNotice.get(s.id, st) as { state: string } | undefined;
        if (!n || n.state === "pending") mark(s.id, st, "skipped", "a later stage came first");
      }
      const notice = getNotice.get(s.id, stage) as { state: string; created_at: number } | undefined;
      if (notice && notice.state !== "pending") continue;
      if (notice && notice.created_at < Date.now() - GIVE_UP) {
        mark(s.id, stage, "skipped", "the customer didn't write within 3 days");
        continue;
      }
      const why = blocked(s.customer);
      if (why) {
        if (!notice) putNotice.run(s.id, stage, "pending", why, Date.now(), Date.now());
        else mark(s.id, stage, "pending", why);
        continue;
      }
      // Claim it first, so a crash or a second sync never sends it twice.
      mark(s.id, stage, "sent", "");
      // The courier's update gives the number the shipment has now (the branch's); the first one gives SH.
      const text = noticeText(stage, s.customer, { number: stage === "in_city" ? s.reference : (s.sh ?? s.reference), city: s.city, ...courierOf(s) });
      try {
        await sendNotice(s.customer, text);
        sent++;
        log(`wa:${s.customer}`, `tracking update sent (${stage}) for order #${s.orderId}`);
        // No automatic follow-up after our update (it answers nothing the customer said).
        const lastId = db
          .prepare("SELECT MAX(id) AS id FROM messages WHERE customer = ? AND role = 'customer' AND history = 0")
          .get(s.customer) as { id: number | null };
        if (lastId.id) {
          db.prepare("INSERT OR IGNORE INTO followups (customer, after_id, sent, text, created_at) VALUES (?, ?, 0, ?, ?)").run(
            s.customer,
            lastId.id,
            "tracking update",
            Date.now(),
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        mark(s.id, stage, "skipped", `send failed: ${message.slice(0, 200)}`);
        log(`wa:${s.customer}`, `tracking update failed: ${message}`);
        notifyError("تحديث تتبع الطلب", `طلب #${s.orderId}: ${message}`);
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

onDarbSynced(() => notifyCustomers());

// An order linked to a shipment sent before: what already happened isn't news, so its stages count as told.
export function markTold(orderId: number) {
  for (const s of linkedShipments(orderId)) {
    const stage = stageOf(s);
    if (!stage) continue;
    for (const st of ORDER.slice(0, ORDER.indexOf(stage) + 1)) {
      if (!getNotice.get(s.id, st)) mark(s.id, st, "skipped", "before tracking updates");
    }
  }
}

// A shipment sent again (resendToDarb): what the customer was told about the old one counts for the new one.
export function carryNotices(fromId: string, toId: string) {
  const rows = db.prepare("SELECT stage FROM tracking_notices WHERE shipment_id = ?").all(fromId) as { stage: Stage }[];
  for (const r of rows) if (!getNotice.get(toId, r.stage)) mark(toId, r.stage, "skipped", "resent shipment: told before");
}

// A shipment that changed customer (src/darbRedirect.ts): the new customer hasn't been told anything yet.
export function forgetNotices(shipmentId: string) {
  db.prepare("DELETE FROM tracking_notices WHERE shipment_id = ?").run(shipmentId);
}
