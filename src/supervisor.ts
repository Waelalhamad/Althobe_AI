// "المشرف العام": watches the team's (and the AI's) customer chats and tells the owner what matters.
// - every 5 minutes, free checks: customers left without a reply, AI orders nobody confirmed;
// - every 30 minutes, an AI review of chats that had new replies (tone, relevance, wrong info, missed sales);
// - once a day, a short report. Alerts and the report also go to the Telegram group.
// It only reads chats and writes to the team; it never messages customers.
import OpenAI from "openai";
import { learningStats } from "./learning.js";
import { config } from "./config.js";
import { loadKnowledge } from "./knowledge.js";
import { catalogForPrompt } from "./catalog.js";
import { db, getSetting, setSetting } from "./store.js";
import { log } from "./scheduler.js";
import { costUsd, localDay, localDayStart, totals } from "./dashboard/queries.js";
import { maybeSendDailySheet } from "./ordersSheet.js";
import { customerLabel, dashboardLink, esc, notify, notifyError } from "./telegram.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

db.exec(`
  -- Things the team should act on (one row per problem; "key" stops the same alert twice).
  CREATE TABLE IF NOT EXISTS alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key          TEXT    NOT NULL UNIQUE,
    kind         TEXT    NOT NULL,          -- 'unanswered' | 'order_unconfirmed' | 'review'
    customer     TEXT,
    severity     TEXT    NOT NULL,          -- 'low' | 'medium' | 'high'
    title        TEXT    NOT NULL,
    detail       TEXT    NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    resolved_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS alerts_created ON alerts (created_at);

  -- The supervisor's review of one stretch of a conversation (messages from_id..to_id).
  CREATE TABLE IF NOT EXISTS reviews (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    customer          TEXT    NOT NULL,
    from_id           INTEGER NOT NULL,
    to_id             INTEGER NOT NULL,
    score             INTEGER NOT NULL,     -- 1..5
    outcome           TEXT    NOT NULL,
    summary           TEXT    NOT NULL,
    praise            TEXT    NOT NULL DEFAULT '',
    issues            TEXT    NOT NULL,     -- JSON: ReviewIssue[]
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS reviews_customer ON reviews (customer, to_id);
  CREATE INDEX IF NOT EXISTS reviews_created ON reviews (created_at);

  CREATE TABLE IF NOT EXISTS reports (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    day               TEXT    NOT NULL UNIQUE, -- local date, e.g. 2026-10-25
    stats             TEXT    NOT NULL,        -- JSON: DayStats
    text              TEXT    NOT NULL,
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    cached_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
  );
`);

// --- Settings (changed from the dashboard) --------------------------------------------

export type SupervisorSettings = {
  enabled: boolean; // the free checks and alerts
  reviews: boolean; // the AI reviews and the daily report (cost OpenAI tokens)
  unansweredMinutes: number; // alert when a customer waits this long for a reply
  escalateMinutes: number; // second alert if they still wait
  orderConfirmHours: number; // alert when an AI order is still "new" after this
  workStart: number; // working hours, local time (alerts only inside them)
  workEnd: number;
  reportHour: number; // the daily report, local time
  dailyReviewCap: number; // most AI reviews per day, to keep the cost down
};

const DEFAULTS: SupervisorSettings = {
  enabled: true,
  reviews: true,
  unansweredMinutes: 15,
  escalateMinutes: 60,
  orderConfirmHours: 2,
  workStart: 9,
  workEnd: 24,
  reportHour: 23,
  dailyReviewCap: 150,
};

export function supervisorSettings(): SupervisorSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(getSetting("supervisor") ?? "{}") as Partial<SupervisorSettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveSupervisorSettings(patch: Record<string, unknown>): SupervisorSettings {
  const next = supervisorSettings();
  for (const key of ["enabled", "reviews"] as const) if (typeof patch[key] === "boolean") next[key] = patch[key];
  const ranges = {
    unansweredMinutes: [3, 24 * 60],
    escalateMinutes: [5, 48 * 60],
    orderConfirmHours: [1, 72],
    workStart: [0, 23],
    workEnd: [1, 24],
    reportHour: [0, 23],
    dailyReviewCap: [0, 2000],
  } as const;
  for (const [key, [min, max]] of Object.entries(ranges) as [keyof typeof ranges, readonly [number, number]][]) {
    const n = Math.round(Number(patch[key]));
    if (patch[key] !== undefined && Number.isFinite(n) && n >= min && n <= max) next[key] = n;
  }
  setSetting("supervisor", JSON.stringify(next));
  return next;
}

