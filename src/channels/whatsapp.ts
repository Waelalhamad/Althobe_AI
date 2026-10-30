// WhatsApp Cloud API through Dualhook or 360dialog. Webhooks use Meta's Cloud API format.
// The conversation part (receiving, waiting for more messages, the AI's reply, team pauses, orders) is shared
// with Messenger and Instagram (meta.ts): sending goes to the customer's channel.
import crypto from "node:crypto";
import path from "node:path";
import { config } from "../config.js";
import { addressGaps, checkPhoto, decideReply, MAP_LINK, type ChatTurn } from "../agent.js";
import { listCatalog, publicPhotoUrl } from "../catalog.js";
import { downloadWhatsAppMedia, fileAsDataUrl, saveFile, transcribe } from "../media.js";
import {
  attachMedia,
  channelOf,
  getHistory,
  isAiPaused,
  lastCustomerMessageId,
  lastCustomerWamid,
  reactedMessage,
  customerBackground,
  db,
  pauseAi,
  recordAiCall,
  contactName,
  saveContact,
  saveHistory,
  saveMessage,
  saveOrder,
  findSameOrder,
  updateOrderLocation,
  setSetting,
  teamPauseMinutes,
} from "../store.js";
import { aiBlockedReason } from "../settings.js";
import { log, scheduleReply } from "../scheduler.js";
import { notifyHandoff, notifyOrder, orderOneLine } from "../orders.js";
import { customerLabel, dashboardLink, esc, notify, notifyError } from "../telegram.js";
import { isMetaCustomer, metaSendImage, metaSendText, metaTyping } from "./meta.js";
import { noteHandoff } from "../learning.js";
import { missingStock } from "../stock.js";
import { trackingNote } from "../darbTrack.js";
import { setShipmentLocation } from "../darb.js";

// Darb's statuses in the team's words (Telegram).
const DARB_STATUS_AR: Record<string, string> = {
  processing: "عالطريق",
  "on-branch": "بفرع المدينة",
  resent: "انبعتت من جديد",
  delayed: "متأخرة",
  completed: "انسلمت",
  released: "انسلمت",
  returning: "راجعة",
  returned: "رجعت",
  cancelled: "ملغية",
};
import { splitAroundPhotos, splitMessages, typingPause } from "../typing.js";

const DEFAULT_HANDOFF_MESSAGE = "حاضر استاذ 🙏";
const DEFAULT_ORDER_MESSAGE = "تم الحجز استاذ 🙏 الفريق يتواصل معاك لتأكيد موعد التوصيل. ترجع بسلامة.";

// --- Webhook payload (Meta Cloud API format, only the fields we use) ---

type WaMessage = {
  from?: string;
  to?: string;
  // WhatsApp usernames: a customer who hides their number comes with a user id ("LY.1234…") instead of `from` / `to`.
  from_user_id?: string;
  to_user_id?: string;
  recipient_user_id?: string;
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
  // A pin the customer shared from WhatsApp's location button.
  location?: { latitude?: number; longitude?: number; name?: string; address?: string; url?: string };
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
        // Who wrote: wa_id is the number; user_id when they write from a username without sharing it.
        contacts?: { wa_id?: string; user_id?: string; username?: string; profile?: { name?: string } }[];
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
        for (const contact of value.contacts ?? []) {
          const customer = contact.wa_id ?? contact.user_id;
          if (customer) saveContact(customer, contact.profile?.name, contact.username);
        }
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
  const customer = message.from ?? message.from_user_id;
  if (!customer) return;
  if (message.type === "unsupported") return;
  receiveCustomerMessage({
    customer,
    id: message.id,
    text: describe(message),
    createdAt: toMs(message.timestamp),
    isText: message.type === "text",
    reaction: message.type === "reaction" ? { emoji: message.reaction?.emoji, messageId: message.reaction?.message_id } : undefined,
    media: waMediaJob(message),
    mediaPrefix: adNote(message),
  });
}

// A customer message from any channel. reaction: an emoji on one of the chat's messages (messageId);
// media: a photo / voice note to download and describe for the AI.
export type IncomingMessage = {
  customer: string;
  id: string;
  text: string;
  createdAt: number;
  isText?: boolean;
  reaction?: { emoji?: string; messageId?: string };
  media?: MediaJob;
  mediaPrefix?: string;
};

