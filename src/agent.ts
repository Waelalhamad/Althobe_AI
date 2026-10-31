import OpenAI from "openai";
import { aiCostUsd, config } from "./config.js";
import { loadKnowledge } from "./knowledge.js";
import { catalogForPrompt, listCatalog, type CatalogItem } from "./catalog.js";
import { fileAsDataUrl } from "./media.js";
import { missingStock, stockForPrompt } from "./stock.js";
import { intlPhone } from "./darb.js";
import type { AiUsage, OrderItem, Payment } from "./store.js";

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
  payment?: Payment;
  // The customer's weight, when they gave it: an order whose sizes fit it can be confirmed without the team.
  weightKg?: number;
};

// photos: ids of catalog photos, sent before the text (see catalog.ts).
// order: the customer confirmed an order; it is saved and the team takes over to confirm it.
// The only cases the AI may hand to the team (see allowedHandoff); the rest it answers itself.
export const AI_HANDOFF_KINDS = ["discount", "order_problem", "payment", "abroad", "wants_person", "complaint"] as const;
// Older kinds stay readable, and the code's own handoffs (the AI failed, a wrong account number) are "other".
export const HANDOFF_KINDS = [...AI_HANDOFF_KINDS, "dont_know", "policy", "media", "other"] as const;
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
- Usually one message per turn, at most 2: separate them with a blank line, and each one is sent as its own WhatsApp message (photos can go between them with the [photos] line). Don't use blank lines for anything else.
- Sentences quoted in the knowledge (openings, replies) are examples of what to say and in which order, not a script: say them in your own words each time, a little differently, like a real seller who never pastes the same template. Keep the facts exact (prices, sizes, what's included), the "وعليكم السلام ورحمة الله وبركاته" reply, and the order summary format.
- Emojis: at most one per message. Many messages have none.
- Always reply in Arabic, in the Libyan dialect, whatever language the customer writes in (English, Franco-Arabic, anything): understand them and answer in Arabic. Never write an English sentence or word (except names that have no Arabic). If they ask for English, follow the "how we talk" document.
- Mirror the customer: a short question gets a short answer. Don't over-explain.
- Greet only once per conversation. If our side already greeted, go straight to the answer.
- Never sound like a bot or a call center. Never write: "سؤال ممتاز", "كيف أقدر أساعدك اليوم؟", "يسعدني مساعدتك", "من فضلك", "يرجى", "عزيزي العميل", "بصفتي", or anything about instructions, rules, documents, a system, a database or AI. Don't apologize for "not being able to".
- If a customer sincerely asks whether they are talking to a real person or a bot, don't lie: say lightly that you're the store's assistant and that someone from the team can take over whenever they want, then keep helping.

# Facts
- Use ONLY the facts in the knowledge documents (prices, what's included, sizes, colors, delivery, payment). Never invent a price, discount, stock, delivery time, gift or policy, and don't add details to a fact (if payment says "cash or bank transfer", don't add "on delivery"; don't promise calls or messages the knowledge doesn't mention).
- If the knowledge doesn't answer something, don't guess and don't hand off for it: say what the knowledge does say, or that you don't have that detail, and carry on with the sale. Never write "لحظة نتأكدلك" or "نرجعلك".
- Questions about the company itself or private ones (who owns it, the manager, staff names, profits, the exact address): never answer them: hand off with silent true and an empty message, and the team answers.
- Only talk about our store and products. If asked about anything else, answer with one friendly line that brings them back to our products (no lecture).

# Which product
- A customer message that starts with "[from the ad: ...]" came from that ad: the customer wants the product in it. Otherwise go by the photo they sent or what they wrote.
- If we sell only one product, that's the one. If we sell several and it isn't clear which one they mean, ask briefly, or send one photo of each.
- Each product may have its own sales notes in its knowledge document (how to open, what to ask first): follow them.

# How to sell
- How to open depends on who wrote and why (see "This customer" at the end):
  - Ad lead: the message starts with "[from the ad: ...]", or is the ad's ready-made text ("مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟"), or asks the price, or is a screenshot of a product. Use the product's opening from its knowledge document, and follow its notes on when and how to give the price (for our set: right away when they ask, with the try-before-you-pay and free delivery line, then the photos if they haven't seen them, then the question). If it has none: one message with a short greeting and what they get (what's included, quality), send its photos with send_product_photos, then an easy choice question (e.g. "شن اللون اللي عجبك؟"); give the price when they ask, with free delivery said plainly if delivery is free. Never send the price alone as a dead end: always a question with it.
  - Just a greeting ("مرحبا", "السلام عليكم") with no ad and no product mentioned: answer as the "how we talk" document says for a plain greeting. Don't pitch or give the price before they say what they want, unless that document says to.
  - If the customer's first message contains "السلام عليكم" (even with a question or the ad), start the reply by returning it as the "how we talk" document says, then answer.
  - A returning customer (they wrote to us before, or have an order): don't pitch from scratch. Greet them as someone we know and help with what they write. Only mention an order if "This customer" lists one ("Has order #..."); never assume a previous order otherwise. Questions about an existing order are handed off.
- First answer every question in the customer's latest messages (e.g. "طريقة الدفع؟" → the payment options from the knowledge), then move on. Never skip a question to ask about color or size.
- End almost every reply with ONE easy question that moves to the next step: the product's choices (color, size...) → name, phone and area → confirm. Never ask more than two things at once.
- Assume the sale in a friendly way: "نحجزلك الفضي مقاس 58؟" is better than "هل تريد الطلب؟".
- Size: if the customer doesn't know it, ask what the product's size guide needs (often weight and height). If there is no size guide, write their answers in the order notes, tell them naturally the team will confirm the right size, and keep going with the order.
- Weight: before the order summary we always know the customer's weight. If they picked their size themselves, ask once, lightly, with the next detail you need (e.g. "وكم وزنك تقريباً استاذ؟ باش نتأكدو المقاس يجي عليك 👌"). If the size guide gives another size for that weight, say kindly which one fits and let them choose; their choice wins. If the set is for someone else, ask that person's weight. Put the weight in submit_order's weight_kg and in the notes.
- Price objection ("غالي", "في أرخص", "اعملي خصم"): stay warm and firm. Never offer, hint at or promise a discount, gift, free extra or "let me ask" about the price unless the knowledge says so, even if they push or haggle several times. Show the value in one or two short lines from the knowledge (what's included, quality, free delivery). If the price is fixed, say it kindly once (e.g. "السعر ثابت، وشامل التوصيل لباب بيتك") and move on to the next choice.
- "نفكر" / "نشوف" / "بعدين": no pressure. One helpful line (photos, size help) and leave the door open ("على راحتك، اي وقت تبي تحجز احنا هنا 😊").
- Trust worries ("مضمون؟", "نخاف"): reassure only with facts from the knowledge (delivery to the door, payment options).
- Don't repeat what you already said, and don't ask again for anything the customer already gave (a photo they sent can tell you the color).
- Photos: when the customer asks about colors or models, or wants to see a product, send its photos with send_product_photos and add one short line. Write [photos] alone on its own line (between blank lines) where the photos should appear among your messages; without it they go just before your last message. Don't list the colors in text when photos exist. Don't send the same photos twice in one conversation unless the customer clearly asks to see them again (then only the ones they ask for, e.g. one color), and never invent photo ids.

# Taking the order
- Collect, in a natural way: the product and its choices (color/model, size, as the product needs), full name, phone number, and the address: city and area (a street or nearby landmark, like a mosque, school or known shop, helps the courier but isn't required). A place name the customer writes alone, especially after "من أي بلد؟" or "وين؟" (e.g. "الشويرف", "مصراتة", "سوق الجمعة"), is where they live: a Libyan town or area, even one you don't know, never a product or a name. Don't ask the country again then. Ask for them in two short steps, never all in one message (a long list makes customers go quiet): first the name and phone ("باهي استاذ 👌 ابعتلي اسمك ورقمك باش نحجزلك"), then where ("ووين بالزبط؟ المدينة والمنطقة 🙏 ولو تقدر ابعتلنا اللوكيشن يسهّل عالمندوب"). If they give several details at once, take them and ask only what's missing. The city and the area are enough to book: ask for a nearby landmark at most once, and if they don't give it, send the summary without it; never ask again for the street or the landmark. The location ask (optional) goes with the address question, once per chat. Never insist on it or wait for it: if they don't send it, carry on with the written address. A location they send ("[sent a location: <link> ...]" or a Google Maps link) goes, as the link, at the end of the address in submit_order; the address is only what the customer really wrote (never words like "اللوكيشن المرسل" or "(مذكور من الزبون)": if a part like the landmark is missing, leave it out); in the summary the address line still gives the city and area they wrote and just ends with "(📍 اللوكيشن وصلنا)": the location never replaces them, and the city always goes in submit_order's city. Quantity is 1 unless the customer says more: don't ask about it. Like our team, you may ask for a second phone number ("ممكن رقم تاني للتواصل؟"), but don't insist.
- Name: only a name the customer clearly gives as their name. Customers keep chatting while you collect the order: a short phrase is usually a reaction or a wish, not a name (e.g. "بس سعدني" = just make me happy / pick me something nice, "عادي", "تمام", "كيف ما تبي"). If a word could be a name or a phrase, don't greet them with it: answer the phrase naturally (for "بس سعدني": "من عيوني استاذ، الأسود راقي وبيعجبك إن شاء الله") and ask for the name ("وشن الاسم الكامل للتوصيل استاذ؟"). Never tell the customer that what they wrote is not a name. When unsure, ask rather than guess.
- Phone: a Libyan mobile number, usually starting with 09 (e.g. 0912345678). If the customer says to use this WhatsApp number, use it.
- Our contact: we have no other phone number to give. If they ask for our number or how to reach us, this WhatsApp chat is our number ("تقدر تتواصل معانا على هالرقم نفسه استاذ"). Never give any phone number as ours: the number in "This customer" is the customer's own.
- When the customer sends several messages in a row, answer what's new and ask for at most ONE missing detail. Don't ask again a question from our last message that they haven't had the chance to answer yet.
- When you have everything, send ONE message with the order summary in exactly the format of the knowledge documents (each field on its own line, no blank lines inside; leave out a line you don't know or the product doesn't have), ending with its confirmation question on the last line of that same message. The address line has only the parts they gave (never an empty "- -"). Compute the total only from the prices in the knowledge documents.
- Payment: we prefer cash on delivery, so the summary's payment line is cash unless the customer asked for a bank transfer. If they say they can't pay cash or want to pay by transfer, accept it without pushing back and write the transfer in the summary. Payment is not a detail to collect: never ask "كاش ولا تحويل؟" and never wait for it. Every summary has the payment line.
- Bank transfer: give the account details only when the customer chooses the transfer or asks for the account number, in one message, copied exactly from the knowledge (the account number character for character). A question like "فيه تحويل مصرفي؟" is not choosing it: answer with the two options (transfer now, or cash on delivery after trying it on) and let them pick. Never say the money arrived. A customer who says they transferred, or sends a receipt, is handed off for the team to check it.
- Only after the customer clearly confirms in words (e.g. "تمام", "اكيد", "اي", "نعم", "باهي", "ثبت", "توكل على الله"), call submit_order. Never before. An emoji alone (👍, ✅, 👌) on the summary is not a confirmation: ask once, simply, "نثبّت استاذ؟" (don't comment on the emoji).
- A map location (or address detail) the customer sends after the order was taken is a correction to that order, not a new order: don't call submit_order again; reply that you got the new location and updated the address.
- Call submit_order once per order. If the order was already taken in this chat (we said "تم الحجز", or "This customer" lists an order), don't call it again for the same thing: just answer what they ask now. Call it again only for a new or changed order.
- Don't promise a delivery date beyond what the knowledge documents say.

# Where is my order
- "This customer" may have "Order tracking" lines from Darb Assabil (the courier). When the customer asks about their order ("وين طلبي", "متى يوصل", "طلع؟"), answer from them in one or two short lines, in our words: never quote Darb's own messages and never name Darb's staff.
  - waiting for the courier to pick it up: it leaves with Darb Assabil soon.
  - on the way between cities: it's on its way; delivery usually takes what the knowledge says (don't promise a day).
  - at the Darb office in their city: it has arrived in their city and the courier will call them soon; ask them to keep their phone on.
  - delivered: ask kindly if it reached them well.
  - "not sent to Darb Assabil yet": the team is preparing it and it leaves soon.
- Hand off (with the order number and the stage in the reason) instead when: it is delayed, being returned or cancelled; the customer complains (the courier didn't call or didn't come, wrong item or color, damaged); they want to change the address, time or order; or there are no tracking lines for them (ask once for the name or the number the order was made with first, then hand off).

# When not to answer
- When the customer only acknowledges or closes ("تمام", "تمام هكي", "اوكي", "حاضر", "شكرا", "مشكور", 👍) and they ask nothing new and nothing is waiting for their answer, call no_reply_needed. Don't confirm again what you already confirmed (the order, the payment, the delivery): a seller doesn't answer every "تمام" with another "تمام استاذ".
- Never say the same thing twice in a chat in other words. If the customer adds something new (e.g. asks to send the account number with the courier), answer only that, in one short line.

# When to hand off (call handoff_to_human instead of replying)
Only in these cases (the kind in brackets); anything else you answer yourself, and a handoff for anything else is refused:
- the customer asks for a discount, or a wholesale price to resell (discount). A quantity alone is not a reason: take an order for 3 or 5 sets like any other;
- a problem with an order already confirmed or delivered: cancel, change, defect, missing piece, wrong size, late (order_problem; see "Where is my order"). Questions about trying on or returns are answered from the knowledge: there are no returns, the customer tries it on while the courier is there;
- the customer says they transferred the money, or sends a receipt (payment);
- the customer is outside Libya (abroad);
- the customer clearly asks to talk to a person (wants_person);
- questions about the company or its management, rude words, or an angry customer complaining (complaint).
Never hand off for: the price, the address or where we are, the ad's text, a city missing from the delivery table, "we'll talk next week", a color they picked or one we don't have (offer the colors we have), or a doubt between "استاذ" and "استاذة". A video or file you can't open: ask them kindly to write what they want.
- Urgent: anything about an order that is already confirmed or sent (they want to cancel it or change the color, size or address; it arrived with a problem: wrong size, pieces in different sizes, a defect, something missing; the courier is with them now; it's late). The order may already be on its way, so every minute counts. Start the reason with "عاجل", then what the customer wants, the size or color they asked for and what they got, and whether the courier is with them now. The message: "حاضر استاذ، حوّلتك توا للفريق يتابعو معاك 🙏". Don't promise an exchange, a refund or a time. (Plain "where is my order" questions are answered from the tracking lines as above.)
- Silent handoff: when the knowledge says a case goes to the team "بدون أي رد" / without a reply (e.g. questions about the company itself), call handoff_to_human with silent true and an empty message_to_customer: the customer gets nothing from us and the team answers. For every other handoff silent is false.
The message to the customer must sound like the same person continuing the chat, short and warm. When the knowledge gives the message for the case (e.g. a discount: "نشوف الإدارة ونخبرك استاذ 🙏"), use it; otherwise just "حاضر استاذ 🙏". Never write "لحظة نتأكدلك ونرجعلك". Apologize ("سامحنا على هذا 🙏") only when the customer complains that something went wrong, never for a question. Never say "سيتم تحويلك" or mention a team or an agent taking over, except in the urgent message above and where the knowledge gives the message.

# Photos and voice notes
- You can see photos the customer sends. Often it's a screenshot of a product, to show what they want. Customers often send our OLD ads (our logo, a model we don't sell anymore) or photos from other stores, so each product photo was compared with our current product photos, and the result is on its line as "[photo check: ...]". Trust it over your own look at the photo:
  - "our current product": say which product and color it is and continue.
  - "NOT one of our current products": we don't sell that model now. Never give it a price, never say it's available or "from us", and never take an order for it. Say it plainly and kindly ("هاد الموديل مش متوفر عندنا حالياً استاذ"), then offer what we have: our set and its colors (send our current photos if they haven't seen them). If they asked "بكم", give our set's price only as the price of OUR set, after saying theirs isn't available. This is a clear case: answer it yourself, don't hand off.
  - "can't tell": don't guess: say what we have and ask which color they like.
- A line like "[sent a reaction 👍 to: «...»]" is the customer reacting to that message of ours. 👍 ❤️ ✅ 👌 🙏 on a question means yes, except on the order summary: there it is not a confirmation, so ask once, simply, "نثبّت استاذ؟" (no comment on the emoji) and submit only after a clear word; 👎 or 😡 means no or unhappy. Answer it like the words it stands for.
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
        payment: {
          type: "string",
          enum: ["cash", "transfer"],
          description: "How the customer pays, as in the confirmed summary: cash on delivery (the default) or bank transfer.",
        },
        notes: { type: "string", description: "Anything else the team should know (height/weight, delivery wishes). Empty if nothing." },
        weight_kg: { type: "integer", description: "The weight in kg of the person the set is for, as the customer said it. 0 if they never gave it." },
        message_to_customer: {
          type: "string",
          description: "Short warm thank-you saying the booking is registered and we will contact them to confirm delivery, e.g. \"تمام استاذ، تم الحجز 🙏 شويه ونتواصلو معاك لتأكيد التوصيل\".",
        },
      },
      required: ["customer_name", "phone", "city", "address", "items", "total", "payment", "notes", "weight_kg", "message_to_customer"],
      additionalProperties: false,
    },
  },
};

const HANDOFF_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: "function",
  function: {
    name: "handoff_to_human",
    description:
      "Transfer the conversation to our team, only in the cases listed in the instructions. Anything else you answer yourself.",
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
          description: "Short natural message to the customer in their language, like the same person continuing the chat (the knowledge's message for the case, or just \"حاضر استاذ 🙏\"). Never mention a team or a transfer. Empty when silent.",
        },
        kind: {
          type: "string",
          enum: [...AI_HANDOFF_KINDS],
          description:
            "discount: asks for a discount or a wholesale price; order_problem: an order already confirmed or delivered (cancel, change, defect, missing, wrong size, late); payment: says they transferred or sent a receipt; abroad: outside Libya; wants_person: asked for a person; complaint: about the company or its management, rude, or angry and complaining.",
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
      "Send NOTHING to the customer (it is not about the team: for the team use hand_off). Only when the customer just acknowledged or thanked us (\"تمام\", \"شكرا\", 👍), asked nothing new, and gave no answer or detail we asked for. If you wrote a message for the customer, don't call this.",
    strict: true,
    parameters: {
      type: "object",
      properties: { reason: { type: "string", description: "Short note in Arabic: why no answer is needed." } },
      required: ["reason"],
      additionalProperties: false,
    },
  },
};

// location: the last map link the customer sent in this chat, even one older than the messages the AI sees.
// sentPhotos: names of the catalog photos already sent in this chat (the AI sees only its last messages).
// customerName: the name on their WhatsApp profile, so "استاذ" or "استاذة" is right from the first message.
type CustomerContext = { customerPhone?: string; customerName?: string; background?: string; location?: string; sentPhotos?: string[] };

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
    context.customerName &&
      `The name on their WhatsApp profile: «${context.customerName}». Use it to tell whether to say "استاذ" or "استاذة" (a woman's name → "استاذة"); not as their name for the order, and don't greet them with it.`,
    context.customerPhone &&
      `The customer's own WhatsApp number: ${context.customerPhone} (theirs, not ours; use it as the order phone if the customer says to use this number).`,
    libyanPhone(context.customerPhone)
      ? "It is a Libyan number: the customer is in Libya. Never ask which country they are from."
      : !context.customerPhone && "We don't know the customer's number (Messenger or Instagram): ask once whether they are in Libya, as the knowledge says.",
    context.background,
    context.location &&
      `The customer sent their map location in this chat: ${context.location}. It ends the address in submit_order; don't ask for the location again.`,
    `Wording for this customer: way ${wordingWay(context.customerPhone)}. When the knowledge gives numbered ways (1, 2, 3) to say the same thing, use that one; otherwise just say it your own way.`,
  ].filter(Boolean);
  const aboutCustomer = facts.length ? `\n\n# This customer\n${facts.join("\n")}` : "";
  return [
    {
      role: "developer",
      // The stock comes after the knowledge: it changes often, and what's before it stays cached.
      content: `${INSTRUCTIONS}${catalogForPrompt()}\n\n# Knowledge documents\n\n${loadKnowledge()}${stockForPrompt()}${aboutCustomer}`,
    },
    ...history.map((turn): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
      if (turn.role === "business") return { role: "assistant", content: turn.text };
      if (!turn.image) return { role: "user", content: turn.text };
      return {
        role: "user",
        content: [
          { type: "text", text: turn.text },
          // "low" detail is enough to tell colors apart, and costs a fraction of "high" (the model was checked
          // against our photos when the photo arrived: checkPhoto).
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

// What the model produced (reasoning, text, tool calls), to send back as context for the next round, with an
// output for every tool call it made: OpenAI refuses the next round otherwise ("No tool output found").
// outputs answer some calls; the others get otherOutput.
function outputItems(
  response: OpenAI.Responses.Response,
  outputs: OpenAI.Responses.ResponseInputItem.FunctionCallOutput[] = [],
  otherOutput = "Not done. Follow the next instructions.",
): OpenAI.Responses.ResponseInputItem[] {
  const answered = new Set(outputs.map((o) => o.call_id));
  const others = response.output
    .filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call" && !answered.has(o.call_id))
    .map((o) => ({ type: "function_call_output" as const, call_id: o.call_id, output: otherOutput }));
  return [...(response.output as OpenAI.Responses.ResponseInputItem[]), ...outputs, ...others];
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
  // Photos go once per chat: those sent before only again when the customer asks to see them (or names a color).
  const sentBefore = new Set(listCatalog().filter((p) => context.sentPhotos?.includes(p.name)).map((p) => p.id));
  const againOk = asksForPhotos(history);

  // A reply the check rejects gets one rewrite with the reviewer's notes; then the better of the two is sent.
  // The check never hands a chat to the team.
  let rejected: ReplyCheck | undefined;
  let firstDraft: { text: string; check: ReplyCheck } | undefined;
  // A handoff outside the allowed cases is refused once; after that the AI has no handoff tool and must answer.
  let handoffRefused = false;
  let silenceRefused = false;
  // A reply in the wrong dialect or language (or more than 2 messages) gets one rewrite too, then is fixed and sent.
  let restyled = false;
  // An order missing a detail (a full phone, a size) goes back to the model once per round, to ask the customer.
  let orderRefused = 0;
  // The last round only asked for photos: the next one writes the text (no more tools).
  let textNext = false;

  // The model may first ask to send photos and then write its text, so allow a few rounds.
  for (let round = 0; round < 5; round++) {
    const response = await client.responses.create({
      model: config.openai.model,
      // Every reply starts with the same instructions + knowledge: one key keeps them on the same cache.
      prompt_cache_key: "reply",
      reasoning: { effort: config.openai.reasoningEffort },
      input,
      // Silence is a first-round choice only: on a rewrite the model sees its own draft and thinks it already answered.
      tools: [...(handoffRefused ? [] : [HANDOFF_TOOL]), ORDER_TOOL, ...(rejected || restyled || silenceRefused ? [] : [NO_REPLY_TOOL]), ...(knownPhotos.size ? [PHOTOS_TOOL] : [])].map(
        responseTool,
      ),
      // Once photos are queued, the next step is the text that goes with them.
      tool_choice: photos.length && (!rejected || textNext) ? "none" : "auto",
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
      const repeated = againOk ? [] : ids.filter((id) => sentBefore.has(id));
      const valid = ids.filter((id) => knownPhotos.has(id) && !photos.includes(id) && !repeated.includes(id));
      // After a rewrite request the model often asks again for the photos it already queued: that's fine.
      const queued = ids.filter((id) => photos.includes(id));
      photos.push(...valid);
      const already = repeated.length
        ? ` Not sent again, the customer already got them earlier in this chat: ${repeated.join(", ")} (refer to them instead, e.g. "الصور فوق 👆").`
        : "";
      toolResults.push({
        type: "function_call_output",
        call_id: call.id,
        output:
          (valid.length
            ? `These photos will be sent first: ${valid.join(", ")}. Now write your message(s) to the customer: they are always needed (e.g. the price if they asked, and a question like \"شن اللون اللي عجبك؟\"). Put a [photos] line where they should appear (between your two messages, or before your question); without it they are sent just before your last message.`
            : queued.length
              ? `These photos are already queued: ${queued.join(", ")}. Don't ask for them again: now write your message(s) to the customer.`
              : repeated.length
                ? "No photos will be sent. Now write your message to the customer."
                : "No valid photo ids. Use ids from the product photo list.") + already,
      });
    }

    const decision = readDecision(message);
    if (decision.action === "order") {
      const order = withoutPlaceholders(withLocation(decision.order, history, context.location));
      const gone = missingStock(order.items);
      const problems = [
        ...orderProblems(order),
        // A color or size we don't have isn't a case for the team: the AI offers what's left.
        ...(gone.length ? [`Out of stock: ${gone.join(", ")}. Tell the customer kindly and offer the colors or sizes we have.`] : []),
      ];
      // Not saved: the model asks the customer for what's missing (twice at most, then the team sees the gaps).
      if (problems.length && orderRefused < 2 && round < 4) {
        orderRefused++;
        input.push(...outputItems(response, toolResults, `NOT saved: ${problems.join(" ")} Ask the customer for it (or fix the items), then send the summary again.`));
        continue;
      }
      return { ...decision, order, usage };
    }
    if (decision.action === "reply") {
      decision.text = withoutRepeatedCountry(decision.text, history, context.customerPhone);
      if (!decision.text && !photos.length) return { action: "none", reason: "كان بدو يسأل عن البلد مرة تانية بس", usage };
      if (!decision.text) return { ...decision, photos, usage };
      const style = styleProblems(decision.text);
      if (style.length && !restyled && round < 4) {
        restyled = true;
        input.push(...outputItems(response, toolResults), { role: "developer", content: styleFeedback(style) });
        continue;
      }
      decision.text = fixedStyle(decision.text);
      // A wrong bank account number is never sent.
      if (wrongAccount(decision.text)) {
        return {
          action: "handoff",
          reason: `المساعد كتب رقم حساب مصرفي غلط، ما انبعت شي. ابعتو للزبون بيانات الحساب الصح. كان رح يقول: ${decision.text.replace(/\s+/g, " ")}`,
          messageToCustomer: "",
          silent: true,
          usage,
        };
      }
      const check = await checkReply(history, context, decision.text, usage, startedAt);
      if (passes(check)) return { ...decision, photos, confidence: check.confidence, usage };
      if (!rejected && round < 4) {
        rejected = check;
        firstDraft = { text: decision.text, check };
        input.push(...outputItems(response, toolResults), { role: "developer", content: checkFeedback(check) });
        continue;
      }
      // Still not perfect after one rewrite: the better draft goes out rather than silence or a handoff.
      const best = firstDraft && better(firstDraft.check, check) ? firstDraft : { text: decision.text, check };
      return { ...decision, text: best.text, photos, confidence: best.check.confidence, usage };
    }
    if (decision.action === "none") {
      if (silenceRefused || !answersUs(history)) return { ...decision, usage };
      silenceRefused = true;
      const refusal =
        "Not no_reply_needed: we asked the customer something and they answered it (or they sent details, like a number). Answer what they sent and carry on (the next detail the order needs, or the summary).";
      input.push(...outputItems(response, [], refusal));
      continue;
    }
    const emptyReply = decision.reason === EMPTY;
    if (!emptyReply && decision.action === "handoff" && !handoffRefused && round < 4) {
      const verdict = await allowedHandoff(history, decision, usage, startedAt);
      if (!verdict.ok) {
        handoffRefused = true;
        input.push(...outputItems(response, toolResults, handoffRefusal(verdict.why)));
        continue;
      }
    }
    if (!emptyReply) return { ...decision, usage }; // a real handoff wins over photos
    if (!photoCalls.length) {
      // Photos alone are a fine answer ("here are the colors").
      return photos.length ? { action: "reply", text: "", photos, usage } : { ...decision, usage };
    }
    // The model only asked for photos: tell it they're queued, so it writes the text next.
    input.push(...outputItems(response, toolResults));
    textNext = photos.length > 0;
  }
  if (firstDraft) return { action: "reply", text: firstDraft.text, photos, confidence: firstDraft.check.confidence, usage };
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

// --- Is the customer's photo one of our current products? ---
// Customers send screenshots of our old ads (our logo, models we don't sell anymore) and other stores' photos.
// Done once when the photo arrives, with all our product photos side by side; the verdict is written on the
// message ("[photo check: ...]") for the reply and for the team.

const PHOTO_CHECK_INSTRUCTIONS = `You compare a photo a customer sent to a clothing store with the store's current product photos. The current product photos show everything the store sells now.
Decide if the customer's photo shows the SAME MODEL as one of them. Same model = same cut, same embroidery or none, same collar, same pockets and vest. The color, the logo, the person, the pose and the background don't count: one model comes in several colors.
- "ours": the same model as our current photos (give the closest photo id and its color).
- "other_model": a clothing product, but a different model: an old ad of the store (its logo on a different design) or another store's product (another logo or brand). Say in a few words what differs (e.g. "embroidered collar and chest", "another store's logo «...»").
- "not_a_product": not a photo of clothing (a receipt, a text screenshot, a place, a person's face).
- "unclear": too blurry, small or cut to tell the model.`;

const PHOTO_CHECK_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["ours", "other_model", "not_a_product", "unclear"] },
    photo_id: { type: "string", description: "The closest current product photo id when kind is ours, else empty." },
    color: { type: "string", description: "The color as named in that photo, when kind is ours, else empty." },
    reason: { type: "string", description: "A few words: what differs, or why it's unclear." },
  },
  required: ["kind", "photo_id", "color", "reason"],
  additionalProperties: false,
} as const;

export async function checkPhoto(image: string): Promise<{ note?: string; usage: AiUsage }> {
  const usage = emptyUsage();
  const photos = listCatalog()
    .map((item) => ({ item, url: fileAsDataUrl(item.file, item.mime) }))
    .filter((p): p is { item: CatalogItem; url: string } => Boolean(p.url));
  if (!photos.length) return { usage };
  client ??= new OpenAI();
  const startedAt = Date.now();
  const completion = await client.chat.completions.create({
    model: config.openai.supportModel,
    reasoning_effort: "medium",
    messages: [
      { role: "developer", content: PHOTO_CHECK_INSTRUCTIONS },
      {
        role: "user",
        content: [
          { type: "text", text: "Our current product photos:" },
          ...photos.flatMap(({ item, url }) => [
            { type: "text" as const, text: `${item.id}: ${[item.product, item.name].filter(Boolean).join(" · ")}` },
            { type: "image_url" as const, image_url: { url, detail: "low" as const } },
          ]),
          { type: "text", text: "The customer's photo:" },
          { type: "image_url", image_url: { url: image, detail: "high" } },
        ],
      },
    ],
    response_format: { type: "json_schema", json_schema: { name: "photo_check", strict: true, schema: PHOTO_CHECK_SCHEMA } },
  });
  addUsage(usage, completion, startedAt);
  try {
    const a = JSON.parse(completion.choices[0]?.message?.content ?? "{}") as { kind?: string; photo_id?: string; color?: string; reason?: string };
    const item = photos.find((p) => p.item.id === a.photo_id)?.item;
    const color = (a.color || item?.name || "").replace(/^اللون\s*[:：]?\s*/, "").trim();
    if (a.kind === "ours") return { note: `[photo check: our current product${item?.product ? ` «${item.product}»` : ""}${color ? `, color ${color}` : ""}]`, usage };
    if (a.kind === "other_model") return { note: `[photo check: NOT one of our current products (${a.reason?.trim() || "a different model"}); we don't sell this model now]`, usage };
    if (a.kind === "unclear") return { note: "[photo check: can't tell the model]", usage };
    return { usage };
  } catch {
    return { usage };
  }
}

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
        payment: a.payment === "transfer" ? "transfer" : "cash",
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

// A map location the customer sent (a WhatsApp pin or a Google Maps link) ends the address, so it reaches
// the courier even when the AI left it out.
export const MAP_LINK = /https?:\/\/(?:www\.)?(?:maps\.google\.[a-z.]+|google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)\S*/i;
function withLocation(order: CollectedOrder, history: ChatTurn[], earlier?: string): CollectedOrder {
  const link =
    history
      .filter((t) => t.role === "customer")
      .map((t) => t.text.match(MAP_LINK)?.[0].replace(/[)\]]+$/, ""))
      .findLast(Boolean) ?? earlier;
  const address = order.address.replace(/\s*\(?📍[^)]*\)?/u, "").trim();
  if (!link || address.includes(link)) return { ...order, address };
  return { ...order, address: [address.replace(/\s*\(?https?:\/\/\S*\)?/g, "").trim(), link].filter(Boolean).join(" - ") };
}

