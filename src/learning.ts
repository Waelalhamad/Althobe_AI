// Learning from the team: when the AI hands a chat over because it didn't know the answer, it watches what the
// team writes back. Once the team is done, the AI turns a general answer into a lesson ("question → answer"),
// the owner approves or edits it (dashboard or Telegram), and approved lessons go into a knowledge file, so next
// time the AI answers by itself. Nothing is learned without approval: a teammate's answer to one customer
// (a deal, a promise, an order problem) must not become a rule for everyone.
import { decideReply, writeLesson, type ChatTurn } from "./agent.js";
import { config } from "./config.js";
import { readKnowledgeFile, writeKnowledgeFile } from "./knowledge.js";
import { log } from "./scheduler.js";
import { customerBackground, db, recordAiCall } from "./store.js";
import { customerLabel, dashboardLink, editTeamMessage, esc, notify, notifyError, startTelegramUpdates, type TeamActions } from "./telegram.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// The team is "done" when it has been quiet this long after answering.
const TEAM_DONE_AFTER = 20 * MINUTE;
// A handoff nobody answered in writing for this long is shown as "unanswered" (the owner can write the answer).
const GIVE_UP_AFTER = 24 * HOUR;

export const LESSONS_FILE = "06-lessons.md";
const LESSONS_HEADER = `# دروس من الفريق
أجوبة كتبها الفريق على أسئلة ما كان المساعد يعرفها، ووافق عليها صاحب المحل. إذا شي هون بيختلف عن ملف تاني، المكتوب هون هو الأحدث.
`;

db.exec(`
  CREATE TABLE IF NOT EXISTS lessons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    customer    TEXT    NOT NULL,
    status      TEXT    NOT NULL,             -- waiting | pending | approved | ignored | skipped | unanswered | merged
    reason      TEXT    NOT NULL DEFAULT '',  -- why the AI handed off
    after_id    INTEGER NOT NULL,             -- messages.id of the chat's last message at the handoff
    question    TEXT    NOT NULL DEFAULT '',  -- the lesson, said generally
    answer      TEXT    NOT NULL DEFAULT '',
    team_reply  TEXT    NOT NULL DEFAULT '',  -- what the team wrote after the handoff
    note        TEXT    NOT NULL DEFAULT '',  -- the AI's note for the owner (why it is / isn't a lesson)
    seen        INTEGER NOT NULL DEFAULT 1,   -- how many handoffs asked the same thing
    retest      TEXT    NOT NULL DEFAULT '',  -- what the AI answers now to the original question (after approval)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS lessons_status ON lessons (status, updated_at);
`);
// The lesson's card in the Telegram group, so a button press or a reply there finds the lesson.
if (!(db.prepare("PRAGMA table_info(lessons)").all() as { name: string }[]).some((c) => c.name === "tg_message")) {
  db.exec("ALTER TABLE lessons ADD COLUMN tg_message INTEGER");
}

export type LessonStatus = "waiting" | "pending" | "approved" | "ignored" | "skipped" | "unanswered" | "merged";

export type Lesson = {
  id: number;
  customer: string;
  status: LessonStatus;
  reason: string;
  question: string;
  answer: string;
  teamReply: string;
  note: string;
  seen: number;
  retest: string;
  asked: string; // what the customer wrote just before the handoff
  createdAt: number;
  updatedAt: number;
};

type Row = {
  id: number;
  customer: string;
  status: LessonStatus;
  reason: string;
  after_id: number;
  question: string;
  answer: string;
  team_reply: string;
  note: string;
  seen: number;
  retest: string;
  tg_message: number | null;
  created_at: number;
  updated_at: number;
};

function toLesson(r: Row): Lesson {
  const asked = (
    db
      .prepare("SELECT text FROM messages WHERE customer = ? AND id <= ? AND role = 'customer' ORDER BY id DESC LIMIT 3")
      .all(r.customer, r.after_id) as { text: string }[]
  )
    .reverse()
    .map((m) => m.text)
    .join("\n");
  return {
    asked,
    id: r.id,
    customer: r.customer,
    status: r.status,
    reason: r.reason,
    question: r.question,
    answer: r.answer,
    teamReply: r.team_reply,
    note: r.note,
    seen: r.seen,
    retest: r.retest,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function setRow(id: number, fields: Partial<Omit<Row, "id">>) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE lessons SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
    ...keys.map((k) => fields[k as keyof typeof fields] as string | number),
    Date.now(),
    id,
  );
}

