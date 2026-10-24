// WhatsApp Cloud API through Dualhook or 360dialog. Webhooks use Meta's Cloud API format.
import { config } from "../config.js";
import { decideReply } from "../agent.js";
import { getHistory, isAiPaused, pauseAi, saveHistory, saveMessage } from "../store.js";
import { log, scheduleReply } from "../scheduler.js";

const DEFAULT_HANDOFF_MESSAGE = "شكراً لتواصلك! واحد من فريقنا رح يرد عليك بأقرب وقت 🙏";

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
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string };
};

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
  if (message.type === "reaction" || message.type === "unsupported") return;

  const isNew = saveMessage({
    customer,
    role: "customer",
    source: "customer",
    text: describe(message),
    wamid: message.id,
    createdAt: toMs(message.timestamp),
  });
  if (!isNew) return; // duplicate webhook delivery

  if (!config.aiReplies) {
    log(`wa:${customer}`, "customer wrote; listen-only mode (AI_REPLIES=off), not replying");
    return;
  }
  if (isAiPaused(customer)) {
    log(`wa:${customer}`, "customer wrote; AI paused (team is handling this chat)");
    return;
  }

  scheduleReply(`wa:${customer}`, config.debounceMs, () => respond(customer));
}

function onStaffMessage(echo: WaMessage) {
  const customer = echo.to;
  if (!customer || echo.type === "revoke" || echo.type === "edit") return;

  saveMessage({
    customer,
    role: "business",
    source: "staff",
    text: describe(echo),
    wamid: echo.id,
    createdAt: toMs(echo.timestamp),
  });
  pauseAi(customer, "team replied from the WhatsApp Business app");
  log(`wa:${customer}`, `team replied from the app; AI paused for ${config.whatsapp.humanPauseHours}h`);
}

// Stores past chats so the AI knows what was already said. Never replies or pauses the AI.
function onHistoryChunk(chunk: HistoryChunk) {
  for (const error of chunk.errors ?? []) {
    log("wa:history", `not shared (${error.code}): ${error.title}`);
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
  log(
    "wa:history",
    `phase ${phase} chunk ${chunk_order}: ${chunk.threads?.length ?? 0} chats, ${added} new messages stored (sync ${progress}%)`,
  );
}

async function respond(customer: string) {
  // The team may have taken over while we were waiting.
  if (isAiPaused(customer)) return;

  const key = `wa:${customer}`;
  try {
    const decision = await decideReply(getHistory(customer));

    if (isAiPaused(customer)) {
      log(key, "team replied while the AI was thinking; AI reply dropped");
      return;
    }

    if (decision.action === "reply") {
      const wamid = await sendText(customer, decision.text);
      saveMessage({ customer, role: "business", source: "ai", text: decision.text, wamid });
      log(key, "replied");
    } else {
      const text = decision.messageToCustomer || DEFAULT_HANDOFF_MESSAGE;
      const wamid = await sendText(customer, text);
      saveMessage({ customer, role: "business", source: "ai", text, wamid });
      pauseAi(customer, `AI handoff: ${decision.reason}`);
      log(key, `handed off to team: ${decision.reason}`);
    }
  } catch (error) {
    // Never leave the customer stuck with the bot: stop the AI so the team answers in the app.
    pauseAi(customer, "AI error");
    log(key, `error, AI paused for this customer: ${error instanceof Error ? error.message : String(error)}`);
  }
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

async function sendText(to: string, body: string): Promise<string | undefined> {
  const { url, headers } = sendEndpoint();
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body, preview_url: false },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${config.whatsapp.provider} send failed: ${res.status} ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as { messages?: { id?: string }[] };
  return data.messages?.[0]?.id;
}

// --- Helpers --------------------------------------------------------------

function describe(m: WaMessage): string {
  switch (m.type) {
    case "text":
      return m.text?.body?.trim() || "[empty message]";
    case "button":
      return m.button?.text ?? "[button]";
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[interactive reply]";
    case "image":
    case "video":
    case "document": {
      const caption = m[m.type]?.caption?.trim();
      return `[sent a ${m.type}]${caption ? ` ${caption}` : ""}`;
    }
    case "media_placeholder": // history sync leaves out media contents
      return "[sent a media file]";
    default:
      return `[sent a ${m.type} message]`;
  }
}

function toMs(timestamp?: string): number {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
}