// Words the model wrote instead of the customer's own ("اللوكيشن المرسل من الزبون - أقرب معلم: (مذكور من الزبون)",
// order #35): they went to the courier as the address. They're cut; what's left is what the customer really gave.
const PLACEHOLDER = [
  /\(?[^()\n-]*(?:مذكور|مرفق|موجود)[^()\n-]*(?:الزبون|المحادثة|الشات|فوق)?[^()\n-]*\)?/g,
  /(?:ال)?لوكيشن\s*(?:ال)?(?:مرسل|مبعوت|اللي\s*بعته|يلي\s*بعته)[^-\n]*/g,
  /(?:العنوان|الموقع)\s*(?:حسب|من|ب)\s*(?:ال)?(?:لوكيشن|خريطة|موقع)[^-\n]*/g,
];
export function withoutPlaceholders(order: CollectedOrder): CollectedOrder {
  let address = order.address;
  for (const p of PLACEHOLDER) address = address.replace(p, "");
  address = address
    .replace(/أقرب\s*معلم\s*:?\s*(?=-|$)/g, "")
    .replace(/(?:\s*-\s*){2,}/g, " - ")
    .replace(/^[\s\-:]+|[\s\-:]+$/g, "");
  return { ...order, address };
}

// A Libyan mobile: 091-095 and 7 more digits (with 0, 218 or +218 in front, or none). 9 digits starting
// 90 (e.g. 901012457) are not one.
export function libyanMobile(phone: string): boolean {
  const d = phone.replace(/[٠-٩]/g, (x) => String(x.charCodeAt(0) - 0x0660)).replace(/D/g, "").replace(/^00/, "");
  return /^(?:218|0)?9[1-5]d{7}$/.test(d);
}

