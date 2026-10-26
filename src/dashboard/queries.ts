// Read-only numbers for the dashboard. Imported chat history (history = 1) never counts in the stats.
import { aiCostUsd, config } from "../config.js";
import { db } from "../store.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const tzMs = () => config.dashboard.timezoneOffsetHours * HOUR;

// Start of the local day (dashboard timezone), `daysAgo` days back.
export function localDayStart(daysAgo: number): number {
  const now = Date.now() + tzMs();
  return now - (now % DAY) - daysAgo * DAY - tzMs();
}

export function localDay(ms: number): string {
  return new Date(ms + tzMs()).toISOString().slice(0, 10);
}

type Totals = {
  conversations: number;
  newCustomers: number;
  customerMessages: number;
  staffMessages: number;
  aiReplies: number;
  handoffs: number;
  orders: number;
  teamOrders?: number;
  errors: number;
  aiConversations: number;
  aiOnlyConversations: number;
  costUsd: number;
  tokens: { prompt: number; cached: number; completion: number; reasoning: number };
  latency: { avgMs: number; p50Ms: number; p90Ms: number };
};

// At the given model's price (the main model by default).
export function costUsd(prompt: number, cached: number, completion: number, model = config.openai.model): number {
  return aiCostUsd(model, prompt, cached, completion);
}

export function totals(since: number): Totals {
  const msg = db
    .prepare(
      `SELECT
         COUNT(DISTINCT CASE WHEN source = 'customer' THEN customer END) AS conversations,
         SUM(source = 'customer') AS customerMessages,
         SUM(source = 'staff') AS staffMessages
       FROM messages WHERE history = 0 AND created_at >= ?`,
    )
    .get(since) as { conversations: number; customerMessages: number | null; staffMessages: number | null };

  const newCustomers = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT customer FROM messages WHERE source = 'customer' GROUP BY customer HAVING MIN(created_at) >= ?
       )`,
    )
    .get(since) as { n: number };

  const ai = db
    .prepare(
      `SELECT
         SUM(action = 'reply') AS replies, SUM(action = 'handoff') AS handoffs, SUM(action = 'error') AS errors,
         SUM(action = 'order') AS orders, COUNT(DISTINCT customer) AS conversations,
         SUM(prompt_tokens) AS prompt, SUM(cached_tokens) AS cached,
         SUM(completion_tokens) AS completion, SUM(reasoning_tokens) AS reasoning, SUM(cost_usd) AS cost
       FROM ai_calls WHERE created_at >= ?`,
    )
    .get(since) as Record<string, number | null>;

  // Conversations the AI handled with no handoff and no error, and either took an order
  // (the team only confirms it) or needed no team message at all.
  const aiOnly = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT customer, SUM(action = 'order') AS orders FROM ai_calls WHERE created_at >= ? GROUP BY customer
         HAVING SUM(action IN ('handoff', 'error')) = 0
       ) a
       WHERE a.orders > 0 OR NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.customer = a.customer AND m.source = 'staff' AND m.history = 0 AND m.created_at >= ?
       )`,
    )
    .get(since, since) as { n: number };

  const latencies = (
    db
      .prepare("SELECT latency_ms AS l FROM ai_calls WHERE created_at >= ? AND action != 'error' ORDER BY l")
      .all(since) as { l: number }[]
  ).map((r) => r.l);
  const pick = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))] ?? 0;

  // Orders the team recorded from the dashboard (sales they closed themselves).
  const teamOrders = db.prepare("SELECT COUNT(*) AS n FROM orders WHERE source = 'team' AND created_at >= ?").get(since) as { n: number };

  const prompt = ai.prompt ?? 0;
  const cached = ai.cached ?? 0;
  const completion = ai.completion ?? 0;
  return {
    conversations: msg.conversations ?? 0,
    newCustomers: newCustomers.n,
    customerMessages: msg.customerMessages ?? 0,
    staffMessages: msg.staffMessages ?? 0,
    aiReplies: ai.replies ?? 0,
    handoffs: ai.handoffs ?? 0,
    orders: ai.orders ?? 0,
    teamOrders: teamOrders.n,
    errors: ai.errors ?? 0,
    aiConversations: ai.conversations ?? 0,
    aiOnlyConversations: aiOnly.n,
    costUsd: ai.cost ?? 0,
    tokens: { prompt, cached, completion, reasoning: ai.reasoning ?? 0 },
    latency: {
      avgMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      p50Ms: pick(0.5),
      p90Ms: pick(0.9),
    },
  };
}

