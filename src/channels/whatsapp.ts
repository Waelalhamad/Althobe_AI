// WhatsApp Cloud API through Dualhook or 360dialog. Webhooks use Meta's Cloud API format.
import { config } from "../config.js";
import { decideReply, type ChatTurn } from "../agent.js";
import { listCatalog, publicPhotoUrl } from "../catalog.js";
import { downloadWhatsAppMedia, fileAsDataUrl, saveFile, transcribe } from "../media.js";
import {
  attachMedia,
  getHistory,
  isAiPaused,
  lastCustomerMessageId,
  lastCustomerWamid,
  reactedMessage,
  customerBackground,
  db,
  pauseAi,
  recordAiCall,
  saveHistory,
  saveMessage,
  saveOrder,
  setSetting,
  teamPauseMinutes,
} from "../store.js";
import { aiBlockedReason } from "../settings.js";
import { log, scheduleReply } from "../scheduler.js";
import { notifyHandoff, notifyOrder, orderOneLine } from "../orders.js";
import { notifyError } from "../telegram.js";
import { noteHandoff } from "../learning.js";
import { splitAroundPhotos, splitMessages, typingPause } from "../typing.js";

const DEFAULT_HANDOFF_MESSAGE = "حاضر، لحظة نتأكدلك ونرجعلك 🙏";
const DEFAULT_ORDER_MESSAGE = "تمام، تم الحجز 🙏 شويه ونتواصلو معاك لتأكيد التوصيل";

// --- Webhook payload (Meta Cloud API format, only the fields we use) ---

type WaMessage = {
  from?: string;
  to?: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  image?: WaMedia;
  video?: WaMedia;
  document?: WaMedia & { filename?: string };
  audio?: WaMedia & { voice?: boolean };
  sticker?: WaMedia;
  // The customer edited an earlier message (Coexistence only): the new content is in edit.message.
  edit?: { original_message_id?: string; message?: Omit<WaMessage, "id"> };
  // An emoji on one of the messages in the chat (empty emoji = reaction removed).
  reaction?: { message_id?: string; emoji?: string };
  // Set when the customer tapped a click-to-WhatsApp ad: tells us which product they saw.
  referral?: { headline?: string; body?: string; source_url?: string; source_type?: string };
};

type WaMedia = { id?: string; mime_type?: string; caption?: string };

const MEDIA_TYPES = ["image", "audio", "video", "document", "sticker"] as const;

// Coexistence history sync: past chats from the WhatsApp Business app, sent once after connecting.
type HistoryChunk = {
  metadata?: { phase?: number; chunk_order?: number; progress?: number };
  threads?: { id?: string; messages?: WaMessage[] }[];
  errors?: { code?: number; title?: string }[];
};

type WebhookPayload = {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: WaMessage[];
        message_echoes?: WaMessage[];
        history?: HistoryChunk[];
      };
    }[];
  }[];
};

export function handleWhatsAppWebhook(payload: WebhookPayload) {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};

      // Webhook signatures can't be verified with Dualhook, so also ignore anything not for our number.
      const phoneNumberId = value.metadata?.phone_number_id;
      if (config.whatsapp.phoneNumberId && phoneNumberId && phoneNumberId !== config.whatsapp.phoneNumberId) {
        continue;
      }

      if (change.field === "messages") {
        for (const message of value.messages ?? []) onCustomerMessage(message);
      } else if (change.field === "smb_message_echoes") {
        // A team member replied from the WhatsApp Business app on the phone.
        for (const echo of value.message_echoes ?? []) onStaffMessage(echo);
      } else if (change.field === "history") {
        for (const chunk of value.history ?? []) onHistoryChunk(chunk);
      }
      // Other fields (statuses, smb_app_state_sync, ...) are ignored.
    }
  }
}