// The size for a weight, from the size table in the knowledge ("| من 81 إلى 90 كغ | 58 |"), so the team's edits
// count. undefined above the table's last row, or when the table isn't found.
export function sizeForWeight(kg: number): string | undefined {
  const rows = [...loadKnowledge().matchAll(/|s*(?:حتى|منs*d+s*(?:إلى|الى|-))s*(d+)s*(?:كغ|كيلو|kg)[^|]*|s*(d{2})s*|/g)]
    .map((m) => ({ upTo: Number(m[1]), size: m[2]! }))
    .sort((a, b) => a.upTo - b.upTo);
  return rows.find((r) => kg <= r.upTo)?.size;
}

// What the courier can't find the customer without: the team hears it before sending to Darb.
export function addressGaps(order: { city: string; address: string; phone?: string; items?: OrderItem[] }): string[] {
  const words = order.address.replace(MAP_LINK, "").replace(/[\s\-–,،:.()]+/g, " ").trim();
  return [
    ...(order.city.trim() ? [] : ["المدينة"]),
    ...(words.length >= 3 ? [] : ["العنوان (المنطقة/الشارع/أقرب معلم)"]),
    ...(order.phone === undefined || intlPhone(order.phone) ? [] : ["رقم هاتف ليبي صحيح"]),
    ...(order.items?.some((i) => !String(i.size ?? "").trim()) ? ["المقاس"] : []),
  ];
}

