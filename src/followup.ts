// Automatic follow-up: one gentle message to a WhatsApp customer who went quiet after the AI's last reply.
// Research and our own chats say the first follow-up brings most of the extra replies and more becomes pushy
// (docs/sales-research.md), so it is sent at most once per customer message, only:
// - when the AI may answer this customer (AI replies on, test numbers, not paused by the team);
// - inside working hours (the supervisor's) and WhatsApp's 24-hour window;
// - when the AI judges a follow-up fits the chat (it answers SKIP otherwise).
import { writeFollowUp } from "./agent.js";
import { config } from "./config.js";
import { channelOf, customerBackground, db, getSetting, isAiPaused, recordAiCall, setSetting } from "./store.js";
import { aiBlockedReason } from "./settings.js";
import { inWorkingHours } from "./supervisor.js";
import { log } from "./scheduler.js";
import { notifyError } from "./telegram.js";
import { historyForAi, localPhone, sendFollowUp } from "./channels/whatsapp.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// WhatsApp only allows free-form messages within 24 hours of the customer's last message; keep a margin.
const WINDOW = 23 * HOUR;

db.exec(`
  -- One row per follow-up decision; after_id (the customer's last message) stops a second one.
  CREATE TABLE IF NOT EXISTS followups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer    TEXT    NOT NULL,
    after_id    INTEGER NOT NULL UNIQUE,   -- messages.id of the customer's message we followed up on
    sent        INTEGER NOT NULL,          -- 1 = sent, 0 = the AI said it didn't fit (SKIP)
    text        TEXT    NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS followups_created ON followups (created_at);
`);

export type FollowUpSettings = { enabled: boolean; afterMinutes: number };

const DEFAULTS: FollowUpSettings = { enabled: true, afterMinutes: 150 };

export function followUpSettings(): FollowUpSettings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(getSetting("followup") ?? "{}") as Partial<FollowUpSettings>) };
  } catch {
    return DEFAULTS;
  }
}

export function saveFollowUpSettings(patch: Record<string, unknown>): FollowUpSettings {
  const next = followUpSettings();
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  const minutes = Math.round(Number(patch.afterMinutes));
  if (patch.afterMinutes !== undefined && Number.isFinite(minutes) && minutes >= 30 && minutes <= 20 * 60) {
    next.afterMinutes = minutes;
  }
  setSetting("followup", JSON.stringify(next));
  return next;
}

type Candidate = { customer: string; afterId: number; customerAt: number; ourAt: number };

// Chats where our last live message is the AI's, old enough, and the customer wrote within the window.
function candidates(s: FollowUpSettings): Candidate[] {
  const now = Date.now();
  return db
    .prepare(
      `SELECT m.customer,
         (SELECT MAX(id) FROM messages WHERE customer = m.customer AND role = 'customer' AND history = 0) AS afterId,
         (SELECT MAX(created_at) FROM messages WHERE customer = m.customer AND role = 'customer' AND history = 0) AS customerAt,
         m.created_at AS ourAt
       FROM messages m
       JOIN (SELECT customer, MAX(id) AS id FROM messages
             WHERE history = 0 AND created_at > ? AND text NOT LIKE '[sent a reaction%'
             GROUP BY customer) last ON last.id = m.id
       WHERE m.source = 'ai' AND m.created_at <= ? AND m.customer NOT LIKE 'cw:%'`,
    )
    .all(now - WINDOW, now - s.afterMinutes * MINUTE)
    .filter((r) => {
      const c = r as Candidate;
      return c.afterId && c.customerAt > now - WINDOW && !db.prepare("SELECT 1 FROM followups WHERE after_id = ?").get(c.afterId);
    }) as Candidate[];
}

let running = false;

export async function runFollowUps(): Promise<number> {
  const s = followUpSettings();
  if (!s.enabled || running || !inWorkingHours(Date.now())) return 0;
  running = true;
  let sent = 0;
  try {
    for (const c of candidates(s)) {
      if (aiBlockedReason(c.customer) || isAiPaused(c.customer)) continue;
      const key = `wa:${c.customer}`;
      try {
        const silentHours = Math.max(1, Math.round((Date.now() - c.ourAt) / HOUR));
        const { text, stage, usage } = await writeFollowUp(historyForAi(c.customer), {
          customerPhone: localPhone(c.customer),
          background: customerBackground(c.customer),
          silentHours,
        });
        recordAiCall({ customer: c.customer, channel: channelOf(c.customer), action: "followup", reason: text ? "sent" : `skipped (${stage ?? "no answer"})`, usage });
        // Claim it first, so a crash or a second server never sends it twice.
        db.prepare("INSERT OR IGNORE INTO followups (customer, after_id, sent, text, created_at) VALUES (?, ?, ?, ?, ?)").run(
          c.customer, c.afterId, text ? 1 : 0, text ?? "", Date.now(),
        );
        if (!text) {
          log(key, `follow-up skipped: doesn't fit this chat (${stage ?? "no answer"})`);
          continue;
        }
        if (await sendFollowUp(c.customer, text, c.afterId)) {
          sent++;
          log(key, `follow-up sent after ${silentHours}h of silence`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(key, `follow-up failed: ${message}`);
        notifyError("رسالة المتابعة التلقائية", message);
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

// For the dashboard: follow-ups in the last `days` days and how many customers answered after one.
export function followUpStats(days = 7) {
  const since = Date.now() - days * 24 * HOUR;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sent,
         SUM(EXISTS (SELECT 1 FROM messages m WHERE m.customer = f.customer AND m.role = 'customer'
                     AND m.history = 0 AND m.created_at > f.created_at)) AS replied
       FROM followups f WHERE f.sent = 1 AND f.created_at >= ?`,
    )
    .get(since) as { sent: number; replied: number | null };
  const skipped = db.prepare("SELECT COUNT(*) AS n FROM followups WHERE sent = 0 AND created_at >= ?").get(since) as { n: number };
  return { days, sent: row.sent, replied: row.replied ?? 0, skipped: skipped.n };
}

export function startFollowUps() {
  if (!config.whatsapp.enabled) return;
  setInterval(() => void runFollowUps(), 5 * MINUTE).unref();
}