export function receiveCustomerMessage(message: IncomingMessage) {
  const { customer } = message;
  // A reaction is saved with the message it was on. Only a reaction to our latest message, when that message
  // asked something (e.g. 👍 on "نأكدلك الحجز؟"), is an answer that needs a reply.
  let text = message.text;
  let needsReply = true;
  if (message.reaction) {
    const emoji = message.reaction.emoji?.trim();
    if (!emoji) return;
    const target = message.reaction.messageId ? reactedMessage(customer, message.reaction.messageId) : undefined;
    const quoted = target ? ` to: «${target.text.replace(/\s+/g, " ").slice(0, 200)}»` : "";
    text = `[sent a reaction ${emoji}${quoted}]`;
    needsReply = Boolean(target?.isOurLast && /[؟?]/.test(target.text));
  } else if (message.isText && isAcknowledgement(text) && !weAskedSomething(customer)) {
    // "تمام" / "شكرا" to a message of ours that asked nothing: a seller doesn't answer it with another "تمام".
    needsReply = false;
  }

  const isNew = saveMessage({
    customer,
    role: "customer",
    source: "customer",
    text,
    wamid: message.id,
    createdAt: message.createdAt,
  });
  if (!isNew) return; // duplicate webhook delivery
  if (message.media) trackMedia(customer, message.id, message.media, message.mediaPrefix ?? "", true);
  locationForOpenOrder(customer, text);
  if (message.media?.type === "image") receiptForTeam(customer);

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
    log(`wa:${customer}`, message.reaction ? "customer reacted; no reply needed" : "customer only acknowledged; no reply needed");
    return;
  }

  scheduleReply(`wa:${customer}`, config.debounceMs, () => respond(customer));
}

// Words that only acknowledge or thank, in how our customers write them.
const ACK_WORDS = new Set(
  "تمام تمم تم اوكي اوك اوكيه ok okay okey k حاضر ماشي طيب باهي هكي زين خلاص تسلم تسلمي تسلمو يسلمو يسلموا مشكور مشكورين مشكوره شكرا يعطيك العافيه الله يسلمك يبارك فيك بارك ان شاء انشاء انشالله ان‌شاءالله استاذ اخي خوي يا حبيبي".split(" "),
);

// "تمام", "شكرا استاذ", "تماااام 👍", or only emojis.
export function isAcknowledgement(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[\u064B-\u0652\u0640]/g, "") // harakat, tatweel
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/(.)\1{2,}/gu, "$1") // تماااام
    .replace(/(.)\1+$/u, "$1") // تمامم
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return /\p{Extended_Pictographic}/u.test(text);
  return words.length <= 6 && words.every((w) => ACK_WORDS.has(w));
}

// Does the chat wait for the customer's answer? Looks at our last messages (those after the customer message
// before them). If the customer wrote more than acknowledgements since, or we never wrote, the AI decides.
// Our "we'll check and come back" promise: the customer's "تمام" or 👍 to it still waits for the answer.
const PROMISE = /نتأكدلك|نتاكدلك|نرجعلك|نشوفلك|نخبرك/;

function weAskedSomething(customer: string): boolean {
  const rows = db
    .prepare(
      `SELECT role, text FROM messages WHERE customer = ? AND history = 0 AND text NOT LIKE '[sent a reaction%'
       ORDER BY id DESC LIMIT 20`,
    )
    .all(customer) as { role: string; text: string }[];
  const lastOurs = rows.findIndex((m) => m.role === "business");
  if (lastOurs < 0) return true;
  if (rows.slice(0, lastOurs).some((m) => !isAcknowledgement(m.text))) return true;
  const ours = rows.slice(lastOurs);
  const end = ours.findIndex((m) => m.role !== "business");
  return (end < 0 ? ours : ours.slice(0, end)).some((m) => /[؟?]/.test(m.text) || PROMISE.test(m.text));
}

