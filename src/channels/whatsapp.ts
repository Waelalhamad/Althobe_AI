// WhatsApp Cloud API through Dualhook or 360dialog. Webhooks use Meta's Cloud API format.
import { config } from "../config.js";
import { decideReply } from "../agent.js";
import { getHistory, isAiPaused, pauseAi, saveMessage } from "../store.js";
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

type WebhookPayload = {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: WaMessage[];
        message_echoes?: WaMessage[];
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
      }
      // Other fields (statuses, history, smb_app_state_sync, ...) are ignored.
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
    default:
      return `[sent a ${m.type} message]`;
  }
}

function toMs(timestamp?: string): number {
  const seconds = Number(timestamp);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.now();
}