const localHour = (ms: number) => new Date(ms + config.dashboard.timezoneOffsetHours * HOUR).getUTCHours();

export function inWorkingHours(ms: number, s = supervisorSettings()): boolean {
  const h = localHour(ms);
  return s.workStart <= s.workEnd ? h >= s.workStart && h < s.workEnd : h >= s.workStart || h < s.workEnd;
}

// --- Who is waiting for a reply ---------------------------------------------------------

// Messages that don't need an answer (reactions, deleted/edited notices, a plain "thanks").
const NOISE = /^\[sent a (reaction|revoke|edit|unsupported)/;
const CLOSING = /^(شكرا|شكراً|مشكور|مشكورين|تسلم|تسلمو|يعطيك العافية|الله يسلمك|بارك الله|ok|okay|اوك|اوكي|👍|❤️|🙏|🌹|💐|♥️)[\s!.\u{1F300}-\u{1FAFF}❤️]*$/iu;

export type Waiting = { customer: string; since: number; minutes: number; lastText: string; messages: number };

// Customers whose last message (in the last 2 days) has no reply yet, longest wait first.
export function waitingCustomers(): Waiting[] {
  const rows = db
    .prepare(
      `SELECT m.customer, m.role, m.text FROM messages m
       JOIN (SELECT customer, MAX(id) AS id FROM messages
             WHERE history = 0 AND created_at > ? AND text NOT LIKE '[sent a reaction%'
               AND text NOT LIKE '[sent a revoke%' AND text NOT LIKE '[sent a edit%'
             GROUP BY customer) last ON last.id = m.id
       WHERE m.role = 'customer'`,
    )
    .all(Date.now() - 48 * HOUR) as { customer: string; role: string; text: string }[];
  const firstUnanswered = db.prepare(
    `SELECT MIN(created_at) AS since, COUNT(*) AS n FROM messages
     WHERE customer = ? AND history = 0 AND role = 'customer'
       AND id > COALESCE((SELECT MAX(id) FROM messages WHERE customer = ? AND role = 'business'), 0)`,
  );
  const waiting: Waiting[] = [];
  for (const r of rows) {
    if (CLOSING.test(r.text.trim()) || NOISE.test(r.text)) continue;
    const first = firstUnanswered.get(r.customer, r.customer) as { since: number | null; n: number };
    if (!first.since) continue;
    waiting.push({
      customer: r.customer,
      since: first.since,
      minutes: Math.round((Date.now() - first.since) / MINUTE),
      lastText: r.text.slice(0, 200),
      messages: first.n,
    });
  }
  return waiting.sort((a, b) => a.since - b.since);
}

// --- Alerts ---------------------------------------------------------------------------------

type NewAlert = { key: string; kind: string; customer?: string; severity: "low" | "medium" | "high"; title: string; detail?: string };

const insertAlert = db.prepare(
  `INSERT OR IGNORE INTO alerts (key, kind, customer, severity, title, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

// Returns true when the alert is new.
function raise(a: NewAlert): boolean {
  return insertAlert.run(a.key, a.kind, a.customer ?? null, a.severity, a.title, a.detail ?? "", Date.now()).changes > 0;
}

export function resolveAlert(id: number): boolean {
  return db.prepare("UPDATE alerts SET resolved_at = ? WHERE id = ? AND resolved_at IS NULL").run(Date.now(), id).changes > 0;
}

// Long lists are cut (a Telegram message holds 4096 characters); the dashboard has them all.
function capped(lines: string[], max = 12): string {
  const shown = lines.slice(0, max).join("\n");
  return lines.length > max ? `${shown}\n… و ${lines.length - max} كمان ${dashboardLink("/supervisor", "باللوحة")}` : shown;
}

const waitText = (minutes: number) => (minutes < 60 ? `${minutes} دقيقة` : `${Math.floor(minutes / 60)} س ${minutes % 60} د`);

// The free checks: customers waiting too long, AI orders nobody confirmed.
export function runChecks() {
  const s = supervisorSettings();
  if (!s.enabled || !inWorkingHours(Date.now(), s)) return;

  const lines: string[] = [];
  for (const w of waitingCustomers()) {
    if (w.minutes < s.unansweredMinutes) continue;
    const late = w.minutes >= s.escalateMinutes;
    const isNew = raise({
      key: `${late ? "unanswered-late" : "unanswered"}:${w.customer}:${w.since}`,
      kind: "unanswered",
      customer: w.customer,
      severity: late ? "high" : "medium",
      title: `زبون ناطر رد من ${waitText(w.minutes)}`,
      detail: w.lastText,
    });
    if (isNew) {
      lines.push(
        `${late ? "🔴" : "🟠"} ${esc(customerLabel(w.customer))} · ناطر من <b>${waitText(w.minutes)}</b>\n   «${esc(w.lastText.slice(0, 120))}» ${dashboardLink(`/inbox/${w.customer}`, "فتح")}`,
      );
    }
  }
  if (lines.length) notify("supervisor", `⏰ <b>زباين ما حدا رد عليهم</b>\n\n${capped(lines)}`);

  // No customer message for hours in the middle of the day: the WhatsApp connection may be down.
  const lastIn = (db.prepare("SELECT MAX(created_at) AS at FROM messages WHERE history = 0 AND role = 'customer'").get() as { at: number | null }).at;
  if (lastIn && Date.now() - lastIn > 4 * HOUR && localHour(Date.now()) >= s.workStart + 4) {
    const isNew = raise({
      key: `silence:${localDay(Date.now())}`,
      kind: "silence",
      severity: "high",
      title: "ما وصلت ولا رسالة من الزباين من 4 ساعات",
      detail: "تأكدوا إنو واتساب مربوط و Dualhook شغال، وإنو الإعلانات شغالة.",
    });
    if (isNew) {
      notify("error", `📵 <b>ما وصلت ولا رسالة من الزباين من ${Math.floor((Date.now() - lastIn) / HOUR)} ساعات</b>\nتأكدوا إنو واتساب مربوط و Dualhook شغال، وإنو الإعلانات شغالة.`);
    }
  }

  const stale = db
    .prepare("SELECT id, customer, name, phone, total, created_at FROM orders WHERE status = 'new' AND created_at < ? AND created_at > ?")
    .all(Date.now() - s.orderConfirmHours * HOUR, Date.now() - 7 * 24 * HOUR) as {
    id: number;
    customer: string;
    name: string;
    phone: string;
    total: string;
    created_at: number;
  }[];
  const orderLines: string[] = [];
  for (const o of stale) {
    const hours = Math.round((Date.now() - o.created_at) / HOUR);
    const isNew = raise({
      key: `order-unconfirmed:${o.id}`,
      kind: "order_unconfirmed",
      customer: o.customer,
      severity: "high",
      title: `طلب #${o.id} ما تأكد من ${hours} ساعة`,
      detail: `${o.name} · ${o.phone} · ${o.total}`,
    });
    if (isNew) orderLines.push(`🛍 طلب <b>#${o.id}</b> · ${esc(o.name)} · <code>${esc(o.phone)}</code> · من ${hours} ساعة`);
  }
  if (orderLines.length) {
    notify("supervisor", `📦 <b>طلبات لسا ما حدا أكّدها</b>\n\n${capped(orderLines)}\n${dashboardLink("/orders", "فتح الطلبات")}`);
  }
}

