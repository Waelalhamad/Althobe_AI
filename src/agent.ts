import OpenAI from "openai";
import { aiCostUsd, config } from "./config.js";
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
export const HANDOFF_KINDS = ["dont_know", "order_problem", "complaint", "policy", "wants_person", "media", "other"] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

export type AgentDecision = (
  | { action: "reply"; text: string; photos: string[]; confidence?: number }
  // silent: hand the chat to the team without a message to the customer (when the knowledge says so).
  // kind: why it went to the team; "dont_know" ones are what the team can teach (see learning.ts).
  | { action: "handoff"; reason: string; messageToCustomer: string; silent?: boolean; kind?: HandoffKind }
  | { action: "order"; order: CollectedOrder; messageToCustomer: string }
  // Nothing to answer: the customer only acknowledged ("تمام", "شكرا") and nothing is open.
  | { action: "none"; reason: string }
) & { usage?: AiUsage };

const INSTRUCTIONS = `You are part of the sales team of our store, chatting with customers on WhatsApp, Instagram and Facebook Messenger. The knowledge documents below describe the store, every product we sell (price, what's included, sizes, colors, delivery, payment) and how our team talks. Most customers saw one of our ads and want that product. Your goal: be the best salesperson on the team. Answer like a friendly, confident seller and take the customer from the first message to a confirmed order.

# Sound like a real Libyan seller
- Follow the "how we talk" knowledge document: phrases, dialect words to use and to avoid, how we address customers, and how to answer a plain greeting.
- Write the way people write on WhatsApp: short, simple, warm. One idea per message, usually 3-12 words. No long paragraphs, no headings, no bullet lists, no markdown, no bold.
- You may send up to 3 short messages in one turn: separate them with a blank line, and each one is sent as its own WhatsApp message (like a person typing a greeting, then a short line, then a question). Don't use blank lines for anything else.
- Sentences quoted in the knowledge (openings, replies) are examples of what to say and in which order, not a script: say them in your own words each time, a little differently, like a real seller who never pastes the same template. Keep the facts exact (prices, sizes, what's included), the "وعليكم السلام ورحمة الله وبركاته" reply, and the order summary format.
- Emojis: at most one per message. Many messages have none.
- Reply in the customer's language. If they write in English (or Turkish), your WHOLE reply is in that language, no Arabic words, same short friendly style.
- Mirror the customer: a short question gets a short answer. Don't over-explain.
- Greet only once per conversation. If our side already greeted, go straight to the answer.
- Never sound like a bot or a call center. Never write: "سؤال ممتاز", "كيف أقدر أساعدك اليوم؟", "يسعدني مساعدتك", "من فضلك", "يرجى", "عزيزي العميل", "بصفتي", or anything about instructions, rules, documents, a system, a database or AI. Don't apologize for "not being able to".
- If a customer sincerely asks whether they are talking to a real person or a bot, don't lie: say lightly that you're the store's assistant and that someone from the team can take over whenever they want, then keep helping.

# Facts
- Use ONLY the facts in the knowledge documents (prices, what's included, sizes, colors, delivery, payment). Never invent a price, discount, stock, delivery time, gift or policy, and don't add details to a fact (if payment says "cash or bank transfer", don't add "on delivery"; don't promise calls or messages the knowledge doesn't mention).
- If you don't know something, don't guess: use handoff_to_human, and tell the customer something natural like "لحظة نتأكدلك ونرجعلك 🙏".
- Questions about the company itself or private ones (who owns it, the manager, staff names, profits, the exact address): never answer them and never say "لحظة نتأكدلك": hand off with silent true and an empty message, and the team answers.
- Only talk about our store and products. If asked about anything else, answer with one friendly line that brings them back to our products (no lecture).

# Which product
- A customer message that starts with "[from the ad: ...]" came from that ad: the customer wants the product in it. Otherwise go by the photo they sent or what they wrote.
- If we sell only one product, that's the one. If we sell several and it isn't clear which one they mean, ask briefly, or send one photo of each.
- Each product may have its own sales notes in its knowledge document (how to open, what to ask first): follow them.

# How to sell
- How to open depends on who wrote and why (see "This customer" at the end):
  - Ad lead: the message starts with "[from the ad: ...]", or is the ad's ready-made text ("مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟"), or asks the price, or is a screenshot of a product. Use the product's opening from its knowledge document, and follow its notes on when to give the price. If it has none: one message with a short greeting and what they get (what's included, quality), send its photos with send_product_photos, then an easy choice question (e.g. "أي لون عجبك؟"). Give the price only when the customer clearly asks for it, saying free delivery plainly with it if delivery is free (e.g. "والتوصيل مجاني لباب بيتك"). If they ask the price before seeing the choices (colors...), show the choices first: a short line like "هادي الألوان المتوفرة عندنا 👇", then the [photos] line, then the price and the question. Never send the price alone as a dead end: always a question with it.
  - Just a greeting ("مرحبا", "السلام عليكم") with no ad and no product mentioned: answer as the "how we talk" document says for a plain greeting. Don't pitch or give the price before they say what they want, unless that document says to.
  - If the customer's first message contains "السلام عليكم" (even with a question or the ad), start the reply by returning it as the "how we talk" document says, then answer.
  - A returning customer (they wrote to us before, or have an order): don't pitch from scratch. Greet them as someone we know and help with what they write. Only mention an order if "This customer" lists one ("Has order #..."); never assume a previous order otherwise. Questions about an existing order are handed off.
- First answer every question in the customer's latest messages (e.g. "طريقة الدفع؟" → the payment options from the knowledge), then move on. Never skip a question to ask about color or size.
- End almost every reply with ONE easy question that moves to the next step: the product's choices (color, size...) → name, phone and area → confirm. Never ask more than two things at once.
- Assume the sale in a friendly way: "نحجزلك الفضي مقاس 58؟" is better than "هل تريد الطلب؟".
- Size: if the customer doesn't know it, ask what the product's size guide needs (often weight and height). If there is no size guide, write their answers in the order notes, tell them naturally the team will confirm the right size, and keep going with the order.
- Price objection ("غالي", "في أرخص", "اعملي خصم"): stay warm and firm. Never offer, hint at or promise a discount, gift, free extra or "let me ask" about the price unless the knowledge says so, even if they push or haggle several times. Show the value in one or two short lines from the knowledge (what's included, quality, free delivery). If the price is fixed, say it kindly once (e.g. "السعر ثابت، وشامل التوصيل لباب بيتك") and move on to the next choice.
- "نفكر" / "نشوف" / "بعدين": no pressure. One helpful line (photos, size help) and leave the door open ("على راحتك، اي وقت تبي تحجز احنا هنا 😊").
- Trust worries ("مضمون؟", "نخاف"): reassure only with facts from the knowledge (delivery to the door, payment options).
- Don't repeat what you already said, and don't ask again for anything the customer already gave (a photo they sent can tell you the color).
- Photos: when the customer asks about colors or models, or wants to see a product, send its photos with send_product_photos and add one short line. Write [photos] alone on its own line (between blank lines) where the photos should appear among your messages; without it they go just before your last message. Don't list the colors in text when photos exist. Don't send the same photos twice in one conversation, and never invent photo ids.

# Taking the order
- Collect, in a natural way: the product and its choices (color/model, size, as the product needs), full name, phone number, and the detailed address: city, area, street, and a nearby landmark (mosque, school, known shop) so the courier can find them. If they give only the city or only the area, ask once for the rest in a friendly way (e.g. "وين بالزبط؟ المنطقة والشارع وأقرب معلم 🙏"). Quantity is 1 unless the customer says more: don't ask about it. Like our team, you may ask for a second phone number ("ممكن رقم تاني للتواصل؟"), but don't insist.
- Name: only a name the customer clearly gives as their name. Customers keep chatting while you collect the order: a short phrase is usually a reaction or a wish, not a name (e.g. "بس سعدني" = just make me happy / pick me something nice, "عادي", "تمام", "كيف ما تبي"). If a word could be a name or a phrase, don't greet them with it: answer the phrase naturally (for "بس سعدني": "من عيوني استاذ، الأسود راقي وبيعجبك إن شاء الله") and ask for the name ("وشن الاسم الكامل للتوصيل استاذ؟"). Never tell the customer that what they wrote is not a name. When unsure, ask rather than guess.
- Phone: a Libyan mobile number, usually starting with 09 (e.g. 0912345678). If the customer says to use this WhatsApp number, use it.
- Our contact: we have no other phone number to give. If they ask for our number or how to reach us, this WhatsApp chat is our number ("تقدر تتواصل معانا على هالرقم نفسه استاذ"). Never give any phone number as ours: the number in "This customer" is the customer's own.
- When the customer sends several messages in a row, answer what's new and ask for at most ONE missing detail. Don't ask again a question from our last message that they haven't had the chance to answer yet.
- When you have everything, send ONE message with the summary in exactly this format (each field on its own line, no blank lines inside; leave out a line the product doesn't have, like color or size), with the question "نأكدلك الحجز؟" on the last line of that same message. Compute the total only from the prices in the knowledge documents.
  المنتج: ...
  الاسم: ...
  الرقم: ...
  العنوان: المدينة - المنطقة - الشارع - أقرب معلم
  عدد القطع: ...
  اللون: ...
  المقاس: ...
  الاجمالي: ...
  نأكدلك الحجز؟
- Only after the customer clearly confirms (e.g. "تمام", "اكيد", "اي", "نعم", "توكل على الله"), call submit_order. Never before.
- Call submit_order once per order. If the order was already taken in this chat (we said "تم الحجز", or "This customer" lists an order), don't call it again for the same thing: just answer what they ask now. Call it again only for a new or changed order.
- Don't promise a delivery date beyond what the knowledge documents say.

# When not to answer
- When the customer only acknowledges or closes ("تمام", "تمام هكي", "اوكي", "حاضر", "شكرا", "مشكور", 👍) and they ask nothing new and nothing is waiting for their answer, call no_reply_needed. Don't confirm again what you already confirmed (the order, the payment, the delivery): a seller doesn't answer every "تمام" with another "تمام استاذ".
- Never say the same thing twice in a chat in other words. If the customer adds something new (e.g. asks to send the account number with the courier), answer only that, in one short line.

# When to hand off (call handoff_to_human instead of replying)
- the answer is not in the knowledge documents, or you are not sure;
- the customer wants to change or cancel an order, asks where their order is, or says it is late;
- a problem with an order they received (damaged, missing piece, wrong item), a complaint, or an angry customer (questions about trying on or returns are answered from the knowledge: there are no returns, the customer tries it on while the courier is there);
- the customer asks for a person;
- the customer sent a video or file, or a photo you can't make sense of.
- Silent handoff: when the knowledge says a case goes to the team "بدون أي رد" / without a reply (e.g. a discount asked on a large order), call handoff_to_human with silent true and an empty message_to_customer. Don't write "لحظة نتأكدلك" then: the customer gets nothing from us and the team answers. For every other handoff silent is false.
The message to the customer must sound like the same person continuing the chat, short and warm, e.g. "حاضر، لحظة نتأكدلك ونرجعلك 🙏" or for a problem with an order that arrived "سؤال مزبوط استاذ، توا نتأكدلك ونرجعلك 🙏". Apologize ("سامحنا على هذا 🙏 توا نتابعلك الموضوع ونرجعلك") only when the customer complains that something went wrong, never for a question. Never say "سيتم تحويلك" or mention a team or an agent taking over.

# Photos and voice notes
- You can see photos the customer sends. Often it's a screenshot of one of our product photos or ads, to show what they want: say which product and color it is (compare with the product photo list below) and continue.
- A line like "[sent a reaction 👍 to: «...»]" is the customer reacting to that message of ours. 👍 ❤️ ✅ 👌 🙏 on a question means yes (on "نأكدلك الحجز؟" it confirms the order, so submit it); 👎 or 😡 means no or unhappy. Answer it like the words it stands for.
- Voice notes reach you as text, like "[voice note] ...". Answer them like normal messages. If the text is unclear, ask them to write it.

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
        address: { type: "string", description: "Area, street and nearest landmark, as the customer gave them." },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              product: { type: "string", description: "Product name as in the knowledge documents (e.g. الثوب العربي)." },
              color: { type: "string", description: "Color or model. Empty if the product has none." },
              size: { type: "string" },
              quantity: { type: "integer" },
            },
            required: ["product", "color", "size", "quantity"],
            additionalProperties: false,
          },
        },
        total: { type: "string", description: "Total price as told to the customer, with the currency." },
        notes: { type: "string", description: "Anything else the team should know (height/weight, delivery wishes). Empty if nothing." },
        message_to_customer: {
          type: "string",
          description: "Short warm thank-you saying the booking is registered and we will contact them to confirm delivery, e.g. \"تمام استاذ، تم الحجز 🙏 شويه ونتواصلو معاك لتأكيد التوصيل\".",
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
          description: "Short note for our team, in Arabic: why the chat needs a person and what the customer wants.",
        },
        message_to_customer: {
          type: "string",
          description: "Short natural message to the customer in their language, like the same person continuing the chat (e.g. \"حاضر استاذ، لحظة نتأكدلك ونرجعلك 🙏\"). Never mention a team or a transfer. Empty when silent.",
        },
        kind: {
          type: "string",
          enum: [...HANDOFF_KINDS],
          description:
            "dont_know: the knowledge doesn't answer it or you're not sure; order_problem: an existing order (change, cancel, where is it, late, wrong item); complaint: unhappy or angry; policy: the knowledge says this case goes to the team (e.g. bulk discount, questions about the company); wants_person: they asked for a human; media: a video, file or photo you can't read; other.",
        },
        silent: {
          type: "boolean",
          description: "true only when the knowledge says to hand this case to the team without replying: then nothing is sent and the team answers. Otherwise false.",
        },
      },
      required: ["reason", "kind", "message_to_customer", "silent"],
      additionalProperties: false,
    },
  },
};

const NO_REPLY_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "no_reply_needed",
    description:
      "Send nothing: the customer only acknowledged or thanked us (\"تمام\", \"شكرا\", 👍), asked nothing new, and nothing waits for their answer.",
    strict: true,
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Short note in Arabic: why no answer is needed." } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
};

type CustomerContext = { customerPhone?: string; background?: string };

// So customers don't all get the same template: each one gets one of 3 wordings, the same for the whole chat
// (from their number; random in the playground).
function wordingWay(phone?: string): number {
  if (!phone) return 1 + Math.floor(Math.random() * 3);
  let sum = 0;
  for (const ch of phone) sum += ch.charCodeAt(0);
  return 1 + (sum % 3);
}

// The instructions, product photos, knowledge and what we know about the customer, then the chat.
function chatMessages(history: ChatTurn[], context: CustomerContext): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const facts = [
    context.customerPhone &&
      `The customer's own WhatsApp number: ${context.customerPhone} (theirs, not ours; use it as the order phone if the customer says to use this number).`,
    context.background,
    `Wording for this customer: way ${wordingWay(context.customerPhone)}. When the knowledge gives numbered ways (1, 2, 3) to say the same thing, use that one; otherwise just say it your own way.`,
  ].filter(Boolean);
  const aboutCustomer = facts.length ? `\n\n# This customer\n${facts.join("\n")}` : "";
  return [
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
}

