// Campaigns: a WhatsApp message template (approved by Meta in WhatsApp Manager) sent to a group of past customers,
// outside WhatsApp's 24-hour window. Only templates can be sent there.
// In Nov 2026 the number was YELLOW with "customers were blocking your phone number", and every sale runs on it, so:
// small daily caps, working hours only, a send at a time, never twice the same campaign to anyone, a customer who asks
// to stop is never sent another, and a run stops by itself when the number's quality drops or many sends fail.
// Sent from here, not through the AI's reply path: a refused send is recorded and skipped, never pausing the chat.
import { config } from "./config.js";
import { contactName, db, saveMessage } from "./store.js";
import { isBlacklisted } from "./blacklist.js";
import { customerLine, onCustomerTexts, onMessageStatuses } from "./channels/whatsapp.js";
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
    status      TEXT    NOT NULL,          -- 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'skipped'
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
  const url = `${config.whatsapp.dualhook.baseUrl}/${await waba()}/message_templates?limit=100&fields=name,status,category,language,components`;
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

// --- Who gets it ------------------------------------------------------------------------

export const SEGMENTS = {
  fur_no_order: "سألوا عن الفروة وما طلبوا",
  no_order: "كتبولنا وما طلبوا (أي منتج)",
  buyers: "اشتروا منا قبل (انسلم طلبهم)",
} as const;
export type Segment = keyof typeof SEGMENTS;

// "توقف", "إيقاف العروض", "stop"…: the customer doesn't want our messages (also Meta's opt-out button).
const OPT_OUT = /^\s*(stop|unsubscribe|توقف|اوقف|أوقف|ايقاف|إيقاف|الغاء الاشتراك|إلغاء الاشتراك|لا ترسل)/i;
const DAY = 24 * 60 * 60 * 1000;

// The customers of a segment, with every exclusion applied. forAds: the list for a Facebook ad audience (no message
// is sent, so only who they are counts: not the exclusions that protect the number).
export function segmentCustomers(segment: Segment, days: number, forAds = false): string[] {
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
  const optedOut = new Set((db.prepare("SELECT customer FROM campaign_optouts").all() as { customer: string }[]).map((r) => r.customer));
  // Anyone sent a campaign in the last week: one at a time.
  const recent = new Set(
    (db.prepare("SELECT DISTINCT customer FROM campaign_recipients WHERE sent_at > ?").all(now - 7 * DAY) as { customer: string }[]).map(
      (r) => r.customer,
    ),
  );
  const paused = new Set((db.prepare("SELECT customer FROM pauses WHERE until > ?").all(now) as { customer: string }[]).map((r) => r.customer));
  return rows
    .filter(({ customer, last }) => {
      if (!/^\d{9,15}$/.test(customer) || isMetaCustomer(customer) || customerLine(customer)) return false;
      if (isBlacklisted(customer) || optedOut.has(customer)) return false;
      // Wrote within the day: still in the 24-hour window, the AI talks with them.
      if (!forAds && (last > now - DAY || recent.has(customer) || paused.has(customer) || open.has(customer))) return false;
      if (segment === "buyers") return delivered.has(customer);
      if (ordered.has(customer)) return false;
      return segment === "no_order" || fur!.has(customer);
    })
    .map((r) => r.customer);
}