// --- AI reviews -------------------------------------------------------------------------------

export const ISSUE_TYPES = [
  "slow_reply",
  "unanswered_question",
  "irrelevant_reply",
  "rude_or_cold",
  "wrong_info",
  "missed_sale",
  "no_follow_up",
  "order_not_handled",
  "unclear_message",
  "other",
] as const;

export type ReviewIssue = {
  who: "team" | "ai";
  type: (typeof ISSUE_TYPES)[number];
  severity: "low" | "medium" | "high";
  quote: string;
  problem: string;
  advice: string;
};

type ReviewResult = {
  score: number;
  outcome: "ordered" | "interested" | "lost" | "no_reply_needed" | "support";
  summary: string;
  praise: string;
  issues: ReviewIssue[];
};

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "outcome", "summary", "praise", "issues"],
  properties: {
    score: { type: "integer", minimum: 1, maximum: 5 },
    outcome: { type: "string", enum: ["ordered", "interested", "lost", "no_reply_needed", "support"] },
    summary: { type: "string" },
    praise: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["who", "type", "severity", "quote", "problem", "advice"],
        properties: {
          who: { type: "string", enum: ["team", "ai"] },
          type: { type: "string", enum: ISSUE_TYPES },
          severity: { type: "string", enum: ["low", "medium", "high"] },
          quote: { type: "string" },
          problem: { type: "string" },
          advice: { type: "string" },
        },
      },
    },
  },
} as const;

