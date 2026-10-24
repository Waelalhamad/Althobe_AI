// Team notifications in a Telegram group: new orders, handoffs, errors, and the supervisor's alerts and reports.
// The bot token and group are set from the dashboard (Settings); TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID work too.
import { config } from "./config.js";
import { getSetting, setSetting } from "./store.js";

export const NOTIFY_KINDS = ["order", "handoff", "error", "supervisor", "report"] as const;
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

async function call<T>(method: string, body: object, token = telegramToken()): Promise<T> {
  if (!token) throw new TelegramError("Telegram bot token is not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
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

async function send(chatId: string, html: string) {
  try {
    await call("sendMessage", { chat_id: chatId, text: html.slice(0, 4000), parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (error) {
    // A group that became a supergroup gets a new id: follow it once.
    if (error instanceof TelegramError && error.migrateTo) {
      setTelegramChat(String(error.migrateTo));
      await call("sendMessage", { chat_id: error.migrateTo, text: html.slice(0, 4000), parse_mode: "HTML" });
      return;
    }
    throw error;
  }
}

// One message at a time, so a burst of alerts stays under Telegram's group limit (20 per minute).
let queue: Promise<void> = Promise.resolve();

// Sends a notification to the team group. Never throws: a Telegram problem must not break a customer reply.
export function notify(kind: NotifyKind, html: string): void {
  const chatId = telegramChatId();
  if (!telegramToken() || !chatId || mutedKinds().includes(kind)) return;
  queue = queue
    .then(() => send(chatId, html))
    .then(() => setSetting("telegram_last", JSON.stringify({ ok: true, at: Date.now() })))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Telegram notification failed: ${message}`);
      setSetting("telegram_last", JSON.stringify({ ok: false, error: message, at: Date.now() }));
    })
    .then(() => new Promise((resolve) => setTimeout(resolve, 1100)));
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
  return customer.startsWith("cw:") ? `Instagram/Messenger #${customer.slice(3)}` : `+${customer}`;
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
  type Update = { message?: { chat: TelegramChat }; my_chat_member?: { chat: TelegramChat }; channel_post?: { chat: TelegramChat } };
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