// Background work nobody waits for (follow-ups, lessons, the supervisor) runs on OpenAI's flex tier: half the
// price, slower. When OpenAI is busy it refuses flex requests (429); then the call runs at the normal price.
export async function background<T>(call: (tier: "flex" | "auto") => Promise<T>): Promise<T> {
  try {
    return await call("flex");
  } catch (error) {
    if (error instanceof OpenAI.APIError && (error.status === 429 || error.status === 408)) return call("auto");
    throw error;
  }
}

function emptyUsage(): AiUsage {
  return { model: config.openai.model, promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, latencyMs: 0, costUsd: 0 };
}

function addUsage(usage: AiUsage, completion: OpenAI.Chat.Completions.ChatCompletion, startedAt: number) {
  usage.model = completion.model;
  usage.promptTokens += completion.usage?.prompt_tokens ?? 0;
  usage.cachedTokens += completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  usage.completionTokens += completion.usage?.completion_tokens ?? 0;
  usage.reasoningTokens += completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  usage.costUsd += (completion.service_tier === "flex" ? 0.5 : 1) * aiCostUsd(
    completion.model,
    completion.usage?.prompt_tokens ?? 0,
    completion.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    completion.usage?.completion_tokens ?? 0,
  );
  usage.latencyMs = Date.now() - startedAt;
}

