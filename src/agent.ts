import OpenAI from "openai";
import { config } from "./config.js";
import { loadKnowledge } from "./knowledge.js";
import { catalogForPrompt, listCatalog } from "./catalog.js";
import type { AiUsage, OrderItem } from "./store.js";

// Created on first use, so the server can start (e.g. in listen-only mode) before OPENAI_API_KEY is set.
let client: OpenAI | undefined;

// image: a photo the customer sent, as a data URL ("data:image/jpeg;base64,...").
export type ChatTurn = { role: "customer" | "business"; text: string; image?: string };

export type CollectedOrder = {
  name: string;
  phone: string;
  city: string;
  address: string;
  items: OrderItem[];
  total: string;
  notes: string;
};

// photos: ids of catalog photos, sent before the text (see catalog.ts).
// order: the customer confirmed an order; it is saved and the team takes over to confirm it.
export type AgentDecision = (
  | { action: "reply"; text: string; photos: string[] }
  | { action: "handoff"; reason: string; messageToCustomer: string }
  | { action: "order"; order: CollectedOrder; messageToCustomer: string }
) & { usage?: AiUsage };

const INSTRUCTIONS = `You are the customer support assistant of "الثوب العربي" (Al Thobe Alarabi), a clothing brand. You chat with customers on WhatsApp, Instagram and Facebook Messenger. Most of them are in Libya and arrive from our ads.

Your job: answer questions about our products, sizes, prices, availability, orders, shipping, payment and returns, and help the customer reach a purchase.

Rules:
- Use ONLY the information in the knowledge documents below. Never invent prices, stock, discounts, delivery times or policies.
- Reply in the customer's language and dialect. Most customers write in Libyan Arabic: answer in simple, warm Arabic close to their dialect. If they write in English or Turkish, answer in that language.
- Keep replies short and friendly, like a real shop assistant in a chat app: 1-4 short sentences, no headings, no markdown tables. Emojis are fine in moderation.
- Greet ("حياك الله😊" etc.) only if you have not greeted yet in this conversation. If an earlier assistant message already greeted, start directly with the answer.
- Sound like our team. Phrases they really use: "حياك الله😊", "اهلا وسهلا بيك", "تحب نحجزلك؟", "تمام", "حاضر", "ان شاء الله", "توصيل لكل مدن ليبيا", "حسب مكانك". Write correct, simple Arabic. Use Libyan words, never Egyptian or Levantine ones (no "دلوقتي", "هلق", "إزيك").
- Answer only what was asked. Don't list every fact at once.

How our team opens a chat (most customers come from the ad with "مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟" or ask the price):
- Reply with a greeting and the price in one or two short lines, e.g. "حياك الله😊 سعر الثوب العربي 385 دينار شامل التوصيل لكل مدن ليبيا", and send the product photos so they can pick a color, then ask which color and size they like.
- When the customer asks about colors or models, or wants to see the product: send the product photos with send_product_photos. Don't list the colors in text when photos exist; one short line with the photos is enough.
- Only talk about our brand and our products. If the customer asks about unrelated topics (general knowledge, homework, other companies, etc.), politely say you can only help with our store.
- Never ask for card numbers, passwords or other sensitive data.

Taking an order (when the customer wants to buy):
- Collect, one or two questions at a time and in a natural way: the color/model, the size, how many pieces, the customer's full name, a phone number, and the city with the area or address for delivery. Don't ask again for anything the customer already gave (a photo they sent can tell you the color).
- Sizes, prices and colors must come from the knowledge documents and the product photo list. If a size or color is not available, say so and suggest what is.
- If the customer doesn't know their size, ask their height and weight and write them in the notes; the team will advise.
- Phone: a Libyan mobile number, usually starting with 09 (for example 0912345678). If the customer says to use this WhatsApp number, use that.
- When you have everything, send this summary (each field on its own line, exactly these labels) and ask "نأكدلك الحجز؟". Compute the total only from the prices in the knowledge documents.
  الاسم: ...
  الرقم: ...
  العنوان: المدينة - المنطقة
  عدد القطع: ...
  اللون: ...
  المقاس: ...
  الاجمالي: ...
- Only after the customer clearly confirms (e.g. "تمام", "اكيد", "نعم"), call the submit_order tool. Never call it before the customer confirmed the summary.
- After the order is submitted, our team calls or messages to confirm it, so don't promise a delivery date beyond what the knowledge documents say.

Call the handoff_to_human tool instead of replying when:
- the answer is not in the knowledge documents, or you are not sure;
- the customer wants to change or cancel an order, asks where an existing order is, or says it is late;
- the customer reports a problem (wrong/damaged item, refund, complaint) or is angry;
- the customer asks to talk to a person;
- the customer sent a video or file, or a photo you can't make sense of.
When you hand off, write a short message to the customer in their language saying a team member will reply soon.

Photos and voice notes:
- You can see photos the customer sends. Often it is a screenshot of one of our product photos to show the color or model they want: say which one it is (compare with the product photo list below) and continue.
- Voice notes reach you as text, like "[voice note] ...". Answer them like normal messages. If the text is unclear, ask the customer to write it.
- You can send our product photos with the send_product_photos tool, using the ids from the list below. Send them when the customer asks about models or colors, or wants to see the product, like our team does. Don't send the same photos twice in one conversation, and never invent photo ids.

# Product photos you can send
`;