function onStaffMessage(echo: WaMessage) {
  const customer = echo.to ?? echo.to_user_id ?? echo.recipient_user_id;
  if (!customer || echo.type === "revoke" || echo.type === "edit") return;
  receiveStaffMessage({
    customer,
    id: echo.id,
    text: describe(echo),
    createdAt: toMs(echo.timestamp),
    media: waMediaJob(echo),
    from: "the WhatsApp Business app",
  });
}

// A team member wrote to the customer outside the dashboard (from: where): the AI steps back.
export function receiveStaffMessage(m: { customer: string; id: string; text: string; createdAt: number; media?: MediaJob; from: string }) {
  const isNew = saveMessage({ customer: m.customer, role: "business", source: "staff", text: m.text, wamid: m.id, createdAt: m.createdAt });
  if (isNew && m.media) trackMedia(m.customer, m.id, m.media, ""); // so the dashboard shows the photos the team sent
  pauseAi(m.customer, `team replied from ${m.from}`, teamPauseMinutes() / 60);
  log(`wa:${m.customer}`, `team replied from ${m.from}; AI paused for ${teamPauseMinutes()} min`);
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
      const fromCustomer = (message.from ?? message.from_user_id) === customer;
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

// A photo, voice note, ... to fetch from the customer's channel.
export type MediaJob = { type: (typeof MEDIA_TYPES)[number]; mime?: string; caption?: string; download: () => Promise<{ data: Buffer; mime: string }> };

function waMediaJob(message: WaMessage): MediaJob | undefined {
  const type = MEDIA_TYPES.find((t) => t === message.type);
  const media = type && message[type];
  if (!type || !media?.id || !config.whatsapp.enabled) return undefined;
  return { type, mime: media.mime_type, caption: media.caption, download: () => downloadWhatsAppMedia(media.id!) };
}

// fromCustomer: a product photo the customer sent is checked against our current products (old ads, other stores).
function trackMedia(customer: string, wamid: string, media: MediaJob, prefix: string, fromCustomer = false) {
  const job = processMedia(customer, wamid, media, prefix, fromCustomer).finally(() => pending.delete(job));
  const pending = pendingMedia.get(customer) ?? new Set();
  pending.add(job);
  pendingMedia.set(customer, pending);
}

async function processMedia(customer: string, wamid: string, media: MediaJob, prefix: string, fromCustomer: boolean) {
  const { type } = media;
  try {
    const download = await media.download();
    const mime = media.mime ?? download.mime;
    const file = saveFile("media", wamid, download.data, mime);
    let text = describeMedia(type, media);
    if (type === "audio") {
      const heard = await transcribe(download.data, mime);
      text = heard ? `[voice note] ${heard}` : "[voice note, could not understand it]";
    }
    if (type === "image" && fromCustomer) {
      try {
        const image = fileAsDataUrl(file, mime);
        const check = image ? await checkPhoto(image) : undefined;
        if (check?.usage.promptTokens) recordAiCall({ customer, channel: channelOf(customer), action: "photo", reason: check.note, usage: check.usage });
        if (check?.note) text = `${text} ${check.note}`;
      } catch (error) {
        log(`wa:${customer}`, `photo not checked: ${errorText(error)}`);
      }
    }
    attachMedia(wamid, prefix + text, { type, file, mime });
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

// After the AI is turned back on for a chat: if the customer's last message is still unanswered, answer it.
export function answerIfWaiting(customer: string): boolean {
  const last = db
    .prepare(
      `SELECT role, text, created_at FROM messages WHERE customer = ? AND history = 0 AND text NOT LIKE '[sent a reaction%'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(customer) as { role: string; text: string; created_at: number } | undefined;
  // Our last word was a promise to come back (the customer may have only reacted to it): the answer is still owed.
  const owed = last?.role === "customer" || (last?.role === "business" && PROMISE.test(last.text));
  if (!last || !owed || last.created_at < Date.now() - 23 * 60 * 60 * 1000) return false;
  if (aiBlockedReason(customer) || isAiPaused(customer)) return false;
  // "تمام" to the team's "تم تثبيت الطلب": nothing to answer.
  if (!weAskedSomething(customer) && waitingAreAcknowledgements(customer)) return false;
  scheduleReply(`wa:${customer}`, 1000, () => respond(customer));
  return true;
}

// A handoff pause that ran out while the customer still waited (nobody from the team answered): the AI answers,
// if still inside WhatsApp's 24-hour window. Checked every few minutes for pauses that ended since the last check.
let pausesCheckedAt = Date.now() - 10 * 60 * 1000;
export function startPauseEndWatch() {
  if (!config.whatsapp.enabled) return;
  setInterval(() => {
    const now = Date.now();
    const ended = db
      .prepare("SELECT customer FROM pauses WHERE until > ? AND until <= ? AND customer NOT LIKE 'cw:%'")
      .all(pausesCheckedAt, now) as { customer: string }[];
    pausesCheckedAt = now;
    for (const { customer } of ended) {
      if (answerIfWaiting(customer)) log(`wa:${customer}`, "pause ended with the customer still waiting; the AI answers");
    }
  }, 5 * 60 * 1000).unref();
}

// The customer's messages since our last one only acknowledge (or there are none).
function waitingAreAcknowledgements(customer: string): boolean {
  const rows = db
    .prepare(
      `SELECT role, text FROM messages WHERE customer = ? AND history = 0 AND text NOT LIKE '[sent a reaction%'
       ORDER BY id DESC LIMIT 20`,
    )
    .all(customer) as { role: string; text: string }[];
  const end = rows.findIndex((m) => m.role !== "customer");
  return (end < 0 ? rows : rows.slice(0, end)).every((m) => isAcknowledgement(m.text));
}

// The team's words that close an order in the chat ("تم تثبيت الطلب", "تم الحجز", "ثبتنالك الطلب").
const TEAM_CONFIRMED = /تم\s*(تثبيت|حجز|الحجز|تاكيد|تأكيد)|ثبت(نا|ناه|نالك)|انحجز/;

// What the team did by hand in this chat, for the AI after it takes over again: since when the business messages
// are theirs, and whether they already took the order.
function teamContext(customer: string): { note: string; confirmed?: string } {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = db
    .prepare(
      `SELECT source, text, created_at FROM messages WHERE customer = ? AND history = 0 AND role = 'business' AND created_at > ?
       ORDER BY id ASC`,
    )
    .all(customer, since) as { source: string; text: string; created_at: number }[];
  const lastAi = rows.map((r) => r.source).lastIndexOf("ai");
  const team = rows.slice(lastAi + 1).filter((r) => r.source === "staff");
  const confirmed = rows.filter((r) => r.source === "staff" && TEAM_CONFIRMED.test(r.text)).at(-1)?.text;
  const lines: string[] = [];
  if (team.length) {
    const at = new Date(team[0]!.created_at + config.dashboard.timezoneOffsetHours * 3_600_000).toISOString().slice(11, 16);
    lines.push(
      `Our team (a person) handled this chat by hand from ${at}: our messages since then are theirs. Continue from where they stopped, in the same direction: don't ask again what they asked or settled (size, color, payment, address), and don't contradict them.`,
    );
  }
  if (confirmed) {
    lines.push(
      `The team already took this customer's order in the chat ("${confirmed.replace(/\s+/g, " ").slice(0, 160)}") and records it themselves: never call submit_order for it and don't confirm it again. Only answer something new the customer asks; if they only acknowledge, call no_reply_needed.`,
    );
  }
  return { note: lines.join("\n"), confirmed };
}

// Messenger / Instagram: no phone number, customers from Libya and Syria, no WhatsApp formatting.
function metaNote(channel: string): string {
  return [
    `Writes from ${channel === "instagram" ? "Instagram" : "Messenger (our Facebook page)"}, not WhatsApp: we don't have their number. Before the order summary, ask for a phone number for the delivery and check it: a Libyan mobile is 10 digits starting with 091 to 095 (or +218 9…); if it doesn't look right, ask again kindly.`,
    `Customers here come from Libya and from Syria. If it isn't clear where they are, ask "من وين حضرتك؟" before giving a price or delivery details. A customer in Syria: we don't have Syrian prices yet, so hand off to the team with the reason "customer from Syria".`,
    "We have no other number or chat to give: they can keep writing here.",
    "Plain text only (no *bold*), and keep messages short.",
  ].join("\n");
}

async function respond(customer: string) {
  // The team may have taken over while we were waiting.
  if (isAiPaused(customer)) return;

  const key = `wa:${customer}`;
  try {
    await waitForMedia(customer);
    const lastSeen = lastCustomerMessageId(customer);
    void showTyping(customer);
    const team = teamContext(customer);
    const decision = await decideReply(historyForAi(customer), {
      customerPhone: localPhone(customer),
      customerName: contactName(customer),
      location: lastLocation(customer),
      sentPhotos: sentPhotoNames(customer),
      background: [
        customerBackground(customer),
        trackingNote(customer),
        await locationNote(customer),
        isUserId(customer) && "Writes from a WhatsApp username: we don't have their number, so ask for a phone number when taking the order (not before).",
        isMetaCustomer(customer) && metaNote(channelOf(customer)),
        team.note,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    recordAiCall({
      customer,
      channel: channelOf(customer),
      action: decision.action,
      reason:
        decision.action === "handoff" || decision.action === "none"
          ? decision.reason
          : decision.action === "order"
            ? orderOneLine(decision.order)
            : undefined,
      usage: decision.usage,
    });

    if (decision.action === "none") {
      log(key, `nothing to answer: ${decision.reason || "the customer only acknowledged"}`);
      return;
    }
    if (isAiPaused(customer)) {
      log(key, "team replied while the AI was thinking; AI reply dropped");
      return;
    }
    // The customer wrote again while the AI was thinking: this reply is already out of date (it would ask
    // for what they just gave). The new message scheduled another reply, which reads everything.
    if (lastCustomerMessageId(customer) !== lastSeen) {
      log(key, "customer wrote again while the AI was thinking; reply superseded");
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
          if (lastCustomerMessageId(customer) !== lastSeen) return; // they wrote again: the next reply takes over
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
      // Customers often write the number in Arabic digits (٠٩٢…): store it in 0-9. "Same number" answers come
      // through as text; fall back to the WhatsApp number.
      decision.order.phone = latinDigits(decision.order.phone);
      if (!/\d{6,}/.test(decision.order.phone.replace(/[\s-]/g, ""))) decision.order.phone = localPhone(customer);
      if (team.confirmed) {
        // The team closed this order in the chat and records it themselves: saving it too makes a duplicate.
        log(key, `AI tried to take an order the team already confirmed in the chat; not saved, nothing sent`);
        return;
      }
      const same = findSameOrder(customer, decision.order.items, Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (same) {
        // Already saved: don't record it twice or stop the AI again. A new map location is the usual reason:
        // locationForOpenOrder already checked with Darb whether the order could still change and told the team,
        // so the reply only says what happened.
        const link = lastCustomerText(customer).match(MAP_LINK)?.[0].replace(/[)\]]+$/, "");
        const address = (db.prepare("SELECT address FROM orders WHERE id = ?").get(same) as { address: string } | undefined)?.address ?? "";
        const text = !link
          ? decision.messageToCustomer || DEFAULT_ORDER_MESSAGE
          : address.includes(link)
            ? "تمام استاذ، وصلنا اللوكيشن الجديد وحدّثنا العنوان 🙏"
            : "وصلنا اللوكيشن استاذ 🙏 طلبك صار بالطريق مع المندوب وما فينا نغيّر العنوان هلأ، بلّغنا الفريق ليتابع مع المندوب.";
        const wamid = await sendText(customer, text);
        saveMessage({ customer, role: "business", source: "ai", text, wamid });
        log(key, `same order as #${same} sent again by the AI; not saved twice`);
        return;
      }
      const missing = missingStock(decision.order.items);
      if (missing.length) {
        // A color/size we don't have: no order, the team tells the customer what's left.
        const reason = `الزبون أكّد طلب على شي خلص بالمخزون: ${missing.join("، ")}. ${orderOneLine(decision.order)}`;
        const text = DEFAULT_HANDOFF_MESSAGE;
        saveMessage({ customer, role: "business", source: "ai", text, wamid: await sendText(customer, text) });
        pauseAi(customer, `AI handoff: ${reason}`);
        log(key, `order not saved, out of stock: ${missing.join(", ")}`);
        notifyHandoff(customer, reason);
        return;
      }
      const gaps = addressGaps(decision.order);
      const id = saveOrder({
        customer,
        channel: channelOf(customer),
        ...decision.order,
        notes: [decision.order.notes, gaps.length ? `⚠️ ناقص: ${gaps.join("، ")}، شيكو بالمحادثة قبل ما تبعتو لدرب` : ""].filter(Boolean).join("\n"),
      });
      const text = decision.messageToCustomer || DEFAULT_ORDER_MESSAGE;
      const wamid = await sendText(customer, text);
      saveMessage({ customer, role: "business", source: "ai", text, wamid });
      pauseAi(customer, `AI order #${id}: waiting for the team to confirm`);
      log(key, `order #${id} collected, team must confirm: ${orderOneLine(decision.order)}`);
      notifyOrder(id, customer, decision.order);
      if (gaps.length) notify("order", `⚠️ <b>طلب #${id} ناقص: ${esc(gaps.join("، "))}</b>\nشيكو بالمحادثة وصلّحو الطلب قبل ما تبعتو لدرب.`);
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
    recordAiCall({ customer, channel: channelOf(customer), action: "error", reason: errorText(error) });
    log(key, `error, AI paused for this customer: ${errorText(error)}`);
    notifyError(`المساعد ما قدر يرد على ${customerLabel(customer)} (توقف بهالمحادثة، ردو انتو)`, errorText(error));
  }
}

// A map location sent after ordering: is the order still changeable? Checked with Darb first, decided here (not by
// the AI), and the result goes into the AI's next reply (locationNote) and to the team:
// - not sent to Darb: the order's address gets it;
// - sent, not picked up yet: the order's address and the courier's note at Darb get it;
// - on its way (or Darb didn't answer): nothing changes, the customer hears it can't be changed now, the team gets it.
type LocationOutcome = { orderId: number; link: string; result: "updated" | "updated_darb" | "on_way" | "unchecked"; status?: string };
const locationOutcomes = new Map<string, Promise<LocationOutcome | undefined>>();

function locationForOpenOrder(customer: string, text: string) {
  const link = text.match(MAP_LINK)?.[0].replace(/[)\]]+$/, "");
  if (!link) return;
  const order = db
    .prepare("SELECT id, address, darb_id FROM orders WHERE customer = ? AND status IN ('new', 'confirmed') AND created_at > ? ORDER BY id DESC LIMIT 1")
    .get(customer, Date.now() - 7 * 24 * 60 * 60 * 1000) as { id: number; address: string; darb_id: string | null } | undefined;
  if (!order || order.address.includes(link)) return;
  const done = (async (): Promise<LocationOutcome> => {
    const who = esc(customerLabel(customer));
    if (!order.darb_id) {
      updateOrderLocation(order.id, link);
      notify("order", `📍 <b>لوكيشن جديد لطلب #${order.id}</b>: ${who}\nحدّثناه بعنوان الطلب (لسا ما انبعت لدرب): ${esc(link)}`);
      return { orderId: order.id, link, result: "updated" };
    }
    try {
      const darbSide = await setShipmentLocation(order.darb_id, link);
      if (darbSide.changed || darbSide.status === "pending" || darbSide.status === "booked") {
        updateOrderLocation(order.id, link);
        notify("order", `📍 <b>لوكيشن جديد لطلب #${order.id}</b>: ${who}\nالمندوب لسا ما استلم الشحنة: حدّثنا العنوان وملاحظة المندوب بدرب.\n${esc(link)}`);
        return { orderId: order.id, link, result: "updated_darb", status: darbSide.status };
      }
      notify(
        "order",
        `⚠️ <b>لوكيشن جديد بس الطلب #${order.id} بالطريق</b> (${esc(DARB_STATUS_AR[darbSide.status] ?? darbSide.status)}): ${who}\n` +
          `ما غيّرنا شي. إذا لازم، اتصلو بدرب أو المندوب وعطوهن اللوكيشن الجديد:\n${esc(link)}`,
      );
      return { orderId: order.id, link, result: "on_way", status: darbSide.status };
    } catch (error) {
      notify(
        "order",
        `⚠️ <b>لوكيشن جديد لطلب #${order.id}</b>: ${who}\nما قدرت اتأكد من درب إذا الشحنة بعدها بتتغيّر (${esc(error instanceof Error ? error.message : String(error))}). ما غيّرنا شي، شيكو انتو:\n${esc(link)}`,
      );
      return { orderId: order.id, link, result: "unchecked" };
    }
  })();
  locationOutcomes.set(customer, done.catch(() => undefined));
  void done.then((o) => log(`wa:${customer}`, `new map location for order #${o.orderId}: ${o.result}${o.status ? ` (${o.status})` : ""}`));
}