// An order the model wants to save but can't be: told back to it, so it asks the customer (see decideReply).
function orderProblems(order: CollectedOrder): string[] {
  return [
    ...(libyanMobile(order.phone) ? [] : [`The phone "${order.phone}" is not a full Libyan mobile number (10 digits starting 091-095, or +218).`]),
    ...order.items.flatMap((i, n) => [
      ...(String(i.size ?? "").trim() ? [] : [`Item ${n + 1} (${i.color || i.product}) has no size.`]),
      ...(/[،,]|\sو\s?\S/.test(i.color ?? "") ? [`Item ${n + 1} has more than one color ("${i.color}"): each color is its own item with its own size.`] : []),
    ]),
  ];
}

// Words from other dialects (mostly Syrian, from our own old files) that customers in Libya notice. Whole words
// only, with an attached و/ف ("وبدك").
const NOT_LIBYAN = ["وش", "شنو", "عشان", "علشان", "هلق", "شو", "بدك", "بدو", "كتير", "ليش", "منيح", "هيك", "نحنا", "تبغي", "دلوقتي", "عايز", "تريد", "تريده", "تريدها", "تريدي", "الحين"];
const NOT_LIBYAN_WORD = new RegExp(`(?<![\\p{L}\\p{M}])[وف]?(${NOT_LIBYAN.join("|")})(?![\\p{L}\\p{M}])`, "gu");
// The Syrian "-و" for "his" is fixed in place ("سعرو" → "سعره").
const SYRIAN_HIS: [RegExp, string][] = ["سعر", "قماش", "جودت", "لون", "مقاس", "توصيل", "شكل", "حجم"].map((w) => [
  new RegExp(`(?<![\\p{L}\\p{M}])([وف]?)${w}و(?![\\p{L}\\p{M}])`, "gu"),
  `$1${w}ه`,
]);
const ACCOUNT = /LY\s?\d(?:[\s-]?\d){20,24}/gi;
// Our account number: the one in the knowledge documents.
const ourAccount = () => loadKnowledge().match(/LY\d{23}/)?.[0];
const wrongAccount = (text: string) => {
  const ours = ourAccount();
  return Boolean(ours) && [...text.matchAll(ACCOUNT)].some((m) => m[0].replace(/[\s-]/g, "").toUpperCase() !== ours);
};

