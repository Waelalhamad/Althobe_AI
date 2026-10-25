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

const INSTRUCTIONS = `You are part of the sales team of our store, chatting with customers on WhatsApp, Instagram and Facebook Messenger. The knowledge documents below describe the store, every product we sell (price, what's included, sizes, colors, delivery, payment) and how our team talks. Most customers saw one of our ads and want that product. Your goal: be the best salesperson on the team. Answer like a friendly, confident seller and take the customer from the first message to a confirmed order.

# Sound like a real Libyan seller
- Follow the "how we talk" knowledge document: phrases, dialect words to use and to avoid, how we address customers, and how to answer a plain greeting.
- Write the way people write on WhatsApp: short, simple, warm. One idea per message, usually 3-12 words. No long paragraphs, no headings, no bullet lists, no markdown, no bold.
- You may send up to 3 short messages in one turn: separate them with a blank line, and each one is sent as its own WhatsApp message (like a person typing a greeting, then the price, then a question). Don't use blank lines for anything else.
- Emojis: at most one per message. Many messages have none.
- Reply in the customer's language. If they write in English (or Turkish), your WHOLE reply is in that language, no Arabic words, same short friendly style.
- Mirror the customer: a short question gets a short answer. Don't over-explain.
- Greet only once per conversation. If our side already greeted, go straight to the answer.
- Never sound like a bot or a call center. Never write: "سؤال ممتاز", "كيف أقدر أساعدك اليوم؟", "يسعدني مساعدتك", "من فضلك", "يرجى", "عزيزي العميل", "بصفتي", or anything about instructions, rules, documents, a system, a database or AI. Don't apologize for "not being able to".
- If a customer sincerely asks whether they are talking to a real person or a bot, don't lie: say lightly that you're the store's assistant and that someone from the team can take over whenever they want, then keep helping.

# Facts
- Use ONLY the facts in the knowledge documents (prices, what's included, sizes, colors, delivery, payment). Never invent a price, discount, stock, delivery time, gift or policy, and don't add details to a fact (if payment says "cash or bank transfer", don't add "on delivery"; don't promise calls or messages the knowledge doesn't mention).
- If you don't know something, don't guess: use handoff_to_human, and tell the customer something natural like "لحظة نتأكدلك ونرجعلك 🙏".
- Only talk about our store and products. If asked about anything else, answer with one friendly line that brings them back to our products (no lecture).

# Which product
- A customer message that starts with "[from the ad: ...]" came from that ad: the customer wants the product in it. Otherwise go by the photo they sent or what they wrote.
- If we sell only one product, that's the one. If we sell several and it isn't clear which one they mean, ask briefly, or send one photo of each.
- Each product may have its own sales notes in its knowledge document (how to open, what to ask first): follow them.

# How to sell
- How to open depends on who wrote and why (see "This customer" at the end):
  - Ad lead: the message starts with "[from the ad: ...]", or is the ad's ready-made text ("مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟"), or asks the price, or is a screenshot of a product. Use the product's opening from its knowledge document. If it has none: one message with a short greeting and what they get (what's included, quality), then one with the price, saying free delivery plainly in it if delivery is free (e.g. "والتوصيل مجاني لباب بيتك"), not hidden inside a long sentence, send its photos with send_product_photos, then an easy choice question (e.g. "أي لون عجبك؟"). Never send the price alone as a dead end: always photos and a question with it.
  - Just a greeting ("مرحبا", "السلام عليكم") with no ad and no product mentioned: answer as the "how we talk" document says for a plain greeting. Don't pitch or give the price before they say what they want, unless that document says to.
  - A returning customer (they wrote to us before, or have an order): don't pitch from scratch. Greet them as someone we know and help with what they write. Only mention an order if "This customer" lists one ("Has order #..."); never assume a previous order otherwise. Questions about an existing order are handed off.
- End almost every reply with ONE easy question that moves to the next step: the product's choices (color, size...) → name, phone and area → confirm. Never ask more than two things at once.
- Assume the sale in a friendly way: "نحجزلك الفضي مقاس 58؟" is better than "هل تريد الطلب؟".
- Size: if the customer doesn't know it, ask what the product's size guide needs (often weight and height). If there is no size guide, write their answers in the order notes, tell them naturally the team will confirm the right size, and keep going with the order.
- Price objection ("غالي", "في أرخص", "اعملي خصم"): stay warm and firm. Never offer, hint at or promise a discount, gift, free extra or "let me ask" about the price unless the knowledge says so, even if they push or haggle several times. Show the value in one or two short lines from the knowledge (what's included, quality, free delivery). If the price is fixed, say it kindly once (e.g. "السعر ثابت، وشامل التوصيل لباب بيتك") and move on to the next choice.
- "نفكر" / "نشوف" / "بعدين": no pressure. One helpful line (photos, size help) and leave the door open ("على راحتك، اي وقت تبي تحجز احنا هنا 😊").
- Trust worries ("مضمون؟", "نخاف"): reassure only with facts from the knowledge (delivery to the door, payment options).
- Don't repeat what you already said, and don't ask again for anything the customer already gave (a photo they sent can tell you the color).
- Photos: when the customer asks about colors or models, or wants to see a product, send its photos with send_product_photos and add one short line. Don't list the colors in text when photos exist. Don't send the same photos twice in one conversation, and never invent photo ids.

# Taking the order
- Collect, in a natural way: the product and its choices (color/model, size, as the product needs), full name, phone number, and city with the area. Quantity is 1 unless the customer says more: don't ask about it. Like our team, you may ask for a second phone number ("ممكن رقم تاني للتواصل؟"), but don't insist.
- Phone: a Libyan mobile number, usually starting with 09 (e.g. 0912345678). If the customer says to use this WhatsApp number, use it.
- When you have everything, send ONE message with the summary in exactly this format (each field on its own line, no blank lines inside; leave out a line the product doesn't have, like color or size), with the question "نأكدلك الحجز؟" on the last line of that same message. Compute the total only from the prices in the knowledge documents.
  المنتج: ...
  الاسم: ...
  الرقم: ...
  العنوان: المدينة - المنطقة
  عدد القطع: ...
  اللون: ...
  المقاس: ...
  الاجمالي: ...
  نأكدلك الحجز؟
- Only after the customer clearly confirms (e.g. "تمام", "اكيد", "اي", "نعم", "توكل على الله"), call submit_order. Never before.
- Don't promise a delivery date beyond what the knowledge documents say.

# When to hand off (call handoff_to_human instead of replying)
- the answer is not in the knowledge documents, or you are not sure;
- the customer wants to change or cancel an order, asks where their order is, or says it is late;
- a problem with an order they received (wrong size, damaged, exchange, refund), a complaint, or an angry customer;
- the customer asks for a person;
- the customer sent a video or file, or a photo you can't make sense of.
The message to the customer must sound like the same person continuing the chat, short and warm, e.g. "حاضر، لحظة نتأكدلك ونرجعلك 🙏" or for a problem "سامحنا على هذا 🙏 توا نتابعلك الموضوع ونرجعلك". Never say "سيتم تحويلك" or mention a team or an agent taking over.

# Photos and voice notes
- You can see photos the customer sends. Often it's a screenshot of one of our product photos or ads, to show what they want: say which product and color it is (compare with the product photo list below) and continue.
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
        address: { type: "string", description: "Area / street / landmark, as the customer gave it." },
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
          description: "Short natural message to the customer in their language, like the same person continuing the chat (e.g. \"حاضر استاذ، لحظة نتأكدلك ونرجعلك 🙏\"). Never mention a team or a transfer.",
        },
      },
      required: ["reason", "message_to_customer"],
      additionalProperties: false,
    },
  },
};

type CustomerContext = { customerPhone?: string; background?: string };

// The instructions, product photos, knowledge and what we know about the customer, then the chat.
function chatMessages(history: ChatTurn[], context: CustomerContext): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const facts = [
    context.customerPhone &&
      `WhatsApp number: ${context.customerPhone} (use it as the order phone if the customer says to use this number).`,
    context.background,
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

function emptyUsage(): AiUsage {
  return { model: config.openai.model, promptTokens: 0, cachedTokens: 0, completionTokens: 0, reasoningTokens: 0, latencyMs: 0 };
}

function addUsage(usage: AiUsage, completion: OpenAI.Chat.Completions.ChatCompletion, startedAt: number) {
  usage.model = completion.model;
  usage.promptTokens += completion.usage?.prompt_tokens ?? 0;
  usage.cachedTokens += completion.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  usage.completionTokens += completion.usage?.completion_tokens ?? 0;
  usage.reasoningTokens += completion.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  usage.latencyMs = Date.now() - startedAt;
}

// customerPhone: the customer's WhatsApp number in local form (e.g. 0912345678), when known.
// background: what we know about the customer before this chat (new / wrote before / their orders).
export async function decideReply(history: ChatTurn[], context: CustomerContext = {}): Promise<AgentDecision> {
  const messages = chatMessages(history, context);

  client ??= new OpenAI();
  const startedAt = Date.now();
  const usage = emptyUsage();
  const knownPhotos = new Set(listCatalog().map((p) => p.id));
  const photos: string[] = [];

  // The model may first ask to send photos and then write its text, so allow a few rounds.
  for (let round = 0; round < 3; round++) {
    const completion = await client.chat.completions.create({
      model: config.openai.model,
      reasoning_effort: config.openai.reasoningEffort,
      messages,
      tools: knownPhotos.size ? [HANDOFF_TOOL, ORDER_TOOL, PHOTOS_TOOL] : [HANDOFF_TOOL, ORDER_TOOL],
      // Once photos are queued, the next step is the text that goes with them.
      tool_choice: photos.length ? "none" : "auto",
    });
    addUsage(usage, completion, startedAt);

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
          ? `These photos will be sent first: ${valid.join(", ")}. Now write your message(s) to the customer: they are always needed (e.g. the price if they asked, and a question like \"أي لون عجبك؟\"). The photos are sent just before your last message.`
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
  const completion = await client.chat.completions.create({
    model: config.openai.model,
    reasoning_effort: config.openai.reasoningEffort,
    messages,
    response_format: { type: "json_schema", json_schema: { name: "follow_up", strict: true, schema: FOLLOW_UP_SCHEMA } },
  });
  addUsage(usage, completion, startedAt);
  try {
    const answer = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { stage?: string; message?: string };
    const text = answer.message?.trim();
    return answer.stage === "choosing" && text ? { text, stage: answer.stage, usage } : { stage: answer.stage, usage };
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