export function overview(days: number) {
  const since = localDayStart(days - 1);
  const offsetSec = config.dashboard.timezoneOffsetHours * 3600;

  // One row per local day, with empty days filled in.
  const daily = new Map<string, Record<string, number>>();
  for (let i = days - 1; i >= 0; i--) {
    daily.set(localDay(localDayStart(i)), {
      conversations: 0, customerMessages: 0, staffMessages: 0, aiReplies: 0, handoffs: 0, orders: 0, errors: 0, costUsd: 0,
    });
  }
  const msgRows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000 + ${offsetSec}, 'unixepoch') AS day,
         COUNT(DISTINCT CASE WHEN source = 'customer' THEN customer END) AS conversations,
         SUM(source = 'customer') AS customerMessages, SUM(source = 'staff') AS staffMessages
       FROM messages WHERE history = 0 AND created_at >= ? GROUP BY day`,
    )
    .all(since) as { day: string; conversations: number; customerMessages: number; staffMessages: number }[];
  for (const r of msgRows) Object.assign(daily.get(r.day) ?? {}, r);

  const aiRows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000 + ${offsetSec}, 'unixepoch') AS day,
         SUM(action = 'reply') AS aiReplies, SUM(action = 'handoff') AS handoffs, SUM(action = 'error') AS errors,
         SUM(action = 'order') AS orders,
         SUM(cost_usd) AS cost
       FROM ai_calls WHERE created_at >= ? GROUP BY day`,
    )
    .all(since) as {
    day: string;
    aiReplies: number;
    handoffs: number;
    orders: number;
    errors: number;
    cost: number;
  }[];
  for (const r of aiRows) {
    const row = daily.get(r.day);
    if (!row) continue;
    row.aiReplies = r.aiReplies;
    row.handoffs = r.handoffs;
    row.orders = r.orders;
    row.errors = r.errors;
    row.costUsd = r.cost ?? 0;
  }
  // The chart's orders line counts the team's orders too.
  const teamRows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000 + ${offsetSec}, 'unixepoch') AS day, COUNT(*) AS n
       FROM orders WHERE source = 'team' AND created_at >= ? GROUP BY day`,
    )
    .all(since) as { day: string; n: number }[];
  for (const r of teamRows) {
    const row = daily.get(r.day);
    if (row) row.orders = (row.orders ?? 0) + r.n;
  }

  // Customer messages per local hour of day, to see when the ads bring people in.
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, customerMessages: 0 }));
  const hourRows = db
    .prepare(
      `SELECT CAST(strftime('%H', created_at / 1000 + ${offsetSec}, 'unixepoch') AS INTEGER) AS hour, COUNT(*) AS n
       FROM messages WHERE history = 0 AND source = 'customer' AND created_at >= ? GROUP BY hour`,
    )
    .all(since) as { hour: number; n: number }[];
  for (const r of hourRows) if (hourly[r.hour]) hourly[r.hour]!.customerMessages = r.n;

  const recentHandoffs = db
    .prepare(
      `SELECT customer, channel, action, reason, created_at AS at FROM ai_calls
       WHERE action IN ('handoff', 'error') AND created_at >= ? ORDER BY id DESC LIMIT 15`,
    )
    .all(since);

  return {
    days,
    since,
    today: totals(localDayStart(0)),
    period: totals(since),
    daily: [...daily.entries()].map(([day, v]) => ({ day, ...v })),
    hourly,
    recentHandoffs,
  };
}

export type ConversationFilter = "all" | "unanswered" | "ai" | "paused" | "handoff";

// WhatsApp conversations, newest activity first.
export function conversations(opts: { filter: ConversationFilter; q: string; limit: number }) {
  const now = Date.now();
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.q) {
    where.push(
      "(c.customer LIKE ? OR EXISTS (SELECT 1 FROM messages s WHERE s.customer = c.customer AND s.text LIKE ?))",
    );
    params.push(`%${opts.q}%`, `%${opts.q}%`);
  }
  if (opts.filter === "unanswered") {
    where.push("c.last_source = 'customer'");
  } else if (opts.filter === "ai") {
    where.push("(p.until IS NULL OR p.until <= ?)");
    params.push(now);
  } else if (opts.filter === "paused") {
    where.push("p.until > ?");
    params.push(now);
  } else if (opts.filter === "handoff") {
    where.push("p.until > ? AND p.reason LIKE 'AI %'");
    params.push(now);
  }

  const rows = db
    .prepare(
      `WITH last AS (
         -- The last live message; imported history can arrive late with a higher id.
         SELECT customer, COALESCE(MAX(CASE WHEN history = 0 THEN id END), MAX(id)) AS last_id,
           COUNT(*) AS total, MAX(created_at) AS last_at
         FROM messages GROUP BY customer
       ),
       c AS (
         SELECT l.customer, l.total, l.last_at, m.text AS last_text, m.source AS last_source
         FROM last l JOIN messages m ON m.id = l.last_id
       )
       SELECT c.*, p.until AS paused_until, p.reason AS pause_reason
       FROM c LEFT JOIN pauses p ON p.customer = c.customer
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY c.last_at DESC LIMIT ?`,
    )
    .all(...params, opts.limit) as Record<string, unknown>[];

  return rows.map((r) => ({
    customer: r.customer as string,
    total: r.total as number,
    lastAt: r.last_at as number,
    lastText: r.last_text as string,
    lastSource: r.last_source as string,
    pausedUntil: (r.paused_until as number | null) && (r.paused_until as number) > now ? (r.paused_until as number) : null,
    pauseReason: (r.paused_until as number | null) && (r.paused_until as number) > now ? (r.pause_reason as string) : null,
  }));
}

export function conversation(customer: string) {
  const messages = (
    db
      .prepare(
        `SELECT id, role, source, text, created_at AS at, history, media_type AS mediaType, media_file AS mediaFile
         FROM messages WHERE customer = ?
         ORDER BY history ASC, CASE WHEN history = 1 THEN created_at ELSE id END DESC, id DESC LIMIT 500`,
      )
      .all(customer) as {
        id: number;
        role: string;
        source: string;
        text: string;
        at: number;
        history: number;
        mediaType: string | null;
        mediaFile: string | null;
      }[]
  ).reverse();
  const aiCalls = db
    .prepare(
      `SELECT action, reason, latency_ms AS latencyMs, prompt_tokens AS promptTokens,
         completion_tokens AS completionTokens, created_at AS at
       FROM ai_calls WHERE customer = ? ORDER BY id DESC LIMIT 100`,
    )
    .all(customer);
  const pause = db.prepare("SELECT until, reason FROM pauses WHERE customer = ?").get(customer) as
    | { until: number; reason: string }
    | undefined;
  // Meta only allows free-form replies within 24 hours of the customer's last message.
  const lastCustomer = db
    .prepare("SELECT MAX(created_at) AS at FROM messages WHERE customer = ? AND source = 'customer'")
    .get(customer) as { at: number | null };
  return {
    customer,
    messages,
    aiCalls,
    pausedUntil: pause && pause.until > Date.now() ? pause.until : null,
    pauseReason: pause && pause.until > Date.now() ? pause.reason : null,
    windowOpenUntil: lastCustomer.at ? lastCustomer.at + DAY : null,
  };
}

export function events(opts: { q: string; limit: number }) {
  return db
    .prepare(
      `SELECT id, conversation, message, created_at AS at FROM events
       ${opts.q ? "WHERE conversation LIKE ? OR message LIKE ?" : ""}
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...(opts.q ? [`%${opts.q}%`, `%${opts.q}%`, opts.limit] : [opts.limit]));
}

