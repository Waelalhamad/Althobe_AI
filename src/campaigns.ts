// Campaigns: a WhatsApp message template approved by Meta, sent to a group of past customers,
// outside WhatsApp's 24-hour window. Only templates can be sent there.
// In Nov 2026 the number was YELLOW with "customers were blocking your phone number", and every sale runs on it, so:
// small daily caps, working hours only, a send at a time, never twice the same campaign to anyone, a customer who asks
// to stop is never sent another, and a run stops by itself when the number's quality drops or many sends fail.
// Sent from here, not through the AI's reply path: a refused send is recorded and skipped, never pausing the chat.
import { config } from "./config.js";
import { contactName, db, saveMessage } from "./store.js";
import { isBlacklisted } from "./blacklist.js";
import { buildTemplatePayload, validateTemplateName } from "./campaignTemplate.js";
import { asksForDiscount, customerWords, handoffIsComplaint, handoffIsDiscount, toldNoBiggerSize, tooBigFor62 } from "./campaignSignals.js";
import { customerLine, onCustomerTexts, onMessageStatuses, type MessageStatus } from "./channels/whatsapp.js";
import { isMetaCustomer } from "./channels/meta.js";
import { inWorkingHours } from "./supervisor.js";
import { log } from "./scheduler.js";
import { notify, esc } from "./telegram.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS campaigns (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    template    TEXT    NOT NULL,          -- the template's name at Meta
    language    TEXT    NOT NULL,          -- its language code, e.g. "ar"
    segment     TEXT    NOT NULL,          -- see SEGMENTS
    days        INTEGER NOT NULL,          -- customers who wrote in the last N days
    body        TEXT    NOT NULL,          -- the text as the customer sees it (saved in their chat for the AI)
    image       TEXT,                      -- header photo link, for a template with an image header
    daily_cap   INTEGER NOT NULL,
    status      TEXT    NOT NULL,          -- 'running' | 'paused' | 'done' | 'stopped'
    note        TEXT    NOT NULL DEFAULT '', -- why it stopped or paused by itself
    created_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS campaign_recipients (
    campaign    INTEGER NOT NULL,
    customer    TEXT    NOT NULL,
    status      TEXT    NOT NULL,          -- 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'
    attempts    INTEGER NOT NULL DEFAULT 0, -- passing failures (Meta/Dualhook down): moved on after a few
    wamid       TEXT,
    error       TEXT    NOT NULL DEFAULT '',
    sent_at     INTEGER,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (campaign, customer)
  );
  CREATE INDEX IF NOT EXISTS campaign_recipients_wamid ON campaign_recipients (wamid);
  CREATE TABLE IF NOT EXISTS campaign_optouts (
    customer    TEXT PRIMARY KEY,
    reason      TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
`);

// --- Templates (from Meta, through Dualhook) ------------------------------------------

type Component = {
  type: string; // HEADER | BODY | FOOTER | BUTTONS
  format?: string; // HEADER: TEXT | IMAGE | VIDEO | DOCUMENT
  text?: string;
  buttons?: { type: string; text?: string; url?: string }[];
};
export type Template = {
  name: string;
  status: string;
  category: string;
  language: string;
  rejected_reason?: string;
  components: Component[];
  body: string;
  imageHeader: boolean;
  // Why we can't send it (variables other than the name, a video header…); empty when it can be sent.
  unsupported: string;
};

const headers = () => ({ Authorization: `Bearer ${config.whatsapp.dualhook.apiKey}` });

let wabaId: string | undefined;
async function waba(): Promise<string> {
  if (process.env.WA_WABA_ID?.trim()) return process.env.WA_WABA_ID.trim();
  if (wabaId) return wabaId;
  const info = await numberInfo();
  const id = info.health_status?.entities?.find((e) => e.entity_type === "WABA")?.id;
  if (!id) throw new Error("WhatsApp Business Account id not found (set WA_WABA_ID)");
  return (wabaId = id);
}

type NumberInfo = {
  quality_rating?: string;
  whatsapp_business_manager_messaging_limit?: string;
  health_status?: { can_send_message?: string; entities?: { entity_type: string; id: string; additional_info?: string[] }[] };
};

async function numberInfo(): Promise<NumberInfo> {
  const res = await fetch(`${config.whatsapp.dualhook.baseUrl}/${config.whatsapp.phoneNumberId}`, { headers: headers() });
  if (!res.ok) throw new Error(`number info: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as NumberInfo;
}