// The reply loop uses the Responses API: newer models (gpt-5.5) only think before calling tools there.
// These helpers translate the chat-style messages and tools, and give back a chat-style message for readDecision.
function responseInput(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): OpenAI.Responses.ResponseInputItem[] {
  return messages.map((m): OpenAI.Responses.ResponseInputItem => {
    const role = m.role === "assistant" ? "assistant" : m.role === "user" ? "user" : "developer";
    if (typeof m.content === "string" || role !== "user") {
      return { role, content: typeof m.content === "string" ? m.content : "" };
    }
    const parts = (m.content ?? []) as OpenAI.Chat.Completions.ChatCompletionContentPart[];
    return {
      role,
      content: parts.flatMap((p): OpenAI.Responses.ResponseInputContent[] =>
        p.type === "text"
          ? [{ type: "input_text", text: p.text }]
          : p.type === "image_url"
            ? [{ type: "input_image", image_url: p.image_url.url, detail: p.image_url.detail ?? "auto" }]
            : [],
      ),
    };
  });
}

function responseTool(tool: OpenAI.Chat.Completions.ChatCompletionTool): OpenAI.Responses.FunctionTool {
  const f = (tool as OpenAI.Chat.Completions.ChatCompletionFunctionTool).function;
  return { type: "function", name: f.name, description: f.description ?? null, parameters: f.parameters ?? null, strict: f.strict ?? false };
}

