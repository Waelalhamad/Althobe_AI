// Team notifications in a Telegram group: new orders, handoffs, errors, and the supervisor's alerts and reports.
// The bot token and group are set from the dashboard (Settings); TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID work too.
import { config } from "./config.js";
import { getSetting, setSetting } from "./store.js";

export const NOTIFY_KINDS = ["order", "handoff", "lesson", "error", "supervisor", "report", "sheet"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export function telegramToken(): string | undefined {
  return getSetting("telegram_token") || process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
}

export function telegramChatId(): string | undefined {
  return getSetting("telegram_chat_id") || process.env.TELEGRAM_CHAT_ID?.trim() || undefined;
}

// Kinds of notifications the team turned off.
export function mutedKinds(): NotifyKind[] {
  try {
    const list = JSON.parse(getSetting("telegram_muted") ?? "[]") as unknown;
    return Array.isArray(list) ? NOTIFY_KINDS.filter((k) => list.includes(k)) : [];
  } catch {
    return [];
  }
}

export function setMutedKinds(kinds: string[]) {
  setSetting("telegram_muted", JSON.stringify(NOTIFY_KINDS.filter((k) => kinds.includes(k))));
}

export function setTelegramChat(chatId: string) {
  setSetting("telegram_chat_id", chatId);
}

// Checks the token with Telegram before saving it.
export async function setTelegramToken(token: string): Promise<TelegramBot> {
  const bot = await call<TelegramBot>("getMe", {}, token);
  setSetting("telegram_token", token);
  return bot;
}

type TelegramBot = { id: number; username: string; first_name: string };
type TelegramChat = { id: number; title?: string; type: string; username?: string };

class TelegramError extends Error {
  constructor(
    message: string,
    public migrateTo?: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, body: object, token = telegramToken(), timeoutMs = 15_000): Promise<T> {
  if (!token) throw new TelegramError("Telegram bot token is not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    result?: T;
    description?: string;
    parameters?: { migrate_to_chat_id?: number };
  };
  if (!data.ok) throw new TelegramError(data.description ?? `HTTP ${res.status}`, data.parameters?.migrate_to_chat_id);
  return data.result as T;
}

// Buttons under a message; `data` comes back to the TeamActions when someone presses it.
export type TeamButton = { text: string; data: string };

const keyboard = (buttons?: TeamButton[][]) =>
  buttons?.length ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } : undefined;

// Returns the Telegram message id.
async function send(chatId: string, html: string, buttons?: TeamButton[][], replyTo?: number): Promise<number> {
  const body = {
    text: html.slice(0, 4000),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: keyboard(buttons),
    ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
  };
  try {
    return (await call<{ message_id: number }>("sendMessage", { chat_id: chatId, ...body })).message_id;
  } catch (error) {
    // A group that became a supergroup gets a new id: follow it once.
    if (error instanceof TelegramError && error.migrateTo) {
      setTelegramChat(String(error.migrateTo));
      return (await call<{ message_id: number }>("sendMessage", { chat_id: error.migrateTo, ...body })).message_id;
    }
    throw error;
  }
}

// One message at a time, so a burst of alerts stays under Telegram's group limit (20 per minute).
let queue: Promise<void> = Promise.resolve();

// Sends a notification to the team group and resolves to its message id (undefined if not sent).
// Never throws: a Telegram problem must not break a customer reply.
export function notify(kind: NotifyKind, html: string, buttons?: TeamButton[][]): Promise<number | undefined> {
  const chatId = telegramChatId();
  if (!telegramToken() || !chatId || mutedKinds().includes(kind)) return Promise.resolve(undefined);
  let sent: number | undefined;
  const job = queue
    .then(() => send(chatId, html, buttons))
    .then((id) => {
      sent = id;
      setSetting("telegram_last", JSON.stringify({ ok: true, at: Date.now() }));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Telegram notification failed: ${message}`);
      setSetting("telegram_last", JSON.stringify({ ok: false, error: message, at: Date.now() }));
    });
  queue = job.then(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  return job.then(() => sent);
}

// Sends a file (e.g. the daily orders sheet) to the team group with an HTML caption. Never throws.
export function notifyDocument(kind: NotifyKind, file: Buffer, filename: string, caption: string): Promise<void> {
  const chatId = telegramChatId();
  const token = telegramToken();
  if (!token || !chatId || mutedKinds().includes(kind)) return Promise.resolve();
  const job = queue
    .then(async () => {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("caption", caption.slice(0, 1000));
      form.append("parse_mode", "HTML");
      form.append("document", new Blob([new Uint8Array(file)]), filename);
      const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (!data.ok) throw new TelegramError(data.description ?? `HTTP ${res.status}`);
      setSetting("telegram_last", JSON.stringify({ ok: true, at: Date.now() }));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Telegram file failed: ${message}`);
      setSetting("telegram_last", JSON.stringify({ ok: false, error: message, at: Date.now() }));
    });
  queue = job.then(() => new Promise((resolve) => setTimeout(resolve, 1100)));
  return job;
}