const SUPERVISOR = `You are "المشرف العام", the supervisor of the customer-service team of our store (described in the knowledge documents below, with every product we sell). Customers are mostly in Libya, arrive from our Meta ads, and chat with us on WhatsApp. Our side of the chat is TEAM (employees, writing from the WhatsApp Business app on their phones or from the dashboard) and BOT (our AI assistant). You review chats and tell the owner what needs attention. You never talk to customers.

What good service looks like here (learned from our best chats):
- Speed. Ad customers go cold fast. In working hours a first answer should come within a few minutes; 15+ minutes is slow, an hour or more is very slow. Each of our lines shows how long the customer waited.
- The opening: a greeting and what the product includes in one or two short lines, its photos, then the first choice it needs (e.g. which color) and which country the customer is in. The price comes only when the customer asks for it, after they have seen the colors. "السلام عليكم" is answered with "وعليكم السلام ورحمة الله وبركاته". A product's knowledge document may describe its own opening and sales steps. A customer line starting with "[from the ad: ...]" shows which ad (product) they came from.
- Answer exactly what the customer asked, in warm, simple Libyan Arabic. Ready-made templates are fine when they answer the question. They are a problem when they ignore the customer's actual question, repeat what was already said, or answer something else (copy-paste without reading).
- Move toward the sale: offer to book ("تحب نحجزلك؟"), collect color, size, quantity, name, phone and city/area, send the order summary and confirm it.
- Leave nothing hanging: every question gets an answer, and a promise ("نرجعلك", "نشوفلك", "نتأكدلك") is kept in the chat.
- Polite and patient, even when the customer is rude or hesitant. No arguing, blaming, mocking, or cold one-word replies to a real question.
- Correct information: prices, sizes, colors, delivery and policies must match the knowledge documents below. Inventing discounts, stock or delivery dates is wrong.
- Complaints and order problems (late, wrong size, refund) get empathy and a clear next step.

How to review:
- Lines marked ★ are new since the last review: judge those. Earlier lines are context only.
- Judge both TEAM and BOT lines, and set "who" to "team" or "ai".
- Report only real problems that affect sales, the customer, or the brand's image. No nitpicking about spelling or style unless it makes a message unclear or unprofessional. A good chat has no issues.
- A customer who stops after hearing the price or says they will think is normal. It is "missed_sale" only if we did something wrong or did not try (no photos, no question about color/size, no answer to their objection, no offer to book).
- "slow_reply" only for waits during working hours ({WORK}); a wait marked "asked outside working hours" is never slow.
- Judge the conversation as a whole, not each message alone: a reply that answers just what was asked is right even if it doesn't repeat the price or ask to book; it's a problem only if the chat as a whole never moves toward the sale.
- "order_not_handled": the customer gave order details or confirmed but nobody completed or confirmed the order.
- quote: the exact problem message (short excerpt, as written). problem: what went wrong, in Arabic. advice: what the employee should have done, in Arabic; include a suggested reply in Libyan Arabic when it helps. A suggested reply may only use facts from the knowledge documents: never invent payment methods, discounts, reservations, delivery dates or stock.
- severity: high = likely lost customer or order, rude, wrong price or info, customer ignored, complaint mishandled; medium = slow, irrelevant copy-paste, a question left unanswered; low = minor.
- score: 5 excellent, 4 good, 3 acceptable with problems, 2 poor, 1 bad.
- summary: one short line in Arabic: what the customer wanted and how it ended.
- praise: one short line in Arabic about something done well, or "" if nothing stands out.
- outcome: ordered (order placed or confirmed), interested (still deciding), lost (customer left after a problem or no reply), no_reply_needed, support (question about an existing order).
- [photo], [voice note] ... and [sent product photo: ...] describe media. Photos we send are our product photos.

Write all text fields in clear, simple Arabic.`;

let client: OpenAI | undefined;