// Opt-outs are recorded as the customer writes (the template's stop button arrives as its text too).
onCustomerTexts((customer, text) => {
  if (OPT_OUT.test(text)) {
    db.prepare("INSERT OR IGNORE INTO campaign_optouts (customer, reason, created_at) VALUES (?, ?, ?)").run(customer, text.slice(0, 100), Date.now());
  }
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
  db.prepare("UPDATE campaigns SET status = ?, note = '' WHERE id = ? AND status != 'done'").run(status, id);
}

export function listCampaigns() {
  const campaigns = db.prepare("SELECT * FROM campaigns ORDER BY id DESC LIMIT 30").all() as CampaignRow[];
  const counts = db.prepare("SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE campaign = ? GROUP BY status");
  // Replies: customers who wrote after their campaign message.
  const replied = db.prepare(
    `SELECT COUNT(*) AS n FROM campaign_recipients r WHERE r.campaign = ? AND r.sent_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM messages m WHERE m.customer = r.customer AND m.role = 'customer' AND m.created_at > r.sent_at)`,
  );
  const orders = db.prepare(
    `SELECT COUNT(*) AS n FROM campaign_recipients r WHERE r.campaign = ? AND r.sent_at IS NOT NULL
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

function payload(c: CampaignRow, customer: string) {
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

// Meta's refusals of one customer (not the whole run): recorded and skipped.
// 131049: Meta limits marketing messages to this user; 131050: the user stopped marketing messages;
// 131026: not on WhatsApp / can't receive.
const OPTED_OUT_CODE = 131050;

export async function sendCampaignMessage(c: CampaignRow, customer: string): Promise<{ ok: boolean; error?: string; passing?: boolean }> {
  const res = await fetch(`${config.whatsapp.dualhook.baseUrl}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(payload(c, customer)),
  }).catch((err: unknown) => new Response(`network: ${String(err)}`, { status: 599 }));
  const now = Date.now();
  if (res.ok) {
    const wamid = ((await res.json()) as { messages?: { id?: string }[] }).messages?.[0]?.id;
    db.prepare("UPDATE campaign_recipients SET status = 'sent', wamid = ?, sent_at = ?, updated_at = ? WHERE campaign = ? AND customer = ?").run(
      wamid ?? null,
      now,
      now,
      c.id,
      customer,
    );
    // In the chat, for the AI to know what the customer answers, and for the team.
    const text = c.body.replace(/\{\{\s*1\s*\}\}/g, firstName(customer));
    saveMessage({ customer, role: "business", source: "ai", text: `[sent our offer message] ${text}`, wamid });
    return { ok: true };
  }
  const detail = (await res.text().catch(() => "")).slice(0, 300);
  // Dualhook/Meta down for a moment: stays queued, tried on a later round.
  if (res.status >= 500 || res.status === 429) return { ok: false, error: `${res.status} ${detail}`, passing: true };
  if (new RegExp(`"code"\\s*:\\s*${OPTED_OUT_CODE}`).test(detail)) {
    db.prepare("INSERT OR IGNORE INTO campaign_optouts (customer, reason, created_at) VALUES (?, 'Meta: stopped marketing messages', ?)").run(customer, now);
  }
  db.prepare("UPDATE campaign_recipients SET status = 'failed', error = ?, sent_at = ?, updated_at = ? WHERE campaign = ? AND customer = ?").run(
    `${res.status} ${detail}`,
    now,
    now,
    c.id,
    customer,
  );
  return { ok: false, error: `${res.status} ${detail}` };
}

// Delivery reports from the webhook: "sent" by the API only means Meta took it.
onMessageStatuses((statuses) => {
  const set = db.prepare(
    `UPDATE campaign_recipients SET status = ?, error = ?, updated_at = ? WHERE wamid = ?
       AND (status IN ('sent', 'delivered') OR ? = 'failed')`,
  );
  for (const s of statuses) {
    if (!s.id || !["delivered", "read", "failed"].includes(s.status ?? "")) continue;
    const error = s.errors?.map((e) => `${e.code ?? ""} ${e.title ?? e.message ?? ""}`.trim()).join("; ") ?? "";
    set.run(s.status!, error, Date.now(), s.id, s.status!);
  }
});