function onCustomerMessage(message: WaMessage) {
  const customer = message.from;
  if (!customer) return;
  if (message.type === "unsupported") return;

  // A reaction is saved with the message it was on. Only a reaction to our latest message, when that message
  // asked something (e.g. 👍 on "نأكدلك الحجز؟"), is an answer that needs a reply.
  let text = describe(message);
  let needsReply = true;
  if (message.type === "reaction") {
    const emoji = message.reaction?.emoji?.trim();
    if (!emoji) return;
    const target = message.reaction?.message_id ? reactedMessage(customer, message.reaction.message_id) : undefined;
    const quoted = target ? ` to: «${target.text.replace(/\s+/g, " ").slice(0, 200)}»` : "";
    text = `[sent a reaction ${emoji}${quoted}]`;
    needsReply = Boolean(target?.isOurLast && /[؟?]/.test(target.text));
  }

  const isNew = saveMessage({
    customer,
    role: "customer",
    source: "customer",
    text,
    wamid: message.id,
    createdAt: toMs(message.timestamp),
  });
  if (!isNew) return; // duplicate webhook delivery
  trackMedia(customer, message);

  const blocked = aiBlockedReason(customer);
  if (blocked) {
    log(`wa:${customer}`, `customer wrote; ${blocked}, not replying`);
    return;
  }
  if (isAiPaused(customer)) {
    log(`wa:${customer}`, "customer wrote; AI paused (team is handling this chat)");
    return;
  }

  if (!needsReply) {
    log(`wa:${customer}`, "customer reacted; no reply needed");
    return;
  }

  scheduleReply(`wa:${customer}`, config.debounceMs, () => respond(customer));
}

function onStaffMessage(echo: WaMessage) {
  const customer = echo.to;
  if (!customer || echo.type === "revoke" || echo.type === "edit") return;

  const isNew = saveMessage({
    customer,
    role: "business",
    source: "staff",
    text: describe(echo),
    wamid: echo.id,
    createdAt: toMs(echo.timestamp),
  });
  if (isNew) trackMedia(customer, echo); // so the dashboard shows the photos the team sent
  pauseAi(customer, "team replied from the WhatsApp Business app", teamPauseMinutes() / 60);
  log(`wa:${customer}`, `team replied from the app; AI paused for ${teamPauseMinutes()} min`);
}

// Stores past chats so the AI knows what was already said. Never replies or pauses the AI.
function onHistoryChunk(chunk: HistoryChunk) {
  for (const error of chunk.errors ?? []) {
    log("wa:history", `not shared (${error.code}): ${error.title}`);
    setSetting("history_sync", JSON.stringify({ error: error.title ?? `code ${error.code}`, at: Date.now() }));
    notifyError("استيراد المحادثات القديمة من واتساب", `${error.code}: ${error.title}`);
  }
  const messages = [];
  for (const thread of chunk.threads ?? []) {
    const customer = thread.id;
    if (!customer) continue;
    for (const message of thread.messages ?? []) {
      if (message.type === "reaction" || message.type === "unsupported" || message.type === "revoke") continue;
      // The customer's own messages have from = their number; anything else was sent by the business.
      const fromCustomer = message.from === customer;
      messages.push({
        customer,
        role: fromCustomer ? ("customer" as const) : ("business" as const),
        source: fromCustomer ? ("customer" as const) : ("staff" as const),
        text: describe(message),
        wamid: message.id,
        createdAt: toMs(message.timestamp),
      });
    }
  }
  const added = saveHistory(messages);
  const { phase, chunk_order, progress } = chunk.metadata ?? {};
  if (!chunk.errors?.length) {
    setSetting("history_sync", JSON.stringify({ phase, chunk: chunk_order, progress, at: Date.now() }));
  }
  log(
    "wa:history",
    `phase ${phase} chunk ${chunk_order}: ${chunk.threads?.length ?? 0} chats, ${added} new messages stored (sync ${progress}%)`,
  );
}

// --- Photos and voice notes ------------------------------------------------------