export function styleProblems(text: string): string[] {
  const words = [...new Set([...text.matchAll(NOT_LIBYAN_WORD)].map((m) => m[1]))];
  const plain = text.replace(/https?:\/\/\S+/g, "").replace(ACCOUNT, "");
  const latin = (plain.match(/[A-Za-z]/g) ?? []).length;
  const arabic = (plain.match(/[؀-ۿ]/g) ?? []).length;
  const messages = text.split(/\n\s*\n/).filter((p) => p.trim() && !/^\s*\[photos\]\s*$/i.test(p)).length;
  return [
    ...(words.length ? [`It uses words that aren't Libyan: ${words.join("، ")}. Use the Libyan words of the "how we talk" document instead.`] : []),
    ...(latin > arabic ? ["It isn't in Arabic. Always answer in Arabic (Libyan dialect), whatever language the customer wrote in."] : []),
    ...(wrongAccount(text) ? [`The bank account number is wrong: copy it exactly from the knowledge (${ourAccount()}).`] : []),
    ...(messages > 2 ? [`It has ${messages} messages: at most 2 (usually one).`] : []),
  ];
}

const styleFeedback = (problems: string[]) =>
  `Your reply was NOT sent:\n${problems.map((p) => `- ${p}`).join("\n")}\nWrite it again, same content, fixing only that.`;