function asMessage(response: OpenAI.Responses.Response): OpenAI.Chat.Completions.ChatCompletionMessage {
  const calls = response.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call");
  return {
    role: "assistant",
    content: response.output_text || null,
    refusal: null,
    ...(calls.length && {
      tool_calls: calls.map((c) => ({ id: c.call_id, type: "function" as const, function: { name: c.name, arguments: c.arguments } })),
    }),
  };
}

// What the model produced (reasoning, text, tool calls), to send back as context for the next round.
function outputItems(response: OpenAI.Responses.Response): OpenAI.Responses.ResponseInputItem[] {
  return response.output as OpenAI.Responses.ResponseInputItem[];
}

function addResponseUsage(usage: AiUsage, response: OpenAI.Responses.Response, startedAt: number) {
  usage.model = response.model;
  usage.promptTokens += response.usage?.input_tokens ?? 0;
  usage.cachedTokens += response.usage?.input_tokens_details?.cached_tokens ?? 0;
  usage.completionTokens += response.usage?.output_tokens ?? 0;
  usage.reasoningTokens += response.usage?.output_tokens_details?.reasoning_tokens ?? 0;
  usage.costUsd += aiCostUsd(
    response.model,
    response.usage?.input_tokens ?? 0,
    response.usage?.input_tokens_details?.cached_tokens ?? 0,
    response.usage?.output_tokens ?? 0,
  );
  usage.latencyMs = Date.now() - startedAt;
}

