// Messenger (the Facebook page) and Instagram, straight from Meta: Messenger Platform and Instagram Messaging
// with Facebook Login, both sent through the page. The conversation itself (waiting for more messages, the AI's
// reply, team pauses, orders) is the same as WhatsApp's (whatsapp.ts): this file turns Meta's webhooks into
// customer and team messages, and sends.
// Customers are "fb:<PSID>" (Messenger) and "ig:<IGSID>" (Instagram).
import crypto from "node:crypto";
import { config } from "../config.js";
import { log } from "../scheduler.js";
import { db, saveContact } from "../store.js";
import { notifyError } from "../telegram.js";
import { receiveCustomerMessage, receiveStaffMessage, type MediaJob } from "./whatsapp.js";

export const isMetaCustomer = (customer: string) => customer.startsWith("fb:") || customer.startsWith("ig:");

// --- Webhook payload (only the fields we use) ---

type Referral = { source?: string; type?: string; ref?: string; ad_id?: string; ads_context_data?: { ad_title?: string; post_id?: string } };

type Attachment = {
  type?: string; // image | video | audio | file | sticker | share | story_mention | ig_reel | reel | location | fallback | template
  payload?: { url?: string; title?: string; sticker_id?: number; coordinates?: { lat?: number; long?: number } };
};

type MetaEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    app_id?: number | string;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    attachments?: Attachment[];
    quick_reply?: { payload?: string };
    reply_to?: { mid?: string; story?: { url?: string; id?: string } };
    referral?: Referral;
  };
  postback?: { mid?: string; title?: string; payload?: string; referral?: Referral };
  reaction?: { mid?: string; action?: "react" | "unreact"; emoji?: string; reaction?: string };
  referral?: Referral;
};

type MetaPayload = { object?: string; entry?: { id?: string; time?: number; messaging?: MetaEvent[] }[] };

// X-Hub-Signature-256 = "sha256=" + HMAC_SHA256(app secret, raw body)
export function validMetaSignature(body: Buffer, signature: string | undefined): boolean {
  if (!signature || !config.meta.appSecret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", config.meta.appSecret).update(body).digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function handleMetaWebhook(payload: MetaPayload) {
  const prefix = payload.object === "page" ? "fb:" : payload.object === "instagram" ? "ig:" : undefined;
  if (!prefix) return;
  const ours = prefix === "fb:" ? config.meta.pageId : config.meta.instagramId;
  for (const entry of payload.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      try {
        if (event.message?.is_echo || event.sender?.id === ours) onEcho(prefix, event);
        else if (event.sender?.id) onCustomerEvent(prefix, event);
      } catch (error) {
        console.error("Meta webhook event failed:", error);
      }
    }
  }
}

function onCustomerEvent(prefix: string, event: MetaEvent) {
  const customer = prefix + event.sender!.id!;
  const createdAt = event.timestamp ?? Date.now();
  void ensureProfile(customer);

  if (event.reaction) {
    const { mid, action, emoji, reaction } = event.reaction;
    if (action === "unreact" || !mid) return;
    receiveCustomerMessage({
      customer,
      id: `react-${mid}-${createdAt}`,
      text: "",
      createdAt,
      reaction: { emoji: emoji || reaction, messageId: mid },
    });
    return;
  }

  if (event.postback) {
    const { mid, title, payload } = event.postback;
    receiveCustomerMessage({
      customer,
      id: mid ?? `postback-${event.sender!.id}-${createdAt}`,
      text: adNote(event.postback.referral ?? event.referral) + (title || payload || "[tapped a button]"),
      createdAt,
      isText: true,
    });
    return;
  }

  const message = event.message;
  if (!message?.mid || message.is_deleted) return;
  if (message.is_unsupported && !message.text) {
    receiveCustomerMessage({ customer, id: message.mid, text: "[sent a message type we can't read]", createdAt });
    return;
  }

  const prefixText = adNote(message.referral ?? event.referral) + (message.reply_to?.story ? "[replied to our story] " : "");
  const attachments = message.attachments ?? [];
  if (!attachments.length) {
    receiveCustomerMessage({ customer, id: message.mid, text: prefixText + (message.text?.trim() || "[empty message]"), createdAt, isText: true });
    return;
  }
  // One row per attachment (a photo each, so the AI sees them); the text goes with the first.
  attachments.forEach((attachment, n) => {
    const caption = n === 0 ? message.text?.trim() : undefined;
    const media = mediaJob(attachment, caption);
    receiveCustomerMessage({
      customer,
      id: n === 0 ? message.mid! : `${message.mid}#${n}`,
      text: (n === 0 ? prefixText : "") + describeAttachment(attachment, caption),
      createdAt,
      media,
    });
  });
}