// Downloads still running per customer; a reply waits for them so the AI sees the photo / hears the voice note.
const pendingMedia = new Map<string, Set<Promise<void>>>();

function trackMedia(customer: string, message: WaMessage) {
  const type = MEDIA_TYPES.find((t) => t === message.type);
  const media = type && message[type];
  if (!type || !media?.id || !config.whatsapp.enabled) return;
  const job = processMedia(customer, message.id, type, media, adNote(message)).finally(() => pending.delete(job));
  const pending = pendingMedia.get(customer) ?? new Set();
  pending.add(job);
  pendingMedia.set(customer, pending);
}

async function processMedia(customer: string, wamid: string, type: (typeof MEDIA_TYPES)[number], media: WaMedia, prefix: string) {
  try {
    const { data, mime } = await downloadWhatsAppMedia(media.id!);
    const file = saveFile("media", wamid, data, media.mime_type ?? mime);
    let text = describeMedia(type, media);
    if (type === "audio") {
      const heard = await transcribe(data, media.mime_type ?? mime);
      text = heard ? `[voice note] ${heard}` : "[voice note, could not understand it]";
    }
    attachMedia(wamid, prefix + text, { type, file, mime: media.mime_type ?? mime });
  } catch (error) {
    log(`wa:${customer}`, `could not process the ${type}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function waitForMedia(customer: string) {
  const pending = pendingMedia.get(customer);
  if (pending?.size) await Promise.allSettled([...pending]);
}

// History for the AI, with the customer's recent photos attached.
export function historyForAi(customer: string): ChatTurn[] {
  return getHistory(customer).map(({ imageFile, ...turn }) => {
    const image = imageFile ? fileAsDataUrl(imageFile) : undefined;
    return image ? { ...turn, image } : turn;
  });
}

// Customers whose last message got no answer (e.g. they wrote while the AI was off or in test mode),
// still inside WhatsApp's 24-hour window. The AI answers them one by one, a few seconds apart.
// Chats the team took over are left to the team and only counted.
export function answerWaiting(): { queued: number; withTeam: number } {
  const since = Date.now() - 23 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT m.customer FROM messages m
       JOIN (SELECT customer, MAX(id) AS id FROM messages
             WHERE history = 0 AND text NOT LIKE '[sent a reaction%' GROUP BY customer) last ON last.id = m.id
       WHERE m.role = 'customer' AND m.created_at > ? AND m.customer NOT LIKE 'cw:%'
       ORDER BY m.created_at`,
    )
    .all(since) as { customer: string }[];
  let queued = 0;
  let withTeam = 0;
  for (const { customer } of rows) {
    if (aiBlockedReason(customer)) continue;
    if (isAiPaused(customer)) {
      withTeam++;
      continue;
    }
    scheduleReply(`wa:${customer}`, 1000 + queued * 3000, () => respond(customer));
    queued++;
  }
  if (queued) log("dashboard", `answering ${queued} waiting chat(s)`);
  return { queued, withTeam };
}

async function respond(customer: string) {
  // The team may have taken over while we were waiting.
  if (isAiPaused(customer)) return;

  const key = `wa:${customer}`;
  try {
    await waitForMedia(customer);
    void showTyping(customer);
    const decision = await decideReply(historyForAi(customer), {
      customerPhone: localPhone(customer),
      background: customerBackground(customer),
    });
    recordAiCall({
      customer,
      channel: "whatsapp",
      action: decision.action,
      reason:
        decision.action === "handoff"
          ? decision.reason
          : decision.action === "order"
            ? orderOneLine(decision.order)
            : undefined,
      usage: decision.usage,
    });

    if (isAiPaused(customer)) {
      log(key, "team replied while the AI was thinking; AI reply dropped");
      return;
    }

    if (decision.action === "reply") {
      // A few short messages like a person types them, with the photos where the AI put them.
      const { before: beforePhotos, after: afterPhotos } = splitAroundPhotos(decision.text, decision.photos.length > 0);
      let sent = 0;
      const sendPart = async (part: string) => {
        if (sent++ > 0) {
          await typingPause(part);
          if (isAiPaused(customer)) return; // the team jumped in
        }
        const wamid = await sendText(customer, part);
        saveMessage({ customer, role: "business", source: "ai", text: part, wamid });
      };
      for (const part of beforePhotos) await sendPart(part);
      if (decision.photos.length && !isAiPaused(customer)) {
        await sendPhotos(customer, decision.photos);
        sent++;
      }
      for (const part of afterPhotos) await sendPart(part);
      log(key, decision.photos.length ? `replied with ${decision.photos.length} photo(s)` : "replied");
    } else if (decision.action === "order") {
      // The customer confirmed: save the order, thank them, and let the team confirm it.
      // "Same number" answers come through as text; fall back to the WhatsApp number.
      if (!/\d{6,}/.test(decision.order.phone)) decision.order.phone = localPhone(customer);
      const id = saveOrder({ customer, channel: "whatsapp", ...decision.order });
      const text = decision.messageToCustomer || DEFAULT_ORDER_MESSAGE;
      const wamid = await sendText(customer, text);
      saveMessage({ customer, role: "business", source: "ai", text, wamid });
      pauseAi(customer, `AI order #${id}: waiting for the team to confirm`);
      log(key, `order #${id} collected, team must confirm: ${orderOneLine(decision.order)}`);
      notifyOrder(id, customer, decision.order);
    } else {
      if (!decision.silent) {
        const text = decision.messageToCustomer || DEFAULT_HANDOFF_MESSAGE;
        const wamid = await sendText(customer, text);
        saveMessage({ customer, role: "business", source: "ai", text, wamid });
      }
      pauseAi(customer, `AI handoff: ${decision.reason}`);
      log(key, `handed off to team: ${decision.reason}`);
      // What the team answers to a question the AI didn't know becomes a lesson to approve (learning.ts).
      if (decision.kind === "dont_know") noteHandoff(customer, decision.reason);
      notifyHandoff(customer, decision.reason, decision.kind === "dont_know");
    }
  } catch (error) {
    // Never leave the customer stuck with the bot: stop the AI so the team answers in the app.
    pauseAi(customer, "AI error");
    recordAiCall({ customer, channel: "whatsapp", action: "error", reason: errorText(error) });
    log(key, `error, AI paused for this customer: ${errorText(error)}`);
    notifyError(`المساعد ما قدر يرد على +${customer} (توقف بهالمحادثة، ردو انتو)`, errorText(error));
  }
}

// The automatic follow-up (followup.ts). Sent only if the customer hasn't written since afterId
// and the team hasn't taken over meanwhile. Returns whether anything was sent.
export async function sendFollowUp(customer: string, text: string, afterId: number): Promise<boolean> {
  const stillQuiet = () => !isAiPaused(customer) && lastCustomerMessageId(customer) === afterId;
  let sent = 0;
  for (const part of splitMessages(text)) {
    if (sent > 0) await typingPause(part);
    if (!stillQuiet()) break;
    const wamid = await sendText(customer, part);
    saveMessage({ customer, role: "business", source: "ai", text: part, wamid });
    sent++;
  }
  return sent > 0;
}

// A team member replied from the dashboard: send it and keep the AI out of this chat.
export async function sendTeamMessage(customer: string, text: string) {
  const wamid = await sendText(customer, text);
  saveMessage({ customer, role: "business", source: "staff", text, wamid });
  pauseAi(customer, "team replied from the dashboard", teamPauseMinutes() / 60);
  log(`wa:${customer}`, `team replied from the dashboard; AI paused for ${teamPauseMinutes()} min`);
}

// --- Sending (Dualhook or 360dialog; both take Meta's Cloud API message body) ---

function sendEndpoint(): { url: string; headers: Record<string, string> } {
  const wa = config.whatsapp;
  if (wa.provider === "360dialog") {
    return { url: `${wa.d360.baseUrl}/messages`, headers: { "D360-API-KEY": wa.d360.apiKey } };
  }
  if (!wa.phoneNumberId) throw new Error("WA_PHONE_NUMBER_ID is required for Dualhook");
  return {
    url: `${wa.dualhook.baseUrl}/${wa.phoneNumberId}/messages`,
    headers: { Authorization: `Bearer ${wa.dualhook.apiKey}` },
  };
}

async function sendPhotos(customer: string, ids: string[]) {
  const catalog = listCatalog();
  for (const id of ids) {
    const item = catalog.find((i) => i.id === id);
    if (!item) continue;
    const wamid = await sendMessage(customer, { type: "image", image: { link: publicPhotoUrl(item) } });
    saveMessage({
      customer,
      role: "business",
      source: "ai",
      text: `[sent product photo: ${item.name}]`,
      wamid,
      media: { type: "image", file: item.file, mime: item.mime },
    });
  }
}

function sendText(to: string, body: string) {
  return sendMessage(to, { type: "text", text: { body, preview_url: false } });
}

async function sendMessage(to: string, content: Record<string, unknown>): Promise<string | undefined> {
  const { url, headers } = sendEndpoint();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, ...content }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${config.whatsapp.provider} send failed: ${res.status} ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { messages?: { id?: string }[] };
  return data.messages?.[0]?.id;
}