// Every handoff and AI error, newest first, with the chat's current state.
export function handoffs(days: number) {
  const now = Date.now();
  return (
    db
      .prepare(
        `SELECT a.id, a.customer, a.channel, a.action, a.reason, a.created_at AS at, p.until AS paused_until
         FROM ai_calls a LEFT JOIN pauses p ON p.customer = a.customer
         WHERE a.action IN ('handoff', 'error') AND a.created_at >= ? ORDER BY a.id DESC LIMIT 500`,
      )
      .all(localDayStart(days - 1)) as { id: number; customer: string; channel: string; action: string; reason: string | null; at: number; paused_until: number | null }[]
  ).map(({ paused_until, ...h }) => ({ ...h, stillWithTeam: Boolean(paused_until && paused_until > now) }));
}

// Orders the AI collected, newest first, with how many there are per status.
export function orders(opts: { status: string | undefined; limit: number }) {
  const rows = db
    .prepare(
      `SELECT id, customer, channel, name, phone, city, address, items, total, notes, status, source,
         created_at AS createdAt, updated_at AS updatedAt
       FROM orders ${opts.status ? "WHERE status = ?" : ""} ORDER BY id DESC LIMIT ?`,
    )
    .all(...(opts.status ? [opts.status, opts.limit] : [opts.limit])) as (Record<string, unknown> & { items: string })[];
  const counts = Object.fromEntries(
    (db.prepare("SELECT status, COUNT(*) AS n FROM orders GROUP BY status").all() as { status: string; n: number }[]).map(
      (r) => [r.status, r.n],
    ),
  );
  return { counts, orders: rows.map((r) => ({ ...r, items: JSON.parse(r.items) as unknown })) };
}