// Our own sends come back as echoes too. Messenger says which app sent it; Instagram doesn't, so an echo whose id
// we haven't saved a few seconds later was written by a person (Business Suite, the Instagram app).
function onEcho(prefix: string, event: MetaEvent) {
  const message = event.message;
  const recipient = event.recipient?.id;
  if (!message?.mid || !recipient || message.is_deleted) return;
  if (config.meta.appId && message.app_id !== undefined && String(message.app_id) === config.meta.appId) return;
  const customer = prefix + recipient;
  const createdAt = event.timestamp ?? Date.now();
  const text = (message.attachments ?? []).length
    ? (message.attachments ?? []).map((a, n) => describeAttachment(a, n === 0 ? message.text?.trim() : undefined)).join("\n")
    : message.text?.trim() || "[empty message]";
  setTimeout(() => {
    if (db.prepare("SELECT 1 FROM messages WHERE wamid = ?").get(message.mid!)) return;
    receiveStaffMessage({ customer, id: message.mid!, text, createdAt, from: prefix === "fb:" ? "Messenger" : "Instagram" });
  }, 5000);
}

function adNote(referral: Referral | undefined): string {
  if (!referral || (referral.source !== "ADS" && !referral.ads_context_data)) return "";
  const title = referral.ads_context_data?.ad_title?.trim();
  return `[from the ad${title ? `: «${title}»` : ""}] `;
}

function describeAttachment(a: Attachment, caption?: string): string {
  const url = a.payload?.url;
  const label = (() => {
    switch (a.type) {
      case "image":
        return a.payload?.sticker_id ? "[sent a sticker]" : "[sent a photo]";
      case "video":
        return "[sent a video]";
      case "audio":
        return "[voice note]";
      case "file":
        return "[sent a document]";
      case "sticker":
        return "[sent a sticker]";
      case "story_mention":
        return "[mentioned us in their story]";
      case "share":
      case "ig_reel":
      case "reel":
      case "ig_post":
        return `[shared a post${url ? `: ${url}` : ""}]`;
      case "location": {
        const c = a.payload?.coordinates;
        return c?.lat !== undefined && c.long !== undefined ? `[sent a location: https://maps.google.com/?q=${c.lat},${c.long}]` : "[sent a location]";
      }
      case "fallback":
        return url ? `[sent a link: ${url}]` : "[sent a link]";
      default:
        return `[sent a ${a.type ?? "message"}]`;
    }
  })();
  return caption ? `${label} ${caption}` : label;
}

// Photos and voice notes are downloaded right away: Meta's links expire.
function mediaJob(a: Attachment, caption?: string): MediaJob | undefined {
  const url = a.payload?.url;
  if (!url) return undefined;
  const type = a.payload?.sticker_id ? "sticker" : a.type === "image" ? "image" : a.type === "audio" ? "audio" : a.type === "video" ? "video" : a.type === "file" ? "document" : undefined;
  if (!type) return undefined;
  return {
    type,
    caption,
    download: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: ${res.status}`);
      return { data: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
    },
  };
}

// --- Graph API ---

async function graph<T>(method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<T> {
  const res = await fetch(`${config.meta.graphUrl}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token ?? (await pageToken())}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
  if (!res.ok || data.error) throw new Error(`Meta ${res.status}: ${data.error?.message ?? "request failed"}${data.error?.code ? ` (${data.error.code})` : ""}`);
  return data;
}

