// WhatsApp Cloud API through Dualhook or 360dialog. Webhooks use Meta's Cloud API format.
import crypto from "node:crypto";
import path from "node:path";
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
  saveContact,
  saveHistory,
  saveMessage,
  saveOrder,
  findSameOrder,
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
  } else if (message.type === "text" && isAcknowledgement(text) && !weAskedSomething(customer)) {
    // "تمام" / "شكرا" to a message of ours that asked nothing: a seller doesn't answer it with another "تمام".
    needsReply = false;
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
    log(`wa:${customer}`, message.type === "reaction" ? "customer reacted; no reply needed" : "customer only acknowledged; no reply needed");
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
  return (end < 0 ? ours : ours.slice(0, end)).some((m) => /[؟?]/.test(m.text));
}

function onStaffMessage(echo: WaMessage) {
  const customer = echo.to ?? echo.to_user_id ?? echo.recipient_user_id;
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

// After the AI is turned back on for a chat: if the customer's last message is still unanswered, answer it.
export function answerIfWaiting(customer: string): boolean {
  const last = db
    .prepare(
      `SELECT role, created_at FROM messages WHERE customer = ? AND history = 0 AND text NOT LIKE '[sent a reaction%'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(customer) as { role: string; created_at: number } | undefined;
  if (!last || last.role !== "customer" || last.created_at < Date.now() - 23 * 60 * 60 * 1000) return false;
  if (aiBlockedReason(customer) || isAiPaused(customer)) return false;
  // "تمام" to the team's "تم تثبيت الطلب": nothing to answer.
  if (!weAskedSomething(customer) && waitingAreAcknowledgements(customer)) return false;
  scheduleReply(`wa:${customer}`, 1000, () => respond(customer));
  return true;
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
      background: [
        customerBackground(customer),
        isUserId(customer) && "Writes from a WhatsApp username: we don't have their number, so ask for a phone number for the delivery.",
        team.note,
      ]
        .filter(Boolean)
        .join("\n"),
    });
    recordAiCall({
      customer,
      channel: "whatsapp",
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
        // Already saved: just send the message, don't record it twice or stop the AI again.
        const text = decision.messageToCustomer || DEFAULT_ORDER_MESSAGE;
        const wamid = await sendText(customer, text);
        saveMessage({ customer, role: "business", source: "ai", text, wamid });
        log(key, `same order as #${same} sent again by the AI; not saved twice`);
        return;
      }
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
// A photo from the dashboard is saved under media/team-<random>, which /sent/ serves publicly so WhatsApp can fetch it;
// the text goes with it as the caption.
export async function sendTeamMessage(customer: string, text: string, image?: { data: Buffer; mime: string }) {
  if (image) {
    if (!config.publicUrl) throw new Error("PUBLIC_URL is not set, so WhatsApp can't fetch the photo");
    const file = saveFile("media", `team-${crypto.randomBytes(16).toString("hex")}`, image.data, image.mime);
    const caption = text.length <= 1024 ? text : "";
    const link = `${config.publicUrl}/sent/${path.basename(file)}`;
    const wamid = await sendMessage(customer, { type: "image", image: caption ? { link, caption } : { link } });
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
  if (isUserId(waNumber)) return "";
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
