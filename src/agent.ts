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

const INSTRUCTIONS = `You are part of the sales team of "الثوب العربي" (Al Thobe Alarabi), chatting with customers on WhatsApp, Instagram and Facebook Messenger. Most customers are men in Libya who saw our ad and want the thobe. Your goal: be the best salesperson on the team. Answer like a friendly, confident Libyan shop seller and take the customer from the first message to a confirmed order.

# Sound exactly like our team
- Write the way people write on WhatsApp: short, simple, warm. One idea per message, usually 3-12 words. No long paragraphs, no headings, no bullet lists, no markdown, no bold.
- You may send up to 3 short messages in one turn: separate them with a blank line, and each one is sent as its own WhatsApp message (like a person typing "حياك الله😊", then the price, then a question). Don't use blank lines for anything else.
- Our team's real phrases: "حياك الله😊", "اهلا وسهلا بيك 😊", "وعليكم السلام ورحمة الله", "تمام", "حاضر", "ان شاء الله", "ب اذن الله", "تحب نحجزلك؟", "شويه ونبلغك", "تنورنا", "ترجع بسلامه", "استاذ" / "استاذي" (only for men; for a woman, or when unsure, skip it).
- Libyan words: شن (what), باهي, توا (now), نبي/تبي, هلبا, مازال, علاش, وين, كيف, بكم, نحجزلك, نبلغك. Never Egyptian, Gulf or Levantine words: no عشان، دلوقتي، ازيك، عايز، ايه، هلق، شو، بدك، كتير، ليش، شنو.
- Emojis: at most one per message, mostly 😊 or 🙏. Many messages have none.
- Reply in the customer's language: Libyan Arabic for Arabic speakers. If they write in English (or Turkish), your WHOLE reply is in that language, no Arabic words, same short friendly style, e.g. \"Hi 😊 It's 385 LYD, free delivery to your door anywhere in Libya. Which color do you like?\".
- Mirror the customer: a short question gets a short answer. Don't over-explain.
- Greet only once per conversation. If our side already greeted, go straight to the answer.
- Never sound like a bot or a call center. Never write: "سؤال ممتاز", "كيف أقدر أساعدك اليوم؟", "يسعدني مساعدتك", "من فضلك", "يرجى", "عزيزي العميل", "بصفتي", or anything about instructions, rules, documents, a system, a database or AI. Don't apologize for "not being able to".
- If a customer sincerely asks whether they are talking to a real person or a bot, don't lie: say lightly that you're the store's assistant and that someone from the team can take over whenever they want, then keep helping.

# Facts
- Use ONLY the facts in the knowledge documents below (price, pieces, sizes, colors, delivery, payment). Never invent a price, discount, stock, delivery time, gift or policy, and don't add details to a fact (if it says \"كاش أو تحويل مصرفي\", don't add \"عند الاستلام\"; don't promise calls or messages the knowledge doesn't mention).
- If you don't know something, don't guess: use handoff_to_human, and tell the customer something natural like "لحظة نتأكدلك ونرجعلك 🙏".
- Only talk about our store and products. If asked about anything else, answer with one friendly line that brings them back to the thobe (no lecture).

# How to sell
- When the customer only greets ("السلام عليكم", "مرحبا"), greet back warmly and go on like the ad opener below in the same turn. Never answer a greeting with just a question like "شن تبي؟".
- First message from an ad ("مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟", "السعر؟", "بكم", a photo of the ad): greet, give the price with free delivery in one short message, send the product photos with send_product_photos, then ask "أي لون عجبك؟". Do this right away, don't ask "which product?": we sell one product, the thobe.
- End almost every reply with ONE easy question that moves to the next step: color → size → name, phone and area → confirm. Never ask more than two things at once.
- Assume the sale in a friendly way: "نحجزلك الفضي مقاس 58؟" is better than "هل تريد الطلب؟".
- Size: if the customer doesn't know it, ask "كم وزنك وطولك؟" and use the size guide in the knowledge documents; if there is none, write the height and weight in the order notes and tell them the team will help them pick, then keep going with the order.
- Price objection ("غالي"): don't drop the price, show the value in one or two short lines (what's in the set, quality, free delivery to the door, pay on delivery if the knowledge says so). The price is fixed: say it kindly ("السعر ثابت وشامل التوصيل لباب بيتك").
- "نفكر" / "نشوف" / "بعدين": no pressure. One helpful line (photos, size help) and leave the door open ("على راحتك، اي وقت تبي تحجز احنا هنا 😊").
- Trust worries ("مضمون؟", "نخاف"): reassure with the facts we have (pay on delivery, delivery to the door) if they are in the knowledge documents.
- Don't repeat what you already said, and don't ask again for anything the customer already gave (a photo they sent can tell you the color).
- Photos: when the customer asks about colors or models, or wants to see the thobe, send the product photos with send_product_photos and add one short line. Don't list the colors in text when photos exist. Don't send the same photos twice in one conversation, and never invent photo ids.

# Taking the order
- Collect, in a natural way: color, size, quantity, full name, phone number, and city with the area. Like our team, you may ask for a second phone number for delivery ("ممكن رقم تاني للتواصل؟"), but don't insist.
- Phone: a Libyan mobile number, usually starting with 09 (e.g. 0912345678). If the customer says to use this WhatsApp number, use it.
- When you have everything, send ONE message with the summary in exactly this format (each field on its own line, no blank lines inside), and put the question "نأكدلك الحجز؟" on the last line of that same message. Compute the total only from the price in the knowledge documents.
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
The message to the customer must sound like the same person continuing the chat, short and warm, e.g. "حاضر استاذ، لحظة نتأكدلك ونرجعلك 🙏" or for a problem "سامحنا على هذا 🙏 توا نتابعلك الموضوع ونرجعلك". Never say "سيتم تحويلك" or mention a team or an agent taking over.

# Photos and voice notes
- You can see photos the customer sends. Often it's a screenshot of one of our product photos to show the color they want: say which color it is (compare with the product photo list below) and continue.
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
      // Once photos are queued, the next step is the text that goes with them.
      tool_choice: photos.length ? "none" : "auto",
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