// For the AI's reply right after: what happened to the location (once; it waits for the Darb check).
async function locationNote(customer: string): Promise<string | undefined> {
  const pending = locationOutcomes.get(customer);
  if (!pending) return undefined;
  locationOutcomes.delete(customer);
  const o = await pending;
  if (!o) return undefined;
  const about = `The map location the customer just sent is for their order #${o.orderId} (not a new order: don't call submit_order).`;
  if (o.result === "updated" || o.result === "updated_darb") return `${about} It was saved to the order's address. Tell them you got it and updated the address.`;
  if (o.result === "on_way")
    return `${about} The order is already on its way with Darb Assabil's courier, so the location can't be changed now. Tell them kindly it's on its way and we can't change the location now, and that the team was told and will follow up with the courier. Don't say it was updated.`;
  return `${about} We couldn't check yet whether it can still change, and nothing was changed. Tell them you got it and the team will check and confirm. Don't say it was updated.`;
}

// The catalog photos this chat already got ("[sent product photo: بيج]"): they go once per chat.
function sentPhotoNames(customer: string): string[] {
  const rows = db
    .prepare("SELECT text FROM messages WHERE customer = ? AND role = 'business' AND text LIKE '[sent product photo: %'")
    .all(customer) as { text: string }[];
  return [...new Set(rows.map((r) => r.text.slice("[sent product photo: ".length, -1)))];
}