// The number's health as Meta reports it (shown on the page, checked during a run).
export async function numberHealth() {
  const info = await numberInfo();
  const phone = info.health_status?.entities?.find((e) => e.entity_type === "PHONE_NUMBER");
  return {
    quality: info.quality_rating ?? "UNKNOWN", // GREEN | YELLOW | RED
    limit: info.whatsapp_business_manager_messaging_limit ?? "",
    canSend: info.health_status?.can_send_message ?? "",
    notes: phone?.additional_info ?? [],
  };
}

// The body's variables: only {{1}} (the customer's first name) is filled in.
function unsupportedReason(components: Component[]): string {
  const header = components.find((c) => c.type === "HEADER");
  if (header && header.format && !["TEXT", "IMAGE"].includes(header.format)) return `رأس الرسالة ${header.format} (مدعوم: نص أو صورة)`;
  if (header?.format === "TEXT" && /\{\{/.test(header.text ?? "")) return "في متغيّر برأس الرسالة";
  const vars = [...(components.find((c) => c.type === "BODY")?.text ?? "").matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
  if (vars.some((v) => v !== "1")) return "فيها متغيّرات غير {{1}} (اسم الزبون)";
  const buttons = components.find((c) => c.type === "BUTTONS")?.buttons ?? [];
  if (buttons.some((b) => b.type === "URL" && /\{\{/.test(b.url ?? ""))) return "فيها زر رابط متغيّر";
  return "";
}

export async function listTemplates(): Promise<Template[]> {
  const url = `${config.whatsapp.dualhook.baseUrl}/${await waba()}/message_templates?limit=100&fields=name,status,category,language,components,rejected_reason`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`templates: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { data?: Omit<Template, "body" | "imageHeader" | "unsupported">[] };
  return (data.data ?? []).map((t) => ({
    ...t,
    body: t.components.find((c) => c.type === "BODY")?.text ?? "",
    imageHeader: t.components.some((c) => c.type === "HEADER" && c.format === "IMAGE"),
    unsupported: unsupportedReason(t.components),
  }));
}

type TemplatePayload = ReturnType<typeof buildTemplatePayload>;
type CreatedTemplate = { id: string; status: string };

function writeTemplate(method: "POST", query: string, body: TemplatePayload): Promise<CreatedTemplate>;
function writeTemplate(method: "DELETE", query: string): Promise<void>;
async function writeTemplate(method: "POST" | "DELETE", query: string, body?: TemplatePayload): Promise<CreatedTemplate | void> {
  const failure = method === "POST" ? "ما قدرنا نبعت القالب لميتا" : "ما قدرنا نحذف القالب من ميتا";
  try {
    const url = `${config.whatsapp.dualhook.baseUrl}/${await waba()}/message_templates${query}`;
    const res = await fetch(url, {
      method,
      headers: { ...headers(), ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body && JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as {
      id?: string;
      status?: string;
      success?: boolean;
      error?: { error_user_msg?: string; message?: string };
    } | null;
    if (!res.ok || data?.error) throw new Error(data?.error?.error_user_msg || data?.error?.message || `HTTP ${res.status}`);
    if (method === "POST" && data?.id && data.status) return { id: data.id, status: data.status };
    if (method === "DELETE" && data?.success === true) return;
    throw new Error("رد ميتا ناقص");
  } catch (error) {
    throw new Error(`${failure}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function createTemplate(input: unknown) {
  return writeTemplate("POST", "", buildTemplatePayload(input));
}

// Don't let a campaign start while Meta is processing a deletion by name (across languages).
const deletingTemplates = new Set<string>();

export async function deleteTemplate(input: unknown) {
  const name = validateTemplateName(input);
  if (deletingTemplates.has(name)) throw new Error("القالب عم ينحذف، جرّب بعد شوي");
  if (db.prepare("SELECT 1 FROM campaigns WHERE template = ? AND status = 'running' LIMIT 1").get(name)) {
    throw new Error("ما فيك تحذف قالب عم تستخدمه حملة شغالة. وقّف الحملة بالأول.");
  }
  deletingTemplates.add(name);
  try {
    await writeTemplate("DELETE", `?name=${encodeURIComponent(name)}`);
  } finally {
    deletingTemplates.delete(name);
  }
}

// --- Who gets it ------------------------------------------------------------------------

export const SEGMENTS = {
  fur_no_order: "سألوا عن الفروة وما طلبوا",
  no_order: "كتبولنا وما طلبوا (أي منتج)",
  discount_no_order: "طلبوا خصم وما طلبوا (تنزيلات 20%)",
  size_too_big: "مقاسهم أكبر من 62 (وزن فوق 105 كغ أو سألوا عن 64) وما طلبوا",
  buyers: "اشتروا منا قبل (انسلم طلبهم)",
} as const;
export type Segment = keyof typeof SEGMENTS;

// "توقف", "إيقاف العروض", "stop"…: the customer doesn't want our messages (also Meta's opt-out button).
const OPT_OUT = /^\s*(stop|unsubscribe|توقف|اوقف|أوقف|ايقاف|إيقاف|الغاء الاشتراك|إلغاء الاشتراك|لا ترسل)/i;
const DAY = 24 * 60 * 60 * 1000;

// What the chats say about each customer, for the groups that depend on it: who asked for a discount, whose size we
// don't have, who had a complaint. One pass over the chats, kept until a message, a handoff or a pause is added.
type Signals = { discount: Map<string, string>; size: Map<string, string>; unhappy: Set<string> };
let signalsCache: { key: string; value: Signals } | undefined;
function chatSignals(): Signals {
  const key = JSON.stringify([
    db.prepare("SELECT MAX(id) AS m, COUNT(*) AS n FROM messages").get(),
    db.prepare("SELECT MAX(id) AS m FROM ai_calls").get(),
    db.prepare("SELECT COUNT(*) AS n, MAX(until) AS m FROM pauses").get(),
  ]);
  if (signalsCache?.key === key) return signalsCache.value;
  const value: Signals = { discount: new Map(), size: new Map(), unhappy: new Set() };
  // In order, with our last message to each customer: a bare «64» means a size after «كم مقاسك؟», a weight after «كم وزنك؟».
  const lastOurs = new Map<string, string>();
  for (const r of db.prepare("SELECT customer, role, text FROM messages ORDER BY id").iterate() as Iterable<{ customer: string; role: string; text: string }>) {
    if (r.role !== "customer") {
      lastOurs.set(r.customer, r.text);
      // Our own words: told there is no size above 62.
      if (!value.size.has(r.customer) && r.text.includes("62") && toldNoBiggerSize(r.text)) value.size.set(r.customer, "انقاله إنو أكبر مقاس عندنا 62");
      continue;
    }
    if (!value.discount.has(r.customer) && asksForDiscount(r.text)) value.discount.set(r.customer, "كتب: " + customerWords(r.text).slice(0, 60));
    if (!value.size.has(r.customer)) {
      const why = tooBigFor62(r.text, lastOurs.get(r.customer));
      if (why) value.size.set(r.customer, why);
    }
  }
  // A handoff written about a chat (the AI's reason, or the pause it left): a discount asked, or a complaint.
  const reasons = db
    .prepare(
      `SELECT customer, reason FROM ai_calls WHERE action = 'handoff' AND reason IS NOT NULL
       UNION ALL SELECT customer, reason FROM pauses WHERE reason LIKE 'AI handoff%'`,
    )
    .all() as { customer: string; reason: string }[];
  for (const r of reasons) {
    if (!value.discount.has(r.customer) && handoffIsDiscount(r.reason)) value.discount.set(r.customer, "تحويل للفريق بسبب خصم");
    if (handoffIsComplaint(r.reason)) value.unhappy.add(r.customer);
  }
  signalsCache = { key, value };
  return value;
}

const LIBYAN_MOBILE = /^2189\d{8}$/;

export type SegmentMember = { customer: string; last: number; why: string };

// The customers of a segment, with every exclusion applied. forAds: the list for a Facebook ad audience (no message
// is sent, so only who they are counts: not the exclusions that protect the number).
export function segmentMembers(segment: Segment, days: number, forAds = false): SegmentMember[] {
  const now = Date.now();
  const since = now - days * DAY;
  const rows = db
    .prepare(
      `SELECT customer, MAX(created_at) AS last FROM messages WHERE role = 'customer' GROUP BY customer HAVING last > ?`,
    )
    .all(since) as { customer: string; last: number }[];
  const ordered = new Set((db.prepare("SELECT DISTINCT customer FROM orders").all() as { customer: string }[]).map((r) => r.customer));
  const delivered = new Set(
    (db.prepare("SELECT DISTINCT customer FROM orders WHERE status = 'delivered'").all() as { customer: string }[]).map((r) => r.customer),
  );
  // An order still on its way: the customer hears about it from the team, not from an offer.
  const open = new Set(
    (db.prepare("SELECT DISTINCT customer FROM orders WHERE status IN ('new', 'confirmed')").all() as { customer: string }[]).map((r) => r.customer),
  );
  const fur =
    segment === "fur_no_order"
      ? new Set(
          (db.prepare("SELECT DISTINCT customer FROM messages WHERE text LIKE '%فرو%' OR text LIKE '%صقع%'").all() as { customer: string }[]).map(
            (r) => r.customer,
          ),
        )
      : undefined;
  const signals = chatSignals();
  const optedOut = new Set((db.prepare("SELECT customer FROM campaign_optouts").all() as { customer: string }[]).map((r) => r.customer));
  // Anyone sent a campaign in the last week: one at a time.
  const recent = new Set(
    (db.prepare("SELECT DISTINCT customer FROM campaign_recipients WHERE sent_at > ?").all(now - 7 * DAY) as { customer: string }[]).map(
      (r) => r.customer,
    ),
  );
  const paused = new Set((db.prepare("SELECT customer FROM pauses WHERE until > ?").all(now) as { customer: string }[]).map((r) => r.customer));
  const members: SegmentMember[] = [];
  for (const { customer, last } of rows) {
    if (!/^\d{9,15}$/.test(customer) || isMetaCustomer(customer) || customerLine(customer)) continue;
    // We deliver inside Libya only: a number from abroad can't use an offer (it still counts for an ad audience).
    if (!forAds && !LIBYAN_MOBILE.test(customer)) continue;
    if (isBlacklisted(customer) || optedOut.has(customer)) continue;
    if (!forAds) {
      // Wrote within the day: still in the 24-hour window, the AI talks with them.
      if (last > now - DAY || recent.has(customer) || paused.has(customer) || open.has(customer)) continue;
      // A complaint or a return in their chat: an offer would only get the number blocked.
      if (signals.unhappy.has(customer)) continue;
    }
    if (segment === "buyers") {
      if (delivered.has(customer)) members.push({ customer, last, why: "انسلم طلبه" });
    } else if (!ordered.has(customer)) {
      const why =
        segment === "no_order"
          ? "كتب وما طلب"
          : segment === "fur_no_order"
            ? fur!.has(customer) && "سأل عن الفروة"
            : (segment === "discount_no_order" ? signals.discount : signals.size).get(customer);
      if (why) members.push({ customer, last, why });
    }
  }
  return members;
}

export const segmentCustomers = (segment: Segment, days: number, forAds = false): string[] =>
  segmentMembers(segment, days, forAds).map((m) => m.customer);

// Opt-outs are recorded as the customer writes (the template's stop button arrives as its text too).
export const isOptOut = (text: string) => OPT_OUT.test(text);
onCustomerTexts((customer, text) => {
  if (isOptOut(text)) optOut(customer, text);
});

// --- Campaigns ----------------------------------------------------------------------------

export type CampaignInput = { template: string; language: string; segment: Segment; days: number; dailyCap: number; image?: string };

export async function createCampaign(input: CampaignInput): Promise<number> {
  const template = (await listTemplates()).find((t) => t.name === input.template && t.language === input.language);
  if (!template) throw new Error("القالب مش موجود");
  if (template.status !== "APPROVED") throw new Error("القالب لسا ما انقبل من ميتا");
  if (template.unsupported) throw new Error(`القالب ما بينبعت من هون: ${template.unsupported}`);
  if (template.imageHeader && !input.image) throw new Error("القالب فيه صورة: اختار صورة");
  const customers = segmentCustomers(input.segment, input.days);
  if (!customers.length) throw new Error("ما في زباين بهالمجموعة");
  const now = Date.now();
  const id = Number(
    db
      .prepare(
        `INSERT INTO campaigns (template, language, segment, days, body, image, daily_cap, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'paused', ?)`,
      )
      .run(template.name, template.language, input.segment, input.days, template.body, input.image ?? null, input.dailyCap, now).lastInsertRowid,
  );
  const add = db.prepare("INSERT OR IGNORE INTO campaign_recipients (campaign, customer, status, updated_at) VALUES (?, ?, 'queued', ?)");
  db.exec("BEGIN");
  for (const c of customers) add.run(id, c, now);
  db.exec("COMMIT");
  log("campaigns", `campaign ${id} created: ${template.name} → ${customers.length} customer(s), paused until started`);
  return id;
}

export function setCampaignStatus(id: number, status: "running" | "paused" | "stopped") {
  if (status === "running" && deletingTemplates.size) {
    const campaign = db.prepare("SELECT template FROM campaigns WHERE id = ?").get(id) as { template: string } | undefined;
    if (campaign && deletingTemplates.has(campaign.template)) throw new Error("قالب الحملة عم ينحذف، جرّب بعد شوي");
  }
  db.prepare("UPDATE campaigns SET status = ?, note = '' WHERE id = ? AND status != 'done'").run(status, id);
}

export function listCampaigns() {
  const campaigns = db.prepare("SELECT * FROM campaigns ORDER BY id DESC LIMIT 30").all() as CampaignRow[];
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign = ? GROUP BY status");
  // Replies: customers who wrote after their campaign message.
  const replied = db.prepare(
    `SELECT COUNT(*) AS n FROM campaign_recipients r WHERE r.campaign = ? AND r.sent_at IS NOT NULL AND r.status != 'failed'
       AND EXISTS (SELECT 1 FROM messages m WHERE m.customer = r.customer AND m.role = 'customer' AND m.created_at > r.sent_at)`,
  );
  const orders = db.prepare(
    `SELECT COUNT(*) AS n FROM campaign_recipients r WHERE r.campaign = ? AND r.sent_at IS NOT NULL AND r.status != 'failed'
       AND EXISTS (SELECT 1 FROM orders o WHERE o.customer = r.customer AND o.created_at > r.sent_at)`,
  );
  return campaigns.map((c) => ({
    id: c.id,
    template: c.template,
    segment: c.segment,
    segmentLabel: SEGMENTS[c.segment as Segment] ?? c.segment,
    days: c.days,
    body: c.body,
    dailyCap: c.daily_cap,
    status: c.status,
    note: c.note,
    createdAt: c.created_at,
    counts: Object.fromEntries((counts.all(c.id) as { status: string; n: number }[]).map((r) => [r.status, r.n])),
    replied: (replied.get(c.id) as { n: number }).n,
    orders: (orders.get(c.id) as { n: number }).n,
    sentToday: sentSince(c.id, startOfToday()),
  }));
}

type CampaignRow = {
  id: number;
  template: string;
  language: string;
  segment: string;
  days: number;
  body: string;
  image: string | null;
  daily_cap: number;
  status: string;
  note: string;
  created_at: number;
};

const startOfToday = () => {
  const offset = config.dashboard.timezoneOffsetHours * 60 * 60 * 1000;
  return Math.floor((Date.now() + offset) / DAY) * DAY - offset;
};
const sentSince = (id: number, since: number) =>
  (db.prepare("SELECT COUNT(*) AS n FROM campaign_recipients WHERE campaign = ? AND sent_at >= ?").get(id, since) as { n: number }).n;

// --- Sending ------------------------------------------------------------------------------

const firstName = (customer: string) => contactName(customer).trim().split(/\s+/)[0]?.slice(0, 20) || "استاذ";

export function templatePayload(c: Pick<CampaignRow, "template" | "language" | "body" | "image">, customer: string) {
  const components: Record<string, unknown>[] = [];
  if (c.image) components.push({ type: "header", parameters: [{ type: "image", image: { link: c.image } }] });
  if (/\{\{\s*1\s*\}\}/.test(c.body)) components.push({ type: "body", parameters: [{ type: "text", text: firstName(customer) }] });
  return {
    messaging_product: "whatsapp",
    to: customer,
    type: "template",
    template: { name: c.template, language: { code: c.language }, ...(components.length ? { components } : {}) },
  };
}

// Meta's error codes (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).
// About this one customer: recorded on their row, the run goes on.
const OPTED_OUT_CODE = 131050; // the user stopped marketing messages from us
// About the whole run (the template, the account, the number's limits): the campaign pauses, the row stays queued.
// 132xxx: the template (missing, paused, disabled, wrong parameters); 131031: account locked; 131042: payment;
// 131048: spam rate limit (too many blocks); 130429/80007: throughput; 131053: the header photo; 368: blocked for
// policy; 190: the key. (131056, sent too fast to the same person, is about one customer.)
const RUN_LEVEL = /"code"\s*:\s*(132\d{3}|131031|131042|131048|130429|80007|131053|368|190)\b/;
const errorCode = (detail: string) => detail.match(/"code"\s*:\s*(\d+)/)?.[1];

const MAX_ATTEMPTS = 3;

type SendResult = "sent" | "failed" | "retry" | "run_error";

function updateRow(campaign: number, customer: string, fields: Record<string, string | number | null>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE campaign_recipients SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE campaign = ? AND customer = ?`).run(
    ...Object.values(fields),
    Date.now(),
    campaign,
    customer,
  );
}

function optOut(customer: string, reason: string) {
  db.prepare("INSERT OR IGNORE INTO campaign_optouts (customer, reason, created_at) VALUES (?, ?, ?)").run(customer, reason.slice(0, 100), Date.now());
}

export function classifySendError(status: number, detail: string): "run_error" | "passing" | "customer" {
  if (RUN_LEVEL.test(detail) || status === 401 || status === 403) return "run_error";
  if (status >= 500 || status === 429) return "passing";
  return "customer";
}

async function sendCampaignMessage(c: CampaignRow, customer: string): Promise<{ result: SendResult; detail?: string }> {
  // Marked before the call: after a restart in the middle, this row is never sent again by itself.
  updateRow(c.id, customer, { status: "sending" });
  const res = await fetch(`${config.whatsapp.dualhook.baseUrl}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(templatePayload(c, customer)),
  }).catch((err: unknown) => new Response(`network: ${String(err)}`, { status: 599 }));
  const now = Date.now();
  if (res.ok) {
    const wamid = ((await res.json().catch(() => ({}))) as { messages?: { id?: string }[] }).messages?.[0]?.id;
    updateRow(c.id, customer, { status: "sent", wamid: wamid ?? null, sent_at: now });
    // In the chat, for the AI to know what the customer answers, and for the team.
    const text = c.body.replace(/\{\{\s*1\s*\}\}/g, firstName(customer));
    saveMessage({ customer, role: "business", source: "ai", text: `[sent our offer message] ${text}`, wamid });
    return { result: "sent" };
  }
  const detail = `${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}`;
  const kind = classifySendError(res.status, detail);
  if (kind === "run_error") {
    updateRow(c.id, customer, { status: "queued" });
    return { result: "run_error", detail };
  }
  if (kind === "passing") {
    // Dualhook/Meta down for a moment: queued again, given up after a few tries.
    const row = db.prepare("SELECT attempts FROM campaign_recipients WHERE campaign = ? AND customer = ?").get(c.id, customer) as { attempts: number };
    if (row.attempts + 1 < MAX_ATTEMPTS) {
      updateRow(c.id, customer, { status: "queued", attempts: row.attempts + 1, error: detail });
      return { result: "retry", detail };
    }
  }
  if (errorCode(detail) === String(OPTED_OUT_CODE)) optOut(customer, "Meta: stopped marketing messages");
  updateRow(c.id, customer, { status: "failed", error: detail, sent_at: now });
  return { result: "failed", detail };
}

// Delivery reports from the webhook: the API's answer only means Meta took the message; most refusals of one
// customer (marketing limit, stopped our messages, not on WhatsApp) arrive here as "failed".
let statusesSeen = false;
const STATUS_RANK: Record<string, number> = { sending: 0, sent: 1, delivered: 2, read: 3 };
export function applyStatuses(statuses: MessageStatus[]) {
  const find = db.prepare("SELECT campaign, customer, status FROM campaign_recipients WHERE wamid = ?");
  for (const s of statuses) {
    if (!s.id || !["delivered", "read", "failed"].includes(s.status ?? "")) continue;
    const row = find.get(s.id) as { campaign: number; customer: string; status: string } | undefined;
    if (!row) continue;
    if (s.status === "failed") {
      const error = s.errors?.map((e) => `${e.code ?? ""} ${e.title ?? e.message ?? ""}`.trim()).join("; ") ?? "";
      if (s.errors?.some((e) => e.code === OPTED_OUT_CODE)) optOut(row.customer, "Meta: stopped marketing messages");
      updateRow(row.campaign, row.customer, { status: "failed", error });
    } else if ((STATUS_RANK[s.status!] ?? 0) > (STATUS_RANK[row.status] ?? 9)) {
      // Never back: a late "delivered" after "read" keeps "read"; a failed row stays failed.
      updateRow(row.campaign, row.customer, { status: s.status! });
    }
  }
}
onMessageStatuses((statuses) => {
  if (!statusesSeen) {
    statusesSeen = true;
    log("campaigns", "delivery reports are coming in from the webhook");
  }
  applyStatuses(statuses);
});

// Why this customer shouldn't get this campaign right now (checked at send time: since the campaign was made they may
// have written, ordered, been handed to the team, asked to stop, or got another campaign).
export function sendBlocker(c: Pick<CampaignRow, "id" | "segment">, customer: string): string | undefined {
  const now = Date.now();
  if (isBlacklisted(customer)) return "blacklisted";
  if (db.prepare("SELECT 1 FROM campaign_optouts WHERE customer = ?").get(customer)) return "opted out";
  const lastWrote = (db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE customer = ? AND role = 'customer'").get(customer) as { t: number | null }).t ?? 0;
  if (lastWrote > now - DAY) return "wrote recently";
  if (db.prepare("SELECT 1 FROM pauses WHERE customer = ? AND until > ?").get(customer, now)) return "with the team";
  if (db.prepare("SELECT 1 FROM campaign_recipients WHERE customer = ? AND campaign != ? AND sent_at > ?").get(customer, c.id, now - 7 * DAY))
    return "another campaign this week";
  if (db.prepare("SELECT 1 FROM orders WHERE customer = ? AND status IN ('new', 'confirmed')").get(customer)) return "order on its way";
  if (c.segment !== "buyers" && db.prepare("SELECT 1 FROM orders WHERE customer = ?").get(customer)) return "ordered";
  return undefined;
}

// Stops every running campaign, with the reason, and tells the team once.
function stopAll(note: string) {
  const running = db.prepare("SELECT id FROM campaigns WHERE status = 'running'").all() as { id: number }[];
  if (!running.length) return;
  db.prepare("UPDATE campaigns SET status = 'paused', note = ? WHERE status = 'running'").run(note);
  log("campaigns", `paused: ${note}`);
  notify("error", `⏸ <b>وقفت الحملات</b>: ${esc(note)}`);
}

function pauseCampaign(c: CampaignRow, note: string, detail = "") {
  db.prepare("UPDATE campaigns SET status = 'paused', note = ? WHERE id = ?").run(note, c.id);
  log("campaigns", `campaign ${c.id} paused: ${note} ${detail}`);
  notify("error", `⏸ <b>حملة ${c.id} وقفت</b> (${esc(c.template)}): ${esc(note)}${detail ? `\n<code>${esc(detail.slice(0, 300))}</code>` : ""}`);
}

// Of the last sends of a campaign, too many failed: something is wrong (template, number, audience).
function tooManyFailures(id: number): boolean {
  const last = db
    .prepare("SELECT status FROM campaign_recipients WHERE campaign = ? AND sent_at IS NOT NULL ORDER BY sent_at DESC LIMIT 20")
    .all(id) as { status: string }[];
  return last.length >= 10 && last.filter((r) => r.status === "failed").length >= last.length * 0.4;
}

let healthCheckedAt = 0;
let busy = false;

async function tick() {
  if (busy || !config.whatsapp.enabled || config.whatsapp.provider !== "dualhook") return;
  const running = db.prepare("SELECT * FROM campaigns WHERE status = 'running' ORDER BY id").all() as CampaignRow[];
  if (!running.length || !inWorkingHours(Date.now())) return;
  busy = true;
  try {
    // The number's quality, every 20 minutes of a run: RED (or sending blocked) stops everything.
    if (Date.now() - healthCheckedAt > 20 * 60 * 1000) {
      healthCheckedAt = Date.now();
      const health = await numberHealth().catch(() => undefined);
      if (health?.quality === "RED") return stopAll("جودة الرقم صارت حمرا عند ميتا (RED): كتار عملوا حظر. لا تكملوا قبل ما ترجع");
      if (health?.canSend === "BLOCKED") return stopAll("ميتا وقفت الإرسال من الرقم (BLOCKED)");
    }
    for (const c of running) {
      if (tooManyFailures(c.id)) {
        pauseCampaign(c, "كتير رسائل فشلت بآخر الإرسال: شوفوا الأخطاء قبل ما تكملوا");
        continue;
      }
      if (sentSince(c.id, startOfToday()) >= c.daily_cap) continue;
      // The next one that may still get it (a few skipped per round at most).
      let next: string | undefined;
      for (let i = 0; i < 20 && !next; i++) {
        const row = db
          .prepare("SELECT customer FROM campaign_recipients WHERE campaign = ? AND status = 'queued' ORDER BY attempts, rowid LIMIT 1")
          .get(c.id) as { customer: string } | undefined;
        if (!row) break;
        const why = sendBlocker(c, row.customer);
        if (why) updateRow(c.id, row.customer, { status: "skipped", error: why });
        else next = row.customer;
      }
      if (!next) {
        if (!db.prepare("SELECT 1 FROM campaign_recipients WHERE campaign = ? AND status = 'queued'").get(c.id)) {
          db.prepare("UPDATE campaigns SET status = 'done' WHERE id = ?").run(c.id);
          notify("order", `✅ <b>حملة ${c.id} خلصت</b> (${esc(c.template)})`);
        }
        continue;
      }
      const r = await sendCampaignMessage(c, next);
      if (r.result === "run_error") pauseCampaign(c, "ميتا رفضت الإرسال (القالب أو الحساب أو حد الإرسال)", r.detail);
      else if (r.result !== "sent") log(`wa:${next}`, `campaign ${c.id} send ${r.result}: ${r.detail}`);
    }
  } finally {
    busy = false;
  }
}

// One send every 20 seconds per running campaign (at most ~180 an hour), inside the daily cap and working hours.
export function startCampaigns() {
  setInterval(() => void tick().catch((e) => log("campaigns", `tick failed: ${String(e)}`)), 20 * 1000).unref();
}

// A test send of a template to one number (the team's own), before a campaign. Not saved in any chat.
export async function testSend(input: { template: string; language: string; image?: string; to: string }) {
  const template = (await listTemplates()).find((t) => t.name === input.template && t.language === input.language);
  if (!template) throw new Error("القالب مش موجود");
  const res = await fetch(`${config.whatsapp.dualhook.baseUrl}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(templatePayload({ template: template.name, language: template.language, body: template.body, image: input.image ?? null }, input.to)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return text;
}