// Stops every running campaign, with the reason, and tells the team once.
function stopAll(note: string) {
  const running = db.prepare("SELECT id FROM campaigns WHERE status = 'running'").all() as { id: number }[];
  if (!running.length) return;
  db.prepare("UPDATE campaigns SET status = 'paused', note = ? WHERE status = 'running'").run(note);
  log("campaigns", `paused: ${note}`);
  notify("error", `⏸ <b>وقفت الحملات</b>: ${esc(note)}`);
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
    // The number's quality, every 20 minutes of a run: RED (or sending limited further) stops everything.
    if (Date.now() - healthCheckedAt > 20 * 60 * 1000) {
      healthCheckedAt = Date.now();
      const health = await numberHealth().catch(() => undefined);
      if (health?.quality === "RED") return stopAll("جودة الرقم صارت حمرا عند ميتا (RED): كتار عملوا حظر. لا تكملوا قبل ما ترجع");
      if (health?.canSend === "BLOCKED") return stopAll("ميتا وقفت الإرسال من الرقم (BLOCKED)");
    }
    for (const c of running) {
      if (tooManyFailures(c.id)) {
        db.prepare("UPDATE campaigns SET status = 'paused', note = ? WHERE id = ?").run("كتير رسائل فشلت بآخر الإرسال: شوفوا الأخطاء قبل ما تكملوا", c.id);
        notify("error", `⏸ <b>حملة ${c.id} وقفت</b>: كتير رسائل فشلت (${esc(c.template)})`);
        continue;
      }
      if (sentSince(c.id, startOfToday()) >= c.daily_cap) continue;
      const next = db
        .prepare("SELECT customer FROM campaign_recipients WHERE campaign = ? AND status = 'queued' ORDER BY rowid LIMIT 1")
        .get(c.id) as { customer: string } | undefined;
      if (!next) {
        db.prepare("UPDATE campaigns SET status = 'done' WHERE id = ?").run(c.id);
        notify("order", `✅ <b>حملة ${c.id} خلصت</b> (${esc(c.template)})`);
        continue;
      }
      // Checked again at send time: they may have written, ordered or asked to stop since it was made.
      if (isBlacklisted(next.customer) || db.prepare("SELECT 1 FROM campaign_optouts WHERE customer = ?").get(next.customer)) {
        db.prepare("UPDATE campaign_recipients SET status = 'skipped', updated_at = ? WHERE campaign = ? AND customer = ?").run(Date.now(), c.id, next.customer);
        continue;
      }
      const lastWrote = (db.prepare("SELECT MAX(created_at) AS t FROM messages WHERE customer = ? AND role = 'customer'").get(next.customer) as { t: number | null }).t ?? 0;
      if (lastWrote > Date.now() - DAY) {
        db.prepare("UPDATE campaign_recipients SET status = 'skipped', error = 'wrote recently', updated_at = ? WHERE campaign = ? AND customer = ?").run(Date.now(), c.id, next.customer);
        continue;
      }
      const r = await sendCampaignMessage(c, next.customer);
      if (!r.ok) log(`wa:${next.customer}`, `campaign ${c.id} send failed: ${r.error}`);
    }
  } finally {
    busy = false;
  }
}

// One send every 20 seconds per running campaign (at most ~180 an hour), inside the daily cap and working hours.
export function startCampaigns() {
  setInterval(() => void tick().catch((e) => log("campaigns", `tick failed: ${String(e)}`)), 20 * 1000).unref();
}

// A test send of a template to one number (the team's own), before a campaign.
export async function testSend(input: { template: string; language: string; image?: string; to: string }) {
  const template = (await listTemplates()).find((t) => t.name === input.template && t.language === input.language);
  if (!template) throw new Error("القالب مش موجود");
  const fake: CampaignRow = {
    id: 0,
    template: template.name,
    language: template.language,
    segment: "",
    days: 0,
    body: template.body,
    image: input.image ?? null,
    daily_cap: 0,
    status: "",
    note: "",
    created_at: 0,
  };
  const res = await fetch(`${config.whatsapp.dualhook.baseUrl}/${config.whatsapp.phoneNumberId}/messages`, {
    method: "POST",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(payload(fake, input.to)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return text;
}