// A photo right after we sent our bank account is probably the transfer receipt: the team checks it (the AI
// never says the money arrived), and the open order notes it. Works while the AI is paused after the order.
function receiptForTeam(customer: string) {
  const ours = db
    .prepare("SELECT text FROM messages WHERE customer = ? AND role = 'business' AND created_at > ? ORDER BY id DESC LIMIT 6")
    .all(customer, Date.now() - 3 * 24 * 60 * 60 * 1000) as { text: string }[];
  if (!ours.some((m) => /LY\d{20,}/.test(m.text.replace(/[\s-]/g, "")))) return;
  const order = db
    .prepare("SELECT id FROM orders WHERE customer = ? AND status IN ('new', 'confirmed') ORDER BY id DESC LIMIT 1")
    .get(customer) as { id: number } | undefined;
  if (order) {
    db.prepare("UPDATE orders SET notes = trim(notes || char(10) || ?, char(10) || ' '), updated_at = ? WHERE id = ?").run(
      "🧾 الزبون بعت صورة بعد بيانات الحساب (ممكن إيصال تحويل): شيكو المبلغ",
      Date.now(),
      order.id,
    );
  }
  log(`wa:${customer}`, `photo after our bank details: maybe a transfer receipt${order ? ` (order #${order.id})` : ""}`);
  notify(
    "order",
    `🧾 <b>ممكن إيصال تحويل</b>${order ? ` لطلب #${order.id}` : ""}: ${esc(customerLabel(customer))}\nالزبون بعت صورة بعد ما بعتنالو بيانات الحساب. شيكو إذا المبلغ وصل.\n${dashboardLink(`/inbox/${customer}`, "فتح المحادثة")}`,
  );
}

const lastCustomerText = (customer: string) =>
  (db.prepare("SELECT text FROM messages WHERE customer = ? AND role = 'customer' ORDER BY id DESC LIMIT 1").get(customer) as { text: string } | undefined)
    ?.text ?? "";

// The last map location the customer sent in the past week (a long chat pushes it out of the AI's messages).
function lastLocation(customer: string): string | undefined {
  const rows = db
    .prepare("SELECT text FROM messages WHERE customer = ? AND role = 'customer' AND created_at > ? AND text LIKE '%http%' ORDER BY id DESC LIMIT 20")
    .all(customer, Date.now() - 7 * 24 * 60 * 60 * 1000) as { text: string }[];
  for (const { text } of rows) {
    const link = text.match(MAP_LINK)?.[0].replace(/[)\]]+$/, "");
    if (link) return link;
  }
  return undefined;
}