function supervisorPrompt(): string {
  const s = supervisorSettings();
  return `${SUPERVISOR.replace("{WORK}", `${s.workStart}:00 to ${s.workEnd}:00 Libya time`)}\n\n# Product photos${catalogForPrompt()}\n\n# Knowledge documents\n\n${loadKnowledge()}`;
}

type Row = { id: number; role: string; source: string; text: string; created_at: number; history: number };

function clock(ms: number): string {
  const d = new Date(ms + config.dashboard.timezoneOffsetHours * HOUR);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

// The chat as the supervisor reads it: time, who, wait time for our replies, ★ on lines to judge.
function transcript(rows: Row[], fromId: number): string {
  let waitingSince: number | undefined;
  return rows
    .map((r) => {
      const who = r.source === "customer" ? "CUSTOMER" : r.source === "ai" ? "BOT" : "TEAM";
      let wait = "";
      if (r.role === "customer") waitingSince ??= r.created_at;
      else if (waitingSince !== undefined) {
        const minutes = Math.round((r.created_at - waitingSince) / MINUTE);
        wait = `, customer waited ${minutes < 60 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`}${inWorkingHours(waitingSince) ? "" : " (asked outside working hours, so not slow)"}`;
        waitingSince = undefined;
      }
      const mark = r.history === 0 && r.id >= fromId ? "★ " : "";
      return `${mark}[${clock(r.created_at)}${wait}] ${who}: ${r.text.replace(/\s+/g, " ").slice(0, 600)}`;
    })
    .join("\n");
}

function reviewsToday(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE created_at >= ?").get(localDayStart(0)) as { n: number }).n;
}

// Reviews one conversation's new messages (since its last review). Returns the review id, or undefined.
export async function reviewConversation(customer: string): Promise<number | undefined> {
  const lastReviewed =
    (db.prepare("SELECT MAX(to_id) AS id FROM reviews WHERE customer = ?").get(customer) as { id: number | null }).id ?? 0;
  const rows = (
    db
      .prepare(
        `SELECT id, role, source, text, created_at, history FROM messages WHERE customer = ?
         ORDER BY history DESC, CASE WHEN history = 1 THEN created_at ELSE id END DESC LIMIT 50`,
      )
      .all(customer) as Row[]
  ).reverse();
  const fresh = rows.filter((r) => r.history === 0 && r.id > lastReviewed);
  if (!fresh.some((r) => r.role === "business")) return undefined;
  const fromId = fresh[0]!.id;
  const toId = fresh[fresh.length - 1]!.id;

  client ??= new OpenAI();
  const completion = await client.chat.completions.create({
    model: config.openai.supportModel,
    reasoning_effort: "low",
    messages: [
      { role: "developer", content: supervisorPrompt() },
      { role: "user", content: `Chat with customer ${customerLabel(customer)}:\n\n${transcript(rows, fromId)}` },
    ],
    response_format: { type: "json_schema", json_schema: { name: "review", strict: true, schema: REVIEW_SCHEMA } },
  });
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error("supervisor returned an empty review");
  const review = JSON.parse(content) as ReviewResult;
  const u = completion.usage;

  const id = Number(
    db
      .prepare(
        `INSERT INTO reviews (customer, from_id, to_id, score, outcome, summary, praise, issues, prompt_tokens, cached_tokens, completion_tokens, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        customer,
        fromId,
        toId,
        review.score,
        review.outcome,
        review.summary,
        review.praise,
        JSON.stringify(review.issues),
        u?.prompt_tokens ?? 0,
        u?.prompt_tokens_details?.cached_tokens ?? 0,
        u?.completion_tokens ?? 0,
        Date.now(),
      ).lastInsertRowid,
  );

  const serious = review.issues.filter((i) => i.severity === "high");
  for (const [n, issue] of serious.entries()) {
    raise({
      key: `review:${id}:${n}`,
      kind: "review",
      customer,
      severity: "high",
      title: issue.problem,
      detail: `«${issue.quote}» ← ${issue.advice}`,
    });
  }
  if (serious.length) {
    const items = serious
      .map((i) => `• ${i.who === "ai" ? "🤖" : "👤"} ${esc(i.problem)}\n   «${esc(i.quote.slice(0, 150))}»\n   💡 ${esc(i.advice.slice(0, 300))}`)
      .join("\n");
    notify(
      "supervisor",
      `🔎 <b>ملاحظة من المشرف</b> · ${esc(customerLabel(customer))} · تقييم ${review.score}/5\n${esc(review.summary)}\n\n${items}\n${dashboardLink(`/inbox/${customer}`, "فتح المحادثة")}`,
    );
  }
  return id;
}

let reviewing = false;

// Reviews conversations that got new replies and have been quiet for 20 minutes (the exchange settled).
export async function runReviews(opts: { force?: boolean; max?: number } = {}): Promise<number> {
  const s = supervisorSettings();
  if (reviewing || (!opts.force && (!s.enabled || !s.reviews))) return 0;
  if (!process.env.OPENAI_API_KEY?.trim()) return 0;
  const room = Math.min(opts.max ?? 15, Math.max(0, s.dailyReviewCap - reviewsToday()));
  if (room === 0) return 0;

  reviewing = true;
  let done = 0;
  try {
    const due = db
      .prepare(
        `SELECT m.customer FROM messages m
         WHERE m.history = 0 AND m.created_at > ?
           AND m.id > COALESCE((SELECT MAX(to_id) FROM reviews r WHERE r.customer = m.customer), 0)
         GROUP BY m.customer
         HAVING SUM(m.role = 'business') > 0 AND MAX(m.created_at) < ?
         ORDER BY MAX(m.created_at) DESC LIMIT ?`,
      )
      .all(Date.now() - 24 * HOUR, Date.now() - (opts.force ? 0 : 20 * MINUTE), room) as { customer: string }[];
    for (const { customer } of due) {
      try {
        if ((await reviewConversation(customer)) !== undefined) done++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log("supervisor", `review of ${customer} failed: ${message}`);
        notifyError("المشرف: مراجعة محادثة", message);
        break; // usually OpenAI is down or out of credit: try again next round
      }
    }
  } finally {
    reviewing = false;
  }
  if (done) log("supervisor", `reviewed ${done} conversation(s)`);
  return done;
}

// --- Team numbers: response times ---------------------------------------------------------------

export type ResponseStats = { replies: number; p50Min: number; p90Min: number; slow: number; team: number; ai: number };

// How long customers waited for our first answer to each of their messages (working hours only).
export function responseStats(since: number, until = Date.now()): ResponseStats {
  const s = supervisorSettings();
  const rows = db
    .prepare(
      `SELECT customer, role, source, created_at FROM messages WHERE history = 0 AND created_at >= ? AND created_at < ?
       AND text NOT LIKE '[sent a reaction%' ORDER BY customer, id`,
    )
    .all(since, until) as { customer: string; role: string; source: string; created_at: number }[];
  const waits: number[] = [];
  let team = 0;
  let ai = 0;
  let current = "";
  let waitingSince: number | undefined;
  for (const r of rows) {
    if (r.customer !== current) {
      current = r.customer;
      waitingSince = undefined;
    }
    if (r.role === "customer") waitingSince ??= r.created_at;
    else if (waitingSince !== undefined) {
      if (inWorkingHours(waitingSince, s)) {
        waits.push((r.created_at - waitingSince) / MINUTE);
        if (r.source === "ai") ai++;
        else team++;
      }
      waitingSince = undefined;
    }
  }
  waits.sort((a, b) => a - b);
  const at = (q: number) => (waits.length ? Math.round(waits[Math.min(waits.length - 1, Math.floor(q * waits.length))]!) : 0);
  return { replies: waits.length, p50Min: at(0.5), p90Min: at(0.9), slow: waits.filter((w) => w >= s.unansweredMinutes).length, team, ai };
}

// --- Daily report ----------------------------------------------------------------------------------

export type DayStats = {
  day: string;
  conversations: number;
  newCustomers: number;
  customerMessages: number;
  teamMessages: number;
  aiReplies: number;
  orders: number;
  handoffs: number;
  waitingNow: number;
  unansweredAlerts: number;
  response: ResponseStats;
  reviews: number;
  avgScore: number | null;
  issues: Record<string, number>;
  outcomes: Record<string, number>;
};

function dayStats(since: number): DayStats {
  const t = totals(since);
  const reviews = db
    .prepare("SELECT score, outcome, issues FROM reviews WHERE created_at >= ?")
    .all(since) as { score: number; outcome: string; issues: string }[];
  const issues: Record<string, number> = {};
  const outcomes: Record<string, number> = {};
  for (const r of reviews) {
    outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
    for (const i of JSON.parse(r.issues) as ReviewIssue[]) issues[i.type] = (issues[i.type] ?? 0) + 1;
  }
  const orders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE created_at >= ?").get(since) as { n: number };
  const unanswered = db
    .prepare("SELECT COUNT(DISTINCT customer) AS n FROM alerts WHERE kind = 'unanswered' AND created_at >= ?")
    .get(since) as { n: number };
  return {
    day: localDay(since),
    conversations: t.conversations,
    newCustomers: t.newCustomers,
    customerMessages: t.customerMessages,
    teamMessages: t.staffMessages,
    aiReplies: t.aiReplies,
    orders: orders.n,
    handoffs: t.handoffs,
    waitingNow: waitingCustomers().length,
    unansweredAlerts: unanswered.n,
    response: responseStats(since),
    reviews: reviews.length,
    avgScore: reviews.length ? Math.round((reviews.reduce((a, r) => a + r.score, 0) / reviews.length) * 10) / 10 : null,
    issues,
    outcomes,
  };
}

const REPORT = `You are "المشرف العام" of the customer-service team of our store (selling to Libya through Meta ads and WhatsApp). Write today's report for the owner, from the numbers and the chat reviews below.

Format (plain text for Telegram, no markdown symbols like ** or #, short lines, Arabic):
📊 الخلاصة: two or three lines with the key numbers (conversations, orders, response speed, team score) and how the day went.
⚠️ أهم المشاكل: up to 5 bullets (•), most important first, each with the customer number when it is about one chat, and what to do.
👍 شو كان منيح: one or two bullets.
✅ لبكرا: up to 3 concrete actions for the team.

Be direct and specific; no generic advice. If there were no chats, say so in one line. Times are minutes. Keep it under 1200 characters.`;

let reporting = false;

export async function generateReport(): Promise<number | undefined> {
  if (reporting) return undefined;
  reporting = true;
  try {
    const since = localDayStart(0);
    const stats = dayStats(since);
    const reviews = db
      .prepare("SELECT customer, score, summary, issues FROM reviews WHERE created_at >= ? ORDER BY score ASC LIMIT 60")
      .all(since) as { customer: string; score: number; summary: string; issues: string }[];
    const reviewLines = reviews
      .map((r) => {
        const issues = (JSON.parse(r.issues) as ReviewIssue[]).map((i) => `${i.severity} ${i.type} (${i.who}): ${i.problem}`).join("; ");
        return `${customerLabel(r.customer)} · ${r.score}/5 · ${r.summary}${issues ? ` · ${issues}` : ""}`;
      })
      .join("\n");

    let text: string;
    let usage: OpenAI.CompletionUsage | undefined;
    if (process.env.OPENAI_API_KEY?.trim() && supervisorSettings().reviews) {
      client ??= new OpenAI();
      const completion = await client.chat.completions.create({
        model: config.openai.supportModel,
        reasoning_effort: "low",
        messages: [
          { role: "developer", content: REPORT },
          { role: "user", content: `Numbers (JSON):\n${JSON.stringify(stats)}\n\nChat reviews today (worst first):\n${reviewLines || "(none)"}` },
        ],
      });
      text = completion.choices[0]?.message.content?.trim() || "";
      usage = completion.usage;
    } else {
      text = "";
    }
    if (!text) {
      text = `📊 محادثات ${stats.conversations} · طلبات ${stats.orders} · رسائل الفريق ${stats.teamMessages} · نص وقت الرد ${stats.response.p50Min} د · ناطرين هلق ${stats.waitingNow}`;
    }
    const learned = learningStats(since);
    if (learned.learned || learned.pending || learned.unanswered) {
      text += `\n\n📚 التعلّم: تعلّم ${learned.learned} اليوم · ${learned.pending} درس بانتظار موافقتك · ${learned.unanswered} سؤال ما حدا جاوبو`;
    }

    const id = Number(
      db
        .prepare(
          `INSERT INTO reports (day, stats, text, prompt_tokens, cached_tokens, completion_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(day) DO UPDATE SET stats = excluded.stats, text = excluded.text, created_at = excluded.created_at,
             prompt_tokens = reports.prompt_tokens + excluded.prompt_tokens, cached_tokens = reports.cached_tokens + excluded.cached_tokens,
             completion_tokens = reports.completion_tokens + excluded.completion_tokens`,
        )
        .run(
          stats.day,
          JSON.stringify(stats),
          text,
          usage?.prompt_tokens ?? 0,
          usage?.prompt_tokens_details?.cached_tokens ?? 0,
          usage?.completion_tokens ?? 0,
          Date.now(),
        ).lastInsertRowid,
    );
    notify("report", `🗒 <b>تقرير المشرف · ${stats.day}</b>\n\n${esc(text)}\n\n${dashboardLink("/supervisor", "التفاصيل باللوحة")}`);
    log("supervisor", `daily report for ${stats.day}`);
    return id;
  } finally {
    reporting = false;
  }
}

// --- Dashboard ------------------------------------------------------------------------------------------

export function supervisorView(days: number) {
  const since = localDayStart(days - 1);
  const reviews = (
    db
      .prepare(
        `SELECT id, customer, from_id, to_id, score, outcome, summary, praise, issues, created_at FROM reviews
         WHERE created_at >= ? ORDER BY id DESC LIMIT 300`,
      )
      .all(since) as {
      id: number;
      customer: string;
      from_id: number;
      to_id: number;
      score: number;
      outcome: string;
      summary: string;
      praise: string;
      issues: string;
      created_at: number;
    }[]
  ).map((r) => ({
    id: r.id,
    customer: r.customer,
    score: r.score,
    outcome: r.outcome,
    summary: r.summary,
    praise: r.praise,
    issues: JSON.parse(r.issues) as ReviewIssue[],
    at: r.created_at,
  }));
  const issues: Record<string, { team: number; ai: number }> = {};
  for (const r of reviews) for (const i of r.issues) (issues[i.type] ??= { team: 0, ai: 0 })[i.who]++;

  const alerts = db
    .prepare(
      `SELECT id, kind, customer, severity, title, detail, created_at AS at, resolved_at AS resolvedAt FROM alerts
       WHERE created_at >= ? ORDER BY id DESC LIMIT 200`,
    )
    .all(since);
  const reports = (
    db.prepare("SELECT id, day, stats, text, created_at FROM reports ORDER BY day DESC LIMIT 30").all() as {
      id: number;
      day: string;
      stats: string;
      text: string;
      created_at: number;
    }[]
  ).map((r) => ({ id: r.id, day: r.day, stats: JSON.parse(r.stats) as DayStats, text: r.text, at: r.created_at }));

  const tokens = db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS p, COALESCE(SUM(cached_tokens), 0) AS c, COALESCE(SUM(completion_tokens), 0) AS o
       FROM (SELECT prompt_tokens, cached_tokens, completion_tokens FROM reviews WHERE created_at >= ?
             UNION ALL SELECT prompt_tokens, cached_tokens, completion_tokens FROM reports WHERE created_at >= ?)`,
    )
    .get(since, since) as { p: number; c: number; o: number };

  return {
    settings: supervisorSettings(),
    waiting: waitingCustomers(),
    response: responseStats(since),
    reviews,
    issues,
    avgScore: reviews.length ? Math.round((reviews.reduce((a, r) => a + r.score, 0) / reviews.length) * 10) / 10 : null,
    alerts,
    reports,
    unconfirmedOrders: (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'new'").get() as { n: number }).n,
    costUsd: costUsd(tokens.p, tokens.c, tokens.o, config.openai.supportModel),
  };
}

// --- Schedule ---------------------------------------------------------------------------------------------

export function startSupervisor() {
  let ticks = 0;
  const tick = async () => {
    ticks++;
    try {
      runChecks();
      if (ticks % 6 === 1) await runReviews();
      const s = supervisorSettings();
      const today = localDay(Date.now());
      if (s.enabled && localHour(Date.now()) === s.reportHour && getSetting("supervisor_report_day") !== today) {
        setSetting("supervisor_report_day", today);
        await runReviews({ max: 30 }); // include the latest chats
        await generateReport();
      }
      // The day's orders as an Excel file in the Telegram group, at the same hour (even with the supervisor off).
      await maybeSendDailySheet(s.reportHour, localHour(Date.now()));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log("supervisor", `error: ${message}`);
      notifyError("المشرف", message);
    }
  };
  setTimeout(() => void tick(), 30_000).unref();
  setInterval(() => void tick(), 5 * MINUTE).unref();
}