// Called when the AI hands a WhatsApp chat to the team because it didn't know. One open row per chat.
export function noteHandoff(customer: string, reason: string) {
  const last = db.prepare("SELECT MAX(id) AS id FROM messages WHERE customer = ?").get(customer) as { id: number | null };
  if (!last.id) return;
  const open = db.prepare("SELECT id FROM lessons WHERE customer = ? AND status = 'waiting'").get(customer) as { id: number } | undefined;
  if (open) {
    setRow(open.id, { reason, after_id: last.id });
    return;
  }
  const now = Date.now();
  db.prepare("INSERT INTO lessons (customer, status, reason, after_id, created_at, updated_at) VALUES (?, 'waiting', ?, ?, ?, ?)").run(
    customer,
    reason,
    last.id,
    now,
    now,
  );
}

type Msg = { id: number; source: string; text: string; created_at: number };

// The chat around the handoff, for the AI that writes the lesson.
function transcript(customer: string, afterId: number): string {
  const before = db
    .prepare("SELECT id, source, text, created_at FROM messages WHERE customer = ? AND id <= ? ORDER BY id DESC LIMIT 12")
    .all(customer, afterId) as Msg[];
  const after = db
    .prepare("SELECT id, source, text, created_at FROM messages WHERE customer = ? AND id > ? ORDER BY id LIMIT 30")
    .all(customer, afterId) as Msg[];
  const label = { customer: "CUSTOMER", ai: "BOT", staff: "TEAM" } as Record<string, string>;
  const line = (m: Msg) => `${label[m.source] ?? m.source.toUpperCase()}: ${m.text.replace(/\s+/g, " ").slice(0, 600)}`;
  return [...before.reverse().map(line), "--- the assistant handed the chat to the team here ---", ...after.map(line)].join("\n");
}

// The chat as the AI saw it when it handed off (text only), to try the question again after a lesson.
function historyAt(customer: string, afterId: number): ChatTurn[] {
  const rows = db
    .prepare("SELECT role, text FROM messages WHERE customer = ? AND id <= ? ORDER BY id DESC LIMIT ?")
    .all(customer, afterId, config.historyLimit) as { role: ChatTurn["role"]; text: string }[];
  const turns = rows.reverse().map((r) => ({ role: r.role, text: r.text }));
  while (turns.length && turns[turns.length - 1]!.role !== "customer") turns.pop();
  return turns;
}

let running = false;