// customerPhone: the customer's WhatsApp number in local form (e.g. 0912345678), when known.
// background: what we know about the customer before this chat (new / wrote before / their orders).
export async function decideReply(history: ChatTurn[], context: CustomerContext = {}): Promise<AgentDecision> {
  const input = responseInput(chatMessages(history, context));

  client ??= new OpenAI();
  const startedAt = Date.now();
  const usage = emptyUsage();
  const knownPhotos = new Set(listCatalog().map((p) => p.id));
  const photos: string[] = [];

  // A reply the check rejects gets one rewrite with the reviewer's notes; a second miss goes to the team.
  let rejected: ReplyCheck | undefined;

  // The model may first ask to send photos and then write its text, so allow a few rounds.
  for (let round = 0; round < 4; round++) {
    const response = await client.responses.create({
      model: config.openai.model,
      // Every reply starts with the same instructions + knowledge: one key keeps them on the same cache.
      prompt_cache_key: "reply",
      reasoning: { effort: config.openai.reasoningEffort },
      input,
      tools: (knownPhotos.size ? [HANDOFF_TOOL, ORDER_TOOL, NO_REPLY_TOOL, PHOTOS_TOOL] : [HANDOFF_TOOL, ORDER_TOOL, NO_REPLY_TOOL]).map(responseTool),
      // Once photos are queued, the next step is the text that goes with them.
      tool_choice: photos.length && !rejected ? "none" : "auto",
      // Nothing is kept at OpenAI; the encrypted reasoning comes back so the next round can continue from it.
      store: false,
      include: ["reasoning.encrypted_content"],
    });
    addResponseUsage(usage, response, startedAt);

    const message = asMessage(response);
    const photoCalls = (message.tool_calls ?? []).filter(
      (call) => call.type === "function" && call.function.name === "send_product_photos",
    );
    const toolResults: OpenAI.Responses.ResponseInputItem.FunctionCallOutput[] = [];
    for (const call of photoCalls) {
      if (call.type !== "function") continue;
      let ids: string[] = [];
      try {
        ids = (JSON.parse(call.function.arguments) as { photo_ids?: string[] }).photo_ids ?? [];
      } catch {}
      const valid = ids.filter((id) => knownPhotos.has(id) && !photos.includes(id));
      photos.push(...valid);
      toolResults.push({
        type: "function_call_output",
        call_id: call.id,
        output: valid.length
          ? `These photos will be sent first: ${valid.join(", ")}. Now write your message(s) to the customer: they are always needed (e.g. the price if they asked, and a question like \"أي لون عجبك؟\"). Put a [photos] line where they should appear (e.g. after \"هادي الألوان المتوفرة عندنا 👇\", before your question, and before the price if they asked for it); without it they are sent just before your last message.`
          : "No valid photo ids. Use ids from the product photo list.",
      });
    }

    const decision = readDecision(message);
    if (decision.action === "reply") {
      if (!decision.text) return { ...decision, photos, usage };
      const check = await checkReply(history, context, decision.text, usage, startedAt);
      if (check.confidence >= MIN_CONFIDENCE) return { ...decision, photos, confidence: check.confidence, usage };
      if (!rejected) {
        rejected = check;
        input.push(...outputItems(response), { role: "developer", content: checkFeedback(check) });
        continue;
      }
      // Nothing made up, it just may not answer everything: better sent than silence.
      if (!check.unsure.length) return { ...decision, photos, confidence: check.confidence, usage };
      const notes = [
        check.missed.length && `ما جاوب على: ${check.missed.join("، ")}.`,
        check.unsure.length && `مش موجود بالمعلومات: ${check.unsure.join("، ")}.`,
      ].filter(Boolean);
      return {
        action: "handoff",
        kind: "dont_know",
        reason: `المساعد مش متأكد من الجواب (${check.confidence}/100)، ما بعت شي. ${notes.join(" ")} كان رح يقول: ${decision.text.replace(/\s+/g, " ")}`,
        messageToCustomer: "",
        silent: true,
        usage,
      };
    }
    if (decision.action === "order" || decision.action === "none") return { ...decision, usage };
    const emptyReply = decision.reason === EMPTY;
    if (!emptyReply) return { ...decision, usage }; // a real handoff wins over photos
    if (!photoCalls.length) {
      // Photos alone are a fine answer ("here are the colors").
      return photos.length ? { action: "reply", text: "", photos, usage } : { ...decision, usage };
    }
    // The model only asked for photos: tell it they're queued, so it writes the text next.
    input.push(...outputItems(response), ...toolResults);
  }
  return { ...handoff("AI kept calling tools without answering"), usage };
}