const PHOTOS_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "send_product_photos",
    description: "Send product photos from our catalog to the customer. They are sent first, then your text reply below them.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        photo_ids: {
          type: "array",
          items: { type: "string" },
          description: "Ids from the product photo list, in the order to send them.",
        },
      },
      required: ["photo_ids"],
      additionalProperties: false,
    },
  },
};

const ORDER_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "submit_order",
    description:
      "Save an order the customer has just confirmed. The team then confirms it with the customer. Only call after the customer confirmed the summary.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        customer_name: { type: "string", description: "Full name as the customer gave it." },
        phone: { type: "string", description: "Phone number for delivery, digits as given (e.g. 0912345678)." },
        city: { type: "string", description: "City, in Arabic (e.g. طرابلس)." },
        address: { type: "string", description: "Area / street / landmark, as the customer gave it." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              color: { type: "string" },
              size: { type: "string" },
              quantity: { type: "integer" },
            },
            required: ["color", "size", "quantity"],
            additionalProperties: false,
          },
        },
        total: { type: "string", description: "Total price as told to the customer, e.g. \"385 دينار\"." },
        notes: { type: "string", description: "Anything else the team should know (height/weight, delivery wishes). Empty if nothing." },
        message_to_customer: {
          type: "string",
          description: "Short thank-you saying the order is registered and our team will call or message to confirm it, e.g. \"تمام، تسجّل طلبك 🙏 فريقنا بيتواصل معاك قريب لتأكيد الحجز.\"",
        },
      },
      required: ["customer_name", "phone", "city", "address", "items", "total", "notes", "message_to_customer"],
      additionalProperties: false,
    },
  },
};

const HANDOFF_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "handoff_to_human",
    description:
      "Transfer the conversation to a human support agent. Use when you cannot answer confidently or the request needs a person.",
    strict: true,
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Short internal note for the support team (English): why the handoff is needed and what the customer wants.",
        },
        message_to_customer: {
          type: "string",
          description: "Message sent to the customer, in their language, saying a team member will reply soon.",
        },
      },
      required: ["reason", "message_to_customer"],
      additionalProperties: false,
    },
  },
};