// An order tracking update (src/tracking.ts): one message, shown in the chat as the AI's.
export async function sendNotice(customer: string, text: string) {
  const wamid = await sendText(customer, text);
  saveMessage({ customer, role: "business", source: "ai", text, wamid });
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
// A photo from the dashboard is saved under media/team-<random>, which /sent/ serves publicly so WhatsApp can fetch it;
// the text goes with it as the caption.
export async function sendTeamMessage(customer: string, text: string, image?: { data: Buffer; mime: string }) {
  if (image) {
    if (!config.publicUrl) throw new Error("PUBLIC_URL is not set, so WhatsApp can't fetch the photo");
    const file = saveFile("media", `team-${crypto.randomBytes(16).toString("hex")}`, image.data, image.mime);
    // Messenger and Instagram photos have no caption: the text goes after it.
    const caption = !isMetaCustomer(customer) && text.length <= 1024 ? text : "";
    const link = `${config.publicUrl}/sent/${path.basename(file)}`;
    const wamid = await sendImage(customer, link, caption);
    saveMessage({
      customer,
      role: "business",
      source: "staff",
      text: caption ? `[sent a photo] ${caption}` : "[sent a photo]",
      wamid,
      media: { type: "image", file, mime: image.mime },
    });
    if (text && !caption) saveMessage({ customer, role: "business", source: "staff", text, wamid: await sendText(customer, text) });
  } else {
    const wamid = await sendText(customer, text);
    saveMessage({ customer, role: "business", source: "staff", text, wamid });
  }
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
    const wamid = await sendImage(customer, publicPhotoUrl(item));
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
  if (isMetaCustomer(to)) return metaSendText(to, body);
  return sendMessage(to, { type: "text", text: { body, preview_url: false } });
}

function sendImage(to: string, link: string, caption = "") {
  if (isMetaCustomer(to)) return metaSendImage(to, link);
  return sendMessage(to, { type: "image", image: caption ? { link, caption } : { link } });
}

async function sendMessage(to: string, content: Record<string, unknown>): Promise<string | undefined> {
  const { url, headers } = sendEndpoint();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    // A customer known only by their user id (WhatsApp usernames) is addressed with `recipient`, not `to`.
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", ...(isUserId(to) ? { recipient: to } : { to }), ...content }),
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
  if (isMetaCustomer(customer)) return metaTyping(customer);
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
    case "location": {
      // As a Google Maps link: it goes with the address to the courier.
      const l = m.location;
      if (l?.latitude === undefined || l.longitude === undefined) return "[sent a location]";
      const place = [l.name, l.address].filter(Boolean).join(" - ");
      return `[sent a location: https://maps.google.com/?q=${l.latitude},${l.longitude}${place ? ` (${place})` : ""}]`;
    }
    case "media_placeholder": // history sync leaves out media contents
      return "[sent a media file]";
    default:
      return `[sent a ${m.type} message]`;
  }
}

// ٠٩٢٧٨٧٥٤٠٧ / ۰۹۲۷۸۷۵۴۰۷ → 0927875407
export function latinDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) - 0x0660) % 0x90));
}

// A customer who writes from a WhatsApp username without sharing their number: "LY.1234…" (country + id).
export function isUserId(customer: string): boolean {
  return /^[A-Z]{2}\./.test(customer);
}

// 218912345678 → 0912345678 (how Libyan customers write their number); other countries: +<number>.
// Empty for a username customer: we don't have their number, so it must be asked.
export function localPhone(waNumber: string): string {
  if (isUserId(waNumber) || isMetaCustomer(waNumber)) return "";
  return waNumber.startsWith("218") ? `0${waNumber.slice(3)}` : `+${waNumber}`;
}

function describeMedia(type: string, media: { caption?: string }): string {
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