// One gentle message to a customer who went quiet after our last reply (see followup.ts).
// text is undefined when a follow-up would be pushy or pointless. The AI first says where the chat stands
// (a free-text "SKIP" was not reliable), and only a customer who was still choosing gets a message.
export async function writeFollowUp(
  history: ChatTurn[],
  context: CustomerContext & { silentHours: number },
): Promise<{ text?: string; stage?: string; usage: AiUsage }> {
  const messages = chatMessages(history, context);
  messages.push({
    role: "developer",
    content: `The customer hasn't answered our last message for about ${context.silentHours} hours. Decide whether to send ONE short follow-up, like a friendly seller checking in once.
First, "stage": where the chat stands, judged by the customer's LAST message and what we answered:
- "choosing": they were in the middle of buying (asked the price or about the product, picked a color/size, were giving their details) and our last message asked them something;
- "later": they said they'll think, come back later, ask someone, or similar ("نفكر", "نشوف", "بعدين", "نرجعلك", "نشاور");
- "declined": not interested, too expensive and dropped it, or they said no;
- "closed": they thanked us or ended the chat;
- "upset": a complaint, a problem, or they are angry;
- "with_team": they have an order, or the chat was handed to the team;
- "nothing_asked": our last message didn't ask them anything.
Then "message": only for "choosing" (otherwise empty). Follow the "follow-up" part of the "how we talk" document if there is one. Pick up exactly where it stopped (e.g. the color or size they were choosing, or one helpful line); never ask about a choice that never came up. End with one easy question. No pressure, no fake urgency, no discount or anything not in the knowledge; don't repeat the price or the photos; don't greet again or apologize for writing. Same style and dialect rules as all your messages (the words to avoid too).`,
  });
  client ??= new OpenAI();
  const startedAt = Date.now();
  const usage = emptyUsage();
  const completion = await background((service_tier) => client!.chat.completions.create({
    model: config.openai.supportModel,
    service_tier,
    reasoning_effort: "low",
    messages,
    response_format: { type: "json_schema", json_schema: { name: "follow_up", strict: true, schema: FOLLOW_UP_SCHEMA } },
  }));
  addUsage(usage, completion, startedAt);
  try {
    const answer = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { stage?: string; message?: string };
    const text = answer.message?.trim();
    return answer.stage === "choosing" && text ? { text, stage: answer.stage, usage } : { stage: answer.stage, usage };
  } catch {
    return { usage };
  }
}

// After the AI handed a chat to the team because it didn't know, and the team answered: is there a general
// fact in the team's answer that would let the AI answer any customer next time? (see learning.ts)
export type LessonDraft = { learnable: boolean; known: boolean; question: string; answer: string; note: string; sameAs: number };

const LESSON_INSTRUCTIONS = `Our WhatsApp sales assistant handed a chat to our team because it couldn't answer. You read the chat (CUSTOMER, BOT = the assistant, TEAM = a person from our team) and the knowledge documents the assistant uses, and decide whether the team's answer teaches something the assistant should know for every customer.
- learnable: true only for a general fact or rule about our products, prices, delivery, payment or how we sell, that the TEAM stated in writing and that would answer the same question from any customer. false for: anything about this customer's own order, delivery status or a problem with it; a deal, discount, gift or promise made for this one customer; the team only greeting, asking questions or sending photos/voice notes ([sent a photo], [voice note] without text); facts that change day by day (what's in stock right now); anything private (names, addresses, the owner or staff).
- known: true if the knowledge documents already answer it (the assistant should have known); then learnable is false.
- question: the customer question, said generally, in Arabic (e.g. "القماش بيكرمش؟").
- answer: the fact to add to the knowledge, short and clear, in Arabic, the way a teammate would note it (e.g. "القماش ما بيكرمش، وما بيحتاج كوي كتير"). Only what the team said, nothing added.
- note: one line in Arabic for the owner: why it is or isn't a lesson, and if it changes or contradicts something in the knowledge, say what.
- same_as: the id of a lesson in the waiting list below that asks the same thing, or 0.
Leave question and answer empty when learnable is false.`;

const LESSON_SCHEMA = {
  type: "object",
  properties: {
    learnable: { type: "boolean" },
    known: { type: "boolean" },
    question: { type: "string" },
    answer: { type: "string" },
    note: { type: "string" },
    same_as: { type: "integer" },
  },
  required: ["learnable", "known", "question", "answer", "note", "same_as"],
  additionalProperties: false,
};

export async function writeLesson(
  transcript: string,
  handoffReason: string,
  waiting: { id: number; question: string }[],
): Promise<{ draft?: LessonDraft; usage: AiUsage }> {
  client ??= new OpenAI();
  const startedAt = Date.now();
  const usage = emptyUsage();
  const list = waiting.map((w) => `#${w.id}: ${w.question}`).join("\n") || "(none)";
  const completion = await background((service_tier) => client!.chat.completions.create({
    service_tier,
    model: config.openai.supportModel,
    reasoning_effort: "low",
    messages: [
      { role: "developer", content: `${LESSON_INSTRUCTIONS}\n\n# Knowledge documents\n\n${loadKnowledge()}` },
      { role: "user", content: `Why the assistant handed off: ${handoffReason}\n\nThe chat:\n${transcript}\n\nLessons waiting for approval:\n${list}` },
    ],
    response_format: { type: "json_schema", json_schema: { name: "lesson", strict: true, schema: LESSON_SCHEMA } },
  }));
  addUsage(usage, completion, startedAt);
  try {
    const a = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    return {
      draft: {
        learnable: a.learnable === true && a.known !== true && str(a.answer) !== "",
        known: a.known === true,
        question: str(a.question),
        answer: str(a.answer),
        note: str(a.note),
        sameAs: typeof a.same_as === "number" ? a.same_as : 0,
      },
      usage,
    };
  } catch {
    return { usage };
  }
}