// The page's own token, read with the system user's token (which may already be the page token).
let pageTokenPromise: Promise<string> | undefined;
function pageToken(): Promise<string> {
  pageTokenPromise ??= graph<{ access_token?: string }>("GET", `${config.meta.pageId}?fields=access_token`, undefined, config.meta.accessToken)
    .then((d) => d.access_token || config.meta.accessToken)
    .catch((error) => {
      log("meta", `page token not read, using META_ACCESS_TOKEN as it is: ${error instanceof Error ? error.message : String(error)}`);
      return config.meta.accessToken;
    });
  return pageTokenPromise;
}

// At startup: the page sends its Messenger and Instagram messages to our app.
export async function startMeta() {
  if (!config.meta.enabled) return;
  try {
    await graph("POST", `${config.meta.pageId}/subscribed_apps`, {
      subscribed_fields: ["messages", "messaging_postbacks", "message_echoes", "message_reactions"],
    });
    log("meta", "page subscribed to the app (Messenger + Instagram messages)");
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    log("meta", `could not subscribe the page: ${text}`);
    notifyError("ربط ماسنجر وإنستغرام", text);
  }
}

// The customer's name (and Instagram username), once.
const profiled = new Set<string>();
async function ensureProfile(customer: string) {
  if (profiled.has(customer) || !config.meta.enabled) return;
  profiled.add(customer);
  if (db.prepare("SELECT 1 FROM customers WHERE customer = ? AND wa_name <> ''").get(customer)) return;
  const id = customer.slice(3);
  try {
    if (customer.startsWith("ig:")) {
      const p = await graph<{ name?: string; username?: string }>("GET", `${id}?fields=name,username`);
      saveContact(customer, p.name ?? "", p.username ?? "");
    } else {
      const p = await graph<{ first_name?: string; last_name?: string }>("GET", `${id}?fields=first_name,last_name`);
      saveContact(customer, [p.first_name, p.last_name].filter(Boolean).join(" "));
    }
  } catch (error) {
    log(`wa:${customer}`, `profile not read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// --- Sending ---

// Messenger shows 2000 characters per message, Instagram 1000 bytes (about 500 Arabic letters).
function fits(customer: string, text: string): boolean {
  return customer.startsWith("ig:") ? Buffer.byteLength(text) <= 1000 : text.length <= 2000;
}

function chunks(customer: string, text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const next = current ? `${current}\n${line}` : line;
    if (fits(customer, next)) {
      current = next;
      continue;
    }
    if (current) out.push(current);
    current = line;
    // A single line too long: cut it by words.
    while (!fits(customer, current)) {
      let cut = current.length;
      while (cut > 1 && !fits(customer, current.slice(0, cut))) cut--;
      const space = current.lastIndexOf(" ", cut);
      if (space > cut / 2) cut = space;
      out.push(current.slice(0, cut));
      current = current.slice(cut).trimStart();
    }
  }
  if (current) out.push(current);
  return out;
}

async function send(customer: string, message: Record<string, unknown>): Promise<string | undefined> {
  const data = await graph<{ message_id?: string }>("POST", `${config.meta.pageId}/messages`, {
    recipient: { id: customer.slice(3) },
    messaging_type: "RESPONSE",
    message,
  });
  return data.message_id;
}

// Plain text: Messenger and Instagram don't show WhatsApp's *bold*.
export async function metaSendText(customer: string, body: string): Promise<string | undefined> {
  let id: string | undefined;
  for (const part of chunks(customer, body.replace(/\*([^*\n]+)\*/g, "$1"))) id = await send(customer, { text: part });
  return id;
}

export function metaSendImage(customer: string, url: string): Promise<string | undefined> {
  return send(customer, { attachment: { type: "image", payload: { url, is_reusable: true } } });
}

// Seen and "typing…" while the AI thinks. Optional: errors are ignored.
export async function metaTyping(customer: string) {
  for (const action of ["mark_seen", "typing_on"]) {
    await graph("POST", `${config.meta.pageId}/messages`, { recipient: { id: customer.slice(3) }, sender_action: action }).catch(() => undefined);
  }
}