export const fixedStyle = (text: string) => SYRIAN_HIS.reduce((t, [from, to]) => t.replace(from, to), text);

// The customer's latest messages ask to see photos again, or name a color: then photos sent before can go again.
function asksForPhotos(history: ChatTurn[]): boolean {
  const lastOurs = history.findLastIndex((t) => t.role === "business");
  const theirs = history.slice(lastOurs + 1).filter((t) => t.role === "customer").map((t) => t.text).join(" ");
  return /صور|صوره|صورة|وريني|نشوف|شكله|الألوان|الالوان|أسود|اسود|أبيض|ابيض|بيج|كريمي|فضي|رصاصي|بني/.test(theirs);
}

// The customer's latest messages answer our question or give details (a phone, a size): silence is never right then.
function answersUs(history: ChatTurn[]): boolean {
  const lastOurs = history.findLastIndex((t) => t.role === "business");
  const theirs = history.slice(lastOurs + 1).filter((t) => t.role === "customer");
  if (!theirs.length) return false;
  return /[?؟]/.test(history[lastOurs]?.text ?? "") || theirs.some((t) => /[0-9٠-٩]{2,}/.test(t.text));
}

// "وانت من أي بلد؟" is asked once per chat: the model kept adding it to every message, so once we asked, it's cut.
const COUNTRY_ASK = /[ \t]*[،,]?[ \t]*(?:و[ \t]*)?(?:(?:انت|إنت|انتا|حضرتك)[ \t]*)?(?:من[ \t]*وين[ \t]*[،,]?[ \t]*)?و?من[ \t]*(?:أي|اي)[ \t]*بلد(?:[ \t]*(?:حضرتك|انت|إنت|استاذ|أستاذ))*[ \t]*[؟?]?/g;
// A Libyan number (+218) is never asked at all: we know where they are.
const LIBYA_ASK = /[ \t]*[،,]?[ \t]*و?(?:انت|إنت|انتا|انتي|حضرتك)[ \t]*(?:في|ف|ب)[ \t]*ليبيا(?:[ \t]*(?:استاذ|أستاذ|استاذة))?[ \t]*[؟?]/g;
export const libyanPhone = (phone?: string) => Boolean(phone && /^(?:0|\+218)9\d{8}$/.test(phone));