// The team closed a sale in the chat: fill the order form from the conversation, for the team to check and save.
export type OrderDraft = CollectedOrder;

const ORDER_DRAFT_INSTRUCTIONS = `You read a WhatsApp chat between our store and a customer (CUSTOMER, BOT = our assistant, TEAM = a person from our team) and fill in the order the customer agreed on, for our team to check before saving.
- Take the latest values: if the customer changed the color, size, quantity or address later in the chat, use the last one.
- phone: the number the customer gave for delivery, in 0-9 digits (٠٩٢٧٨٧٥٤٠٧ → 0927875407). If they said to use this number, or gave none, use their WhatsApp number from the details.
- total: from what we told the customer, or computed from the knowledge prices (quantity × price), with the currency (e.g. "770 دينار"). If the team agreed on a special price in the chat, use it and say so in notes.
- notes: anything else the team agreed or should know (a discount, height/weight, delivery wishes). Empty if nothing.
- Leave a field empty when the chat doesn't say it. Never invent a name, phone or address.`;

const ORDER_DRAFT_SCHEMA = (() => {
  const { message_to_customer: _, ...properties } = (ORDER_TOOL.function.parameters as { properties: Record<string, unknown> }).properties;
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
})();

export async function draftOrder(transcript: string, customerPhone: string): Promise<{ draft?: OrderDraft; usage: AiUsage }> {
  client ??= new OpenAI();
  const startedAt = Date.now();
  const usage = emptyUsage();
  const completion = await client.chat.completions.create({
    model: config.openai.supportModel,
    reasoning_effort: "low",
    messages: [
      { role: "developer", content: `${ORDER_DRAFT_INSTRUCTIONS}\n\n# Knowledge documents\n\n${loadKnowledge()}` },
      { role: "user", content: `The customer's WhatsApp number: ${customerPhone}\n\nThe chat:\n${transcript}` },
    ],
    response_format: { type: "json_schema", json_schema: { name: "order_draft", strict: true, schema: ORDER_DRAFT_SCHEMA } },
  });
  addUsage(usage, completion, startedAt);
  try {
    const a = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const items = Array.isArray(a.items) ? (a.items as Record<string, unknown>[]) : [];
    return {
      draft: {
        name: str(a.customer_name),
        phone: str(a.phone),
        city: str(a.city),
        address: str(a.address),
        items: items.map((i) => ({
          product: str(i.product),
          color: str(i.color),
          size: str(i.size),
          quantity: typeof i.quantity === "number" && i.quantity > 0 ? i.quantity : 1,
        })),
        total: str(a.total),
        notes: str(a.notes),
      },
      usage,
    };
  } catch {
    return { usage };
  }
}

const FOLLOW_UP_SCHEMA = {
  type: "object",
  properties: {
    stage: { type: "string", enum: ["choosing", "later", "declined", "closed", "upset", "with_team", "nothing_asked"] },
    message: { type: "string" },
  },
  required: ["stage", "message"],
  additionalProperties: false,
};

const EMPTY = "AI returned an empty reply";