// Rewrites a message the bot sent to the group (e.g. a lesson card once it was approved); drops its buttons.
export async function editTeamMessage(messageId: number, html: string) {
  const chatId = telegramChatId();
  if (!chatId) return;
  try {
    await call("editMessageText", { chat_id: chatId, message_id: messageId, text: html.slice(0, 4000), parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (error) {
    console.error(`Telegram edit failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- Team actions from the group: buttons and replies to the bot's messages ----------------------

export type TeamActions = {
  // A button was pressed; returns the short text Telegram shows the person.
  onButton(data: string, messageId: number, who: string): Promise<string>;
  // Someone replied to one of the bot's messages; returns the bot's answer in the group, if any.
  onReply(replyTo: number, text: string, who: string): Promise<string | undefined>;
};

type TelegramUser = { first_name?: string; username?: string };
type Update = {
  update_id: number;
  message?: { message_id: number; chat: TelegramChat; text?: string; from?: TelegramUser; reply_to_message?: { message_id: number } };
  my_chat_member?: { chat: TelegramChat };
  channel_post?: { chat: TelegramChat };
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: { message_id: number; chat: TelegramChat } };
};

// Groups seen by the update loop, for findGroups (getUpdates can't be called twice at once).
const seenGroups = new Map<number, TelegramChat>();
let polling = false;

export function startTelegramUpdates(actions: TeamActions) {
  if (polling) return;
  polling = true;
  void (async () => {
    let offset = 0;
    for (;;) {
      if (!telegramToken()) {
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        continue;
      }
      try {
        const updates = await call<Update[]>(
          "getUpdates",
          { offset, timeout: 30, allowed_updates: ["message", "my_chat_member", "channel_post", "callback_query"] },
          undefined,
          45_000,
        );
        for (const u of updates) {
          offset = u.update_id + 1;
          await handleUpdate(u, actions).catch((error: unknown) =>
            console.error(`Telegram update failed: ${error instanceof Error ? error.message : String(error)}`),
          );
        }
      } catch (error) {
        // 409: another instance is polling (during a deploy) or a webhook is set. Wait and try again.
        console.error(`Telegram getUpdates failed: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
    }
  })();
}

async function handleUpdate(u: Update, actions: TeamActions) {
  const chat = u.message?.chat ?? u.my_chat_member?.chat ?? u.channel_post?.chat ?? u.callback_query?.message?.chat;
  if (chat && chat.type !== "private") seenGroups.set(chat.id, chat);
  const teamChat = telegramChatId();
  const who = (user?: TelegramUser) => user?.first_name || user?.username || "حدا من الفريق";

  const q = u.callback_query;
  if (q) {
    const text =
      q.message && String(q.message.chat.id) === teamChat && q.data
        ? await actions.onButton(q.data, q.message.message_id, who(q.from))
        : "هالزر بيشتغل بس بمجموعة الفريق";
    await call("answerCallbackQuery", { callback_query_id: q.id, text: text.slice(0, 190) });
    return;
  }

  const m = u.message;
  if (m?.text && m.reply_to_message && String(m.chat.id) === teamChat) {
    const answer = await actions.onReply(m.reply_to_message.message_id, m.text, who(m.from));
    if (answer) await send(teamChat, answer, undefined, m.message_id);
  }
}

// Errors repeat (the same outage hits every customer): send each one at most once per 15 minutes.
const recentErrors = new Map<string, number>();

export function notifyError(where: string, message: string) {
  const key = `${where}:${message.slice(0, 120)}`;
  const last = recentErrors.get(key);
  if (last && Date.now() - last < 15 * 60 * 1000) return;
  recentErrors.set(key, Date.now());
  notify("error", `⚠️ <b>مشكلة بالنظام</b>\n${esc(where)}\n<code>${esc(message.slice(0, 500))}</code>`);
}

export function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A link to a page of the dashboard (empty when the public address isn't known).
export function dashboardLink(path: string, label: string): string {
  return config.publicUrl ? `<a href="${config.publicUrl}/dashboard${path}">${esc(label)}</a>` : "";
}

export function customerLabel(customer: string): string {
  if (customer.startsWith("cw:")) return `Instagram/Messenger #${customer.slice(3)}`;
  // WhatsApp username without a shared number ("LY.1234…").
  if (/^[A-Z]{2}\./.test(customer)) return `بدون رقم (${customer.slice(0, 10)}…)`;
  return `+${customer}`;
}

// --- Dashboard: status, finding the group, test message ----------------------------------

export async function telegramStatus() {
  const token = telegramToken();
  const chatId = telegramChatId();
  let last: unknown = null;
  try {
    last = JSON.parse(getSetting("telegram_last") ?? "null");
  } catch {}
  const status: {
    tokenSet: boolean;
    tokenHint: string | null;
    bot: TelegramBot | null;
    chatId: string | null;
    chat: TelegramChat | null;
    error: string | null;
    muted: NotifyKind[];
    last: unknown;
  } = {
    tokenSet: Boolean(token),
    tokenHint: token ? `${token.split(":")[0]}:…${token.slice(-4)}` : null,
    bot: null,
    chatId: chatId ?? null,
    chat: null,
    error: null,
    muted: mutedKinds(),
    last,
  };
  if (!token) return status;
  try {
    status.bot = await call<TelegramBot>("getMe", {});
    if (chatId) status.chat = await call<TelegramChat>("getChat", { chat_id: chatId });
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
  }
  return status;
}

// Groups the bot was added to or got a message in (Telegram keeps these updates for 24 hours).
export async function findGroups(): Promise<TelegramChat[]> {
  if (polling) return [...seenGroups.values()];
  const updates = await call<Update[]>("getUpdates", { allowed_updates: ["message", "my_chat_member", "channel_post"], limit: 100 });
  const chats = new Map<number, TelegramChat>();
  for (const u of updates) {
    const chat = u.message?.chat ?? u.my_chat_member?.chat ?? u.channel_post?.chat;
    if (chat && chat.type !== "private") chats.set(chat.id, chat);
  }
  return [...chats.values()];
}

export async function sendTest(chatId = telegramChatId()) {
  if (!chatId) throw new TelegramError("No group chosen yet");
  await send(
    chatId,
    `✅ <b>بوت الثوب العربي شغّال</b>\nرح توصلكن هون: الطلبات الجديدة، المحادثات يلي حوّلها المساعد للفريق، الأخطاء، وملاحظات وتقارير المشرف.\n${dashboardLink("/supervisor", "فتح لوحة المشرف")}`,
  );
}