export function withoutRepeatedCountry(text: string, history: ChatTurn[], phone?: string): string {
  const libyan = libyanPhone(phone);
  if (!libyan && !history.some((t) => t.role === "business" && /(?:أي|اي)\s*بلد|في\s*ليبيا\s*(?:استاذ|أستاذ)?\s*[؟?]/.test(t.text))) return text;
  return text
    .replace(LIBYA_ASK, "")
    // Mid-sentence ("اسمك ومن أي بلد وعنوانك") the words around it keep a space.
    .replace(COUNTRY_ASK, (match, at: number, all: string) => (/^[ \t]*\S/.test(all.slice(at + match.length)) && !/[؟?]$/.test(match) ? " " : ""))
    .replace(/[ \t]{2,}/g, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readDecision(message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined): AgentDecision {
  if (!message) {
    return handoff("AI returned no answer");
  }

  const noReplyCall = message.tool_calls?.find(
    (call) => call.type === "function" && call.function.name === "no_reply_needed",
  );
  // A message written next to no_reply_needed is sent: the model sometimes reads the tool as "nothing for the team".
  if (noReplyCall && noReplyCall.type === "function" && !message.content?.trim() && !message.tool_calls?.some((c) => c.type === "function" && c.function.name !== "no_reply_needed")) {
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
        payment?: string;
        weight_kg?: number;
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
          payment: a.payment === "transfer" ? "transfer" : "cash",
          ...(typeof a.weight_kg === "number" && a.weight_kg > 0 ? { weightKg: a.weight_kg } : {}),
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
// so a separate call scores it. A reply it rejects is rewritten once with its notes; it never stops a reply alone.
const MIN_CONFIDENCE = 80;

const CHECK_INSTRUCTIONS = `You check a reply our sales assistant wants to send a customer on WhatsApp, before it is sent. The knowledge documents below are the only source of truth about the store and its products.
1. not_in_knowledge: every claim in the reply about the product, stock or availability, sizes, fabric, care, delivery, payment, policies, discounts or the company that the knowledge does not back (guessed, assumed, or added), e.g. "not 100% cotton" when the fabric is only described as autumn fabric, or "the navy is available in 58" when the knowledge doesn't confirm stock.
   These are backed, don't list them: a specific case of a general rule in the knowledge (free delivery to all Libyan cities → free delivery to Tripoli); plain rewording of the knowledge; anything said earlier in the chat by us or the customer (their name, color, size, city, what we sent); the order tracking lines in "This customer" (their order's stage at Darb Assabil: picked up soon, on the way, in their city and the courier calls, delivered); a place name the customer wrote (e.g. "الشويرف") is their Libyan town or area, even one you don't know, not a product; [sent product photo: ...] / [product photos] lines, which are our catalog photos; sending our photos, or sending one again when the customer asks to see it again; greetings and questions to the customer. Our own rules are fine too: quantity is 1 unless the customer said otherwise, an order summary that repeats what the customer gave, a total computed from the knowledge prices, the summary's payment line ("الدفع: كاش عند الاستلام" by default, "الدفع: تحويل مصرفي" when the customer asked to pay by transfer, accepting a transfer), asking for missing details, asking for their location on the map, what a photo the customer sent shows: which of our products and colors it is, or that its model isn't available now (the replier compared it with our product photos; you can't see photos, so don't question it), asking which color, size, country or address.
   Always list: any phone number or contact given as ours (we have none to give; the customer's number in their details is theirs).
2. missed_questions: questions or requests in the customer's latest messages (after our last message) that the reply ignores or doesn't answer (the ad button's automatic text, e.g. "هل يمكنني الحصول على مزيد من المعلومات حول هذا؟" or "Can I get more info?", is only a hello: any answer about the product or price covers it), e.g. they asked the price and the reply only asks about the color. Empty if everything was answered, or if the customer asked nothing. Only what the customer asked: a question our rules say we should ask them (country, size, color) is not a missed question.
3. confidence 0-100 that the reply is right to send as it is. Anything in either list means below ${MIN_CONFIDENCE}.
Judge only the facts and the customer's questions, not our sales steps: a reply that doesn't ask the country, size or color yet, or style and wording, is not a problem for you.
The customer's phone number, name and address are only needed when the order is being booked (the summary): never list a reply for not asking them, and never because we don't know the customer's number (customers from ads often write without one). A short reply to thanks or goodbye is fine as it is.`;

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
      { role: "developer", content: `${CHECK_INSTRUCTIONS}\n\n# Knowledge documents\n\n${loadKnowledge()}${stockForPrompt()}` },
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

// Low confidence alone (nothing listed) is a vague "doesn't fit": the reply goes out.
const passes = (c: ReplyCheck) => c.confidence >= MIN_CONFIDENCE || (!c.unsure.length && !c.missed.length);
// Made-up facts weigh more than an unanswered question.
const better = (a: ReplyCheck, b: ReplyCheck) =>
  a.unsure.length !== b.unsure.length ? a.unsure.length < b.unsure.length : a.missed.length !== b.missed.length ? a.missed.length < b.missed.length : a.confidence > b.confidence;

// What the reviewer found, for the one rewrite the assistant gets.
function checkFeedback(check: ReplyCheck): string {
  const lines = [
    ...check.missed.map((q) => `- The customer asked this and your reply doesn't answer it: ${q}`),
    ...check.unsure.map((c) => `- Not backed by the knowledge, remove or fix it: ${c}`),
  ];
  return `A reviewer checked your reply before it was sent and it was NOT sent:\n${lines.join("\n") || "- It doesn't fit the chat."}\nWrite the reply again and send it: answer what the customer asked, and say only what the knowledge documents back. Where the knowledge has no answer, leave that claim out (or say you don't have that detail) and carry on with the sale. These notes are never a reason to hand the chat to the team.`;
}

// The AI hands chats to the team too easily, so a second look checks each handoff against the allowed cases.
const HANDOFF_CHECK = `Our sales assistant on WhatsApp wants to hand this chat to our team. It may only do so in these cases:
1. the customer asks for a discount, or a wholesale price to resell (a quantity alone, e.g. 3 or 5 sets, is NOT a case);
2. a problem with an order already confirmed or delivered: cancel, change, defect, missing piece, wrong size, late;
3. the customer says they transferred the money, or sent a receipt;
4. the customer is outside Libya;
5. the customer clearly asks to talk to a person;
6. questions about the company or its management, rude words, or an angry customer complaining.
Anything else the assistant answers itself, e.g. the price, the address or where we are, the ad's text, a city missing from the delivery table, "we'll talk next week", a color they picked or one we don't have, a doubt between "استاذ" and "استاذة", a question the assistant can't answer.
Judge from the customer's own messages, not from the assistant's reason.`;

const HANDOFF_SCHEMA: OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"] = {
  type: "json_schema",
  json_schema: {
    name: "handoff_check",
    strict: true,
    schema: {
      type: "object",
      properties: {
        case_number: { type: "integer", description: "1-6, or 0 when none of the cases fits." },
        why: { type: "string", description: "One short line, in English." },
      },
      required: ["case_number", "why"],
      additionalProperties: false,
    },
  },
};

async function allowedHandoff(
  history: ChatTurn[],
  decision: Extract<AgentDecision, { action: "handoff" }>,
  usage: AiUsage,
  startedAt: number,
): Promise<{ ok: boolean; why: string }> {
  const chat = history.slice(-12).map((t) => `${t.role === "customer" ? "CUSTOMER" : "US"}: ${t.text}`).join("\n");
  try {
    const completion = await client!.chat.completions.create({
      model: config.openai.supportModel,
      prompt_cache_key: "handoff-check",
      reasoning_effort: "low",
      messages: [
        { role: "developer", content: HANDOFF_CHECK },
        { role: "user", content: `The chat:
${chat}

The assistant's reason (${decision.kind ?? "other"}): ${decision.reason}` },
      ],
      response_format: HANDOFF_SCHEMA,
    });
    addUsage(usage, completion, startedAt);
    const parsed = JSON.parse(completion.choices[0]?.message.content ?? "") as { case_number?: number; why?: string };
    const n = parsed.case_number ?? 0;
    return { ok: n >= 1 && n <= 6, why: parsed.why ?? "" };
  } catch {
    // The check failing never blocks a handoff the assistant asked for.
    return { ok: true, why: "" };
  }
}

function handoffRefusal(why: string): string {
  return `NOT handed off: this is not one of the cases for the team${why ? ` (${why})` : ""}. Answer the customer yourself now, from the knowledge, and carry on with the sale. Where the knowledge has no answer, say what it does say and keep going; don't promise to check and come back.`;
}

// Fallback handoff when the AI itself fails; the caller sends a default customer message.
function handoff(reason: string): AgentDecision {
  return { action: "handoff", reason, messageToCustomer: "" };
}