// Blue ticks and "typing…" on the customer's phone while the AI thinks, like a person who opened the chat.
// Optional: if the provider doesn't support it, the reply still goes out.
let typingUnsupported = false;

async function showTyping(customer: string) {
  const messageId = lastCustomerWamid(customer);
  if (!messageId || typingUnsupported) return;
  const { url, headers } = sendEndpoint();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } }),
    });
    if (res.status === 400 || res.status === 404) {
      typingUnsupported = true;
      log("wa", `typing indicator not supported by ${config.whatsapp.provider}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    }
  } catch {}
}

// --- Helpers --------------------------------------------------------------

function describe(m: WaMessage): string {
  return adNote(m) + describeContent(m);
}

// "[from the ad: «headline» body] " so the AI (and the team) know which product the customer saw.
function adNote(m: WaMessage): string {
  const ad = m.referral;
  if (!ad) return "";
  const text = [ad.headline && `«${ad.headline.trim()}»`, ad.body?.trim().slice(0, 300)].filter(Boolean).join(" ");
  return `[from the ad${text ? `: ${text}` : ""}${ad.source_url ? ` ${ad.source_url}` : ""}] `;
}

function describeContent(m: WaMessage): string {
  switch (m.type) {
    case "text":
      return m.text?.body?.trim() || "[empty message]";
    case "button":
      return m.button?.text ?? "[button]";
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[interactive reply]";
    case "image":
    case "video":
    case "document":
    case "audio":
    case "sticker":
      return describeMedia(m.type, m[m.type] ?? {});
    case "edit":
      return m.edit?.message ? `[edited] ${describeContent({ ...m.edit.message, id: m.id })}` : "[edited a message]";
    case "media_placeholder": // history sync leaves out media contents
      return "[sent a media file]";
    default:
      return `[sent a ${m.type} message]`;
  }
}

// 218912345678 → 0912345678 (how Libyan customers write their number); other countries: +<number>.
export function localPhone(waNumber: string): string {
  return waNumber.startsWith("218") ? `0${waNumber.slice(3)}` : `+${waNumber}`;
}

function describeMedia(type: string, media: WaMedia): string {
  const caption = media.caption?.trim();
  const label = type === "audio" ? "[voice note]" : `[sent ${type === "image" ? "a photo" : `a ${type}`}]`;
  return caption ? `${label} ${caption}` : label;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toMs(timestamp?: string): number {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
}