// Every few minutes: for each handoff the team has answered and finished, ask the AI for a lesson.
export async function runLearning(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const waiting = db.prepare("SELECT * FROM lessons WHERE status = 'waiting' ORDER BY id").all() as Row[];
    for (const row of waiting) {
      const team = db
        .prepare("SELECT id, source, text, created_at FROM messages WHERE customer = ? AND id > ? AND source = 'staff' ORDER BY id")
        .all(row.customer, row.after_id) as Msg[];
      // Text the team wrote (a photo's caption counts; a photo or voice note alone doesn't).
      const written = team
        .map((m) => ({ ...m, text: m.text.replace(/^\[sent a photo\]\s*/, "") }))
        .filter((m) => m.text && !/^\[(sent|voice note)/.test(m.text));
      if (!written.length) {
        if (Date.now() - row.created_at > GIVE_UP_AFTER) {
          setRow(row.id, { status: "unanswered" });
          sendCard({ ...row, status: "unanswered" });
        }
        continue;
      }
      if (Date.now() - team[team.length - 1]!.created_at < TEAM_DONE_AFTER) continue; // still talking
      await learnFrom(row, written.map((m) => m.text).join("\n"));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("learning", `failed: ${message}`);
    notifyError("التعلّم من أجوبة الفريق", message);
  } finally {
    running = false;
  }
}

async function learnFrom(row: Row, teamReply: string) {
  const pending = db.prepare("SELECT id, question FROM lessons WHERE status = 'pending' ORDER BY id DESC LIMIT 50").all() as {
    id: number;
    question: string;
  }[];
  const { draft, usage } = await writeLesson(transcript(row.customer, row.after_id), row.reason, pending);
  recordAiCall({ customer: row.customer, channel: "whatsapp", action: "lesson", reason: draft?.note, usage });
  if (!draft) {
    setRow(row.id, { status: "skipped", team_reply: teamReply, note: "ما قدر يقرا الجواب" });
    return;
  }
  const same = draft.learnable && pending.find((p) => p.id === draft.sameAs);
  if (same) {
    db.prepare("UPDATE lessons SET seen = seen + 1, updated_at = ? WHERE id = ?").run(Date.now(), same.id);
    setRow(row.id, { status: "merged", team_reply: teamReply, note: `نفس السؤال #${same.id}` });
    log("learning", `same question as lesson #${same.id}`);
    return;
  }
  if (!draft.learnable) {
    setRow(row.id, { status: "skipped", team_reply: teamReply, note: (draft.known ? "موجود بالمعلومات: " : "") + draft.note });
    log("learning", `nothing to learn from +${row.customer}: ${draft.note}`);
    return;
  }
  setRow(row.id, { status: "pending", team_reply: teamReply, question: draft.question, answer: draft.answer, note: draft.note });
  log("learning", `new lesson #${row.id} waiting for approval: ${draft.question}`);
  sendCard({ ...row, status: "pending", question: draft.question, answer: draft.answer, note: draft.note });
}

// --- Telegram cards: approve with a button, or reply with the right answer ----------------------------

function card(row: Row): string {
  const chat = `${esc(customerLabel(row.customer))} · ${dashboardLink("/learning", "صفحة التعلّم")}`;
  if (row.status === "unanswered" || (!row.question && !row.answer)) {
    const asked = toLesson(row).asked;
    return `❓ <b>سؤال ما حدا جاوب عليه</b>\nالزبون كتب: ${esc(asked)}\n\n✍️ ردّ على هالرسالة بالجواب الصح، والمساعد بيتعلّمو.\n${chat}`;
  }
  return `📚 <b>درس جديد للمساعد</b>\nلما الزبون يسأل: ${esc(row.question)}\nالجواب: ${esc(row.answer)}\n${esc(row.note)}\n\n✍️ إذا الجواب مش مزبوط، ردّ على هالرسالة بالجواب الصح.\n${chat}`;
}

function sendCard(row: Row) {
  const buttons =
    row.status === "unanswered"
      ? [[{ text: "❌ تجاهل", data: `lesson:no:${row.id}` }]]
      : [[{ text: "✅ وافق", data: `lesson:ok:${row.id}` }, { text: "❌ تجاهل", data: `lesson:no:${row.id}` }]];
  void notify("lesson", card(row), buttons).then((messageId) => messageId && setRow(row.id, { tg_message: messageId }));
}

// After approving or ignoring (anywhere), the card says who did it and loses its buttons.
function closeCard(id: number, line: string) {
  const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as Row | undefined;
  if (row?.tg_message) void editTeamMessage(row.tg_message, `${card(row)}\n\n${esc(line)}`);
}

const OPEN: LessonStatus[] = ["pending", "unanswered"];

export const teamActions: TeamActions = {
  async onButton(data, _messageId, who) {
    const [, action, id] = data.match(/^lesson:(ok|no):(\d+)$/) ?? [];
    const row = id ? (db.prepare("SELECT * FROM lessons WHERE id = ?").get(Number(id)) as Row | undefined) : undefined;
    if (!row) return "ما لقيت هالدرس";
    if (!OPEN.includes(row.status)) return "انعمل قبل";
    if (action === "no") {
      ignoreLesson(row.id, who);
      return "تجاهلناه";
    }
    if (!row.question || !row.answer) return "ردّ على الرسالة بالجواب";
    approveLesson(row.id, row.question, row.answer, who);
    return "✅ تعلّمو المساعد";
  },

  async onReply(replyTo, text, who) {
    const row = db.prepare("SELECT * FROM lessons WHERE tg_message = ?").get(replyTo) as Row | undefined;
    if (!row) return undefined; // a reply to some other message of the bot
    if (!OPEN.includes(row.status)) return "هالدرس انعمل قبل، إذا بدك تغيّرو عدّل ملف الدروس من صفحة معلومات المساعد.";
    let question = row.question;
    let answer = text.trim();
    if (!question) {
      // A gap nobody answered: the AI words the question (and cleans the answer) from the chat and this reply.
      const { draft, usage } = await writeLesson(
        `${transcript(row.customer, row.after_id)}\nTEAM (the owner, later): ${answer}`,
        row.reason,
        [],
      );
      recordAiCall({ customer: row.customer, channel: "whatsapp", action: "lesson", reason: draft?.note, usage });
      if (!draft?.learnable || !draft.question) return "ما قدرت اطلّع منها جواب عام لكل الزباين. اكتبها من صفحة التعلّم بالداشبورد.";
      question = draft.question;
      answer = draft.answer || answer;
    }
    setRow(row.id, { team_reply: row.team_reply || text });
    const lesson = approveLesson(row.id, question, answer, who, (retested) =>
      notify("lesson", `🔁 هلق لما حدا يسأل «${esc(question)}» المساعد بيرد:\n${esc(retested)}`),
    );
    return lesson ? `✅ تعلّمو المساعد:\nلما الزبون يسأل: ${esc(question)}\nالجواب: ${esc(answer)}` : undefined;
  },
};

// --- Owner actions (dashboard) ----------------------------------------------------------------

export function lessonsView() {
  const list = (where: string, limit: number) =>
    (db.prepare(`SELECT * FROM lessons WHERE ${where} ORDER BY updated_at DESC LIMIT ?`).all(limit) as Row[]).map(toLesson);
  const count = (status: string) => (db.prepare("SELECT COUNT(*) AS n FROM lessons WHERE status = ?").get(status) as { n: number }).n;
  return {
    pending: list("status = 'pending'", 100).sort((a, b) => b.seen - a.seen),
    unanswered: list("status = 'unanswered'", 50),
    waiting: count("waiting"),
    approved: list("status = 'approved'", 50),
    done: list("status IN ('ignored', 'skipped')", 50),
  };
}

// Adds the lesson to the lessons knowledge file (the AI uses it from the next message), then asks the AI the
// original question again so the owner sees the new answer.
export function approveLesson(
  id: number,
  question: string,
  answer: string,
  who = "من اللوحة",
  onRetest?: (text: string) => void,
): Lesson | undefined {
  const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as Row | undefined;
  if (!row || !question.trim() || !answer.trim()) return undefined;
  const q = question.trim().replace(/\s+/g, " ");
  const a = answer.trim().replace(/\s+/g, " ");
  const file = readKnowledgeFile(LESSONS_FILE) ?? LESSONS_HEADER;
  writeKnowledgeFile(LESSONS_FILE, `${file.trimEnd()}\n\n- لما الزبون يسأل: ${q}\n  الجواب: ${a}\n`);
  setRow(id, { status: "approved", question: q, answer: a, retest: "" });
  log("learning", `lesson #${id} approved (${who}): ${q}`);
  closeCard(id, `✅ وافق عليه ${who}`);
  void retest(id).then((text) => text && onRetest?.(text));
  return toLesson(db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as Row);
}

export function ignoreLesson(id: number, who = "من اللوحة") {
  setRow(id, { status: "ignored" });
  log("learning", `lesson #${id} ignored (${who})`);
  closeCard(id, `❌ تجاهلو ${who}`);
}

// Returns what the AI answers now.
async function retest(id: number): Promise<string | undefined> {
  const row = db.prepare("SELECT * FROM lessons WHERE id = ?").get(id) as Row | undefined;
  if (!row) return undefined;
  const history = historyAt(row.customer, row.after_id);
  if (!history.length) return undefined;
  try {
    const decision = await decideReply(history, { background: customerBackground(row.customer) });
    const text = decision.action === "reply" ? decision.text : decision.action === "order" ? decision.messageToCustomer : `(لسا بيحوّل للفريق: ${decision.reason})`;
    const clean = text.replace(/^\s*\[photos\]\s*$/gim, "[صور]").trim();
    setRow(id, { retest: clean });
    return clean;
  } catch (error) {
    setRow(id, { retest: `(ما قدر يجرّب: ${error instanceof Error ? error.message : String(error)})` });
    return undefined;
  }
}

// For the daily report.
export function learningStats(since: number) {
  const n = (sql: string, ...args: number[]) => (db.prepare(sql).get(...args) as { n: number }).n;
  return {
    learned: n("SELECT COUNT(*) AS n FROM lessons WHERE status = 'approved' AND updated_at >= ?", since),
    pending: n("SELECT COUNT(*) AS n FROM lessons WHERE status = 'pending'"),
    unanswered: n("SELECT COUNT(*) AS n FROM lessons WHERE status = 'unanswered'"),
  };
}

export function startLearning() {
  if (!config.whatsapp.enabled) return;
  setInterval(() => void runLearning(), 5 * MINUTE).unref();
  startTelegramUpdates(teamActions);
}