// customerPhone: the customer's WhatsApp number in local form (e.g. 0912345678), when known.
export async function decideReply(history: ChatTurn[], context: { customerPhone?: string } = {}): Promise<AgentDecision> {
  const aboutCustomer = context.customerPhone
    ? `\n\n# This customer\nWhatsApp number: ${context.customerPhone} (use it as the order phone if the customer says to use this number).`
    : "";
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    {
      role: "developer",
      content: `${INSTRUCTIONS}${catalogForPrompt()}\n\n# Knowledge documents\n\n${loadKnowledge()}${aboutCustomer}`,
    },
    ...history.map((turn): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      if (turn.role === "business") return { role: "assistant", content: turn.text };
      if (!turn.image) return { role: "user", content: turn.text };
      return {
        role: "user",
        content: [
          { type: "text", text: turn.text },
          // "low" detail is enough to tell colors and models apart, and costs a fraction of "high".
          { type: "image_url", image_url: { url: turn.image, detail: "low" } },
        ],
      };
    }),
  ];

  client ??= new OpenAI();
  const startedAt = Date.now();
  const usage: AiUsage = {
    model: config.openai.model,
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    latencyMs: 0,
  };
  const knownPhotos = new Set(listCatalog().map((p) => p.id));
  const photos: string[] = [];

  // The model may first ask to send photos and then write its text, so allow a few rounds.
  for (let round = 0; round < 3; round++) {
    const completion = await client.chat.completions.create({
      model: config.openai.model,
      reasoning_effort: config.openai.reasoningEffort,
      messages,
      tools: knownPhotos.size ? [HANDOFF_TOOL, ORDER_TOOL, PHOTOS_TOOL] : [HANDOFF_TOOL, ORDER_TOOL],
      tool_choice: "auto",
    });
    usage.model = completion.model;
    usage.promptTokens += completion.usage?.prompt_tokens ?? 0;
    usage.cachedTokens += completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    usage.completionTokens += completion.usage?.completion_tokens ?? 0;
    usage.reasoningTokens += completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    usage.latencyMs = Date.now() - startedAt;

    const message = completion.choices[0]?.message;
    const photoCalls = (message?.tool_calls ?? []).filter(
      (call) => call.type === "function" && call.function.name === "send_product_photos",
    );
    const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];
    for (const call of photoCalls) {
      if (call.type !== "function") continue;
      let ids: string[] = [];
      try {
        ids = (JSON.parse(call.function.arguments) as { photo_ids?: string[] }).photo_ids ?? [];
      } catch {}
      const valid = ids.filter((id) => knownPhotos.has(id) && !photos.includes(id));
      photos.push(...valid);
      toolResults.push({
        role: "tool",
        tool_call_id: call.id,
        content: valid.length
          ? `These photos will be sent first: ${valid.join(", ")}. Now write the short text that follows them (it appears below the photos), or an empty reply if the photos say enough.`
          : "No valid photo ids. Use ids from the product photo list.",
      });
    }

    const decision = readDecision(message);
    if (decision.action === "reply") return { ...decision, photos, usage };
    if (decision.action === "order") return { ...decision, usage };
    const emptyReply = decision.reason === EMPTY;
    if (!emptyReply) return { ...decision, usage }; // a real handoff wins over photos
    if (!photoCalls.length || !message) {
      // Photos alone are a fine answer ("here are the colors").
      return photos.length ? { action: "reply", text: "", photos, usage } : { ...decision, usage };
    }
    // The model only asked for photos: tell it they're queued, so it writes the text next.
    messages.push(message, ...toolResults);
  }
  return { ...handoff("AI kept calling tools without answering"), usage };
}

const EMPTY = "AI returned an empty reply";

function readDecision(message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined): AgentDecision {
  if (!message) {
    return handoff("AI returned no answer");
  }

  const orderCall = message.tool_calls?.find(
    (call) => call.type === "function" && call.function.name === "submit_order",
  );
  if (orderCall && orderCall.type === "function") {
    try {
      const a = JSON.parse(orderCall.function.arguments) as {
        customer_name: string;
        phone: string;
        city: string;
        address: string;
        items: OrderItem[];
        total: string;
        notes: string;
        message_to_customer: string;
      };
      return {
        action: "order",
        order: {
          name: a.customer_name,
          phone: a.phone,
          city: a.city,
          address: a.address,
          items: a.items,
          total: a.total,
          notes: a.notes,
        },
        messageToCustomer: a.message_to_customer,
      };
    } catch {
      return handoff("AI order arguments were not valid JSON");
    }
  }

  const toolCall = message.tool_calls?.find(
    (call) => call.type === "function" && call.function.name === "handoff_to_human",
  );
  if (toolCall && toolCall.type === "function") {
    try {
      const args = JSON.parse(toolCall.function.arguments) as {
        reason?: unknown;
        message_to_customer?: unknown;
      };
      return {
        action: "handoff",
        reason: typeof args.reason === "string" ? args.reason : "No reason given",
        messageToCustomer:
          typeof args.message_to_customer === "string" ? args.message_to_customer : "",
      };
    } catch {
      return handoff("AI handoff arguments were not valid JSON");
    }
  }

  const text = message.content?.trim();
  if (message.refusal || !text) {
    return handoff(message.refusal ? `AI refused: ${message.refusal}` : EMPTY);
  }
  return { action: "reply", text, photos: [] };
}

// Fallback handoff when the AI itself fails; the caller sends a default customer message.
function handoff(reason: string): AgentDecision {
  return { action: "handoff", reason, messageToCustomer: "" };
}