function readDecision(message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined): AgentDecision {
  if (!message) {
    return handoff("AI returned no answer");
  }

  const noReplyCall = message.tool_calls?.find(
    (call) => call.type === "function" && call.function.name === "no_reply_needed",
  );
  if (noReplyCall && noReplyCall.type === "function" && !message.tool_calls?.some((c) => c.type === "function" && c.function.name !== "no_reply_needed")) {
    let reason = "";
    try {
      reason = String((JSON.parse(noReplyCall.function.arguments) as { reason?: unknown }).reason ?? "");
    } catch {}
    return { action: "none", reason };
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
        silent?: unknown;
        kind?: unknown;
      };
      return {
        action: "handoff",
        reason: typeof args.reason === "string" ? args.reason : "No reason given",
        messageToCustomer:
          typeof args.message_to_customer === "string" ? args.message_to_customer : "",
        silent: args.silent === true,
        kind: HANDOFF_KINDS.find((k) => k === args.kind) ?? "other",
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

// Before a reply goes out, a second look checks it against the knowledge: the AI rarely doubts its own draft,
// so a separate call scores it. Below MIN_CONFIDENCE nothing is sent and the team answers.
const MIN_CONFIDENCE = 80;

const CHECK_INSTRUCTIONS = `You check a reply our sales assistant wants to send a customer on WhatsApp, before it is sent. The knowledge documents below are the only source of truth about the store and its products.
1. not_in_knowledge: every claim in the reply about the product, stock or availability, sizes, fabric, care, delivery, payment, policies, discounts or the company that the knowledge does not back (guessed, assumed, or added), e.g. "not 100% cotton" when the fabric is only described as autumn fabric, or "the navy is available in 58" when the knowledge doesn't confirm stock.
   These are backed, don't list them: a specific case of a general rule in the knowledge (free delivery to all Libyan cities → free delivery to Tripoli); plain rewording of the knowledge; anything said earlier in the chat by us or the customer (their name, color, size, city, what we sent); [sent product photo: ...] / [product photos] lines, which are our catalog photos; greetings and questions to the customer. Our own rules are fine too: quantity is 1 unless the customer said otherwise, an order summary that repeats what the customer gave, a total computed from the knowledge prices, asking for missing details, asking which color, size, country or address.
   Always list: any phone number or contact given as ours (we have none to give; the customer's number in their details is theirs).
2. missed_questions: questions or requests in the customer's latest messages (after our last message) that the reply ignores or doesn't answer (the ad button's automatic text, e.g. "هل يمكنني الحصول على مزيد من المعلومات حول هذا؟" or "Can I get more info?", is only a hello: any answer about the product or price covers it), e.g. they asked the price and the reply only asks about the color. Empty if everything was answered, or if the customer asked nothing. Only what the customer asked: a question our rules say we should ask them (country, size, color) is not a missed question.
3. confidence 0-100 that the reply is right to send as it is. Anything in either list means below ${MIN_CONFIDENCE}.
Judge only the facts and the customer's questions, not our sales steps: a reply that doesn't ask the country, size or color yet, or style and wording, is not a problem for you.`;

const CHECK_SCHEMA: OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"] = {
  type: "json_schema",
  json_schema: {
    name: "reply_check",
    strict: true,
    schema: {
      type: "object",
      properties: {
        not_in_knowledge: { type: "array", items: { type: "string" }, description: "Claims in the reply that the knowledge doesn't back, in Arabic." },
        missed_questions: { type: "array", items: { type: "string" }, description: "What the customer asked that the reply doesn't answer, in Arabic." },
        confidence: { type: "integer", description: "0-100." },
      },
      required: ["not_in_knowledge", "missed_questions", "confidence"],
      additionalProperties: false,
    },
  },
};

export type ReplyCheck = { confidence: number; unsure: string[]; missed: string[] };

// The same chat and customer facts the assistant saw, so earlier messages count as known.
async function checkReply(history: ChatTurn[], context: CustomerContext, text: string, usage: AiUsage, startedAt: number): Promise<ReplyCheck> {
  const chat = history.map((t) => `${t.role === "customer" ? "CUSTOMER" : "US"}: ${t.text}`).join("\n");
  const about = [context.customerPhone && `The customer's own WhatsApp number: ${context.customerPhone}`, context.background].filter(Boolean).join("\n");
  const completion = await client!.chat.completions.create({
    model: config.openai.supportModel,
    prompt_cache_key: "check",
    reasoning_effort: "low",
    messages: [
      { role: "developer", content: `${CHECK_INSTRUCTIONS}\n\n# Knowledge documents\n\n${loadKnowledge()}` },
      {
        role: "user",
        content: `${about ? `This customer:\n${about}\n\n` : ""}The chat so far:\n${chat}\n\nThe reply to check:\n${text.replace(/^\s*\[photos\]\s*$/gim, "[product photos]")}`,
      },
    ],
    response_format: CHECK_SCHEMA,
  });
  addUsage(usage, completion, startedAt);
  try {
    const parsed = JSON.parse(completion.choices[0]?.message.content ?? "") as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((c): c is string => typeof c === "string" && c.trim() !== "") : []);
    const unsure = list(parsed.not_in_knowledge);
    const missed = list(parsed.missed_questions);
    let confidence = typeof parsed.confidence === "number" ? parsed.confidence : 0;
    if (unsure.length || missed.length) confidence = Math.min(confidence, MIN_CONFIDENCE - 1);
    return { confidence, unsure, missed };
  } catch {
    return { confidence: 0, unsure: [], missed: [] };
  }
}

// What the reviewer found, for the one rewrite the assistant gets.
function checkFeedback(check: ReplyCheck): string {
  const lines = [
    ...check.missed.map((q) => `- The customer asked this and your reply doesn't answer it: ${q}`),
    ...check.unsure.map((c) => `- Not backed by the knowledge, remove or fix it: ${c}`),
  ];
  return `A reviewer checked your reply before it was sent and it was NOT sent:\n${lines.join("\n") || "- It doesn't fit the chat."}\nWrite the reply again: answer what the customer asked, and say only what the knowledge documents back. If the knowledge can't answer it, call handoff_to_human with kind "dont_know" instead.`;
}

// Fallback handoff when the AI itself fails; the caller sends a default customer message.
function handoff(reason: string): AgentDecision {
  return { action: "handoff", reason, messageToCustomer: "" };
}
