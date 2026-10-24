import OpenAI from "openai";
import { config } from "./config.js";
import { loadKnowledge } from "./knowledge.js";

// Created on first use, so the server can start (e.g. in listen-only mode) before OPENAI_API_KEY is set.
let client: OpenAI | undefined;

export type ChatTurn = { role: "customer" | "business"; text: string };

export type AgentDecision =
  | { action: "reply"; text: string }
  | { action: "handoff"; reason: string; messageToCustomer: string };

const INSTRUCTIONS = `You are the customer support assistant of "الثوب العربي" (Al Thobe Alarabi), a clothing brand. You chat with customers on WhatsApp, Instagram and Facebook Messenger. Most of them are in Libya and arrive from our ads.

Your job: answer questions about our products, sizes, prices, availability, orders, shipping, payment and returns, and help the customer reach a purchase.

Rules:
- Use ONLY the information in the knowledge documents below. Never invent prices, stock, discounts, delivery times or policies.
- Reply in the customer's language and dialect. Most customers write in Libyan Arabic: answer in simple, warm Arabic close to their dialect. If they write in English or Turkish, answer in that language.
- Keep replies short and friendly, like a real shop assistant in a chat app: 1-4 short sentences, no headings, no markdown tables. Emojis are fine in moderation.
- Only talk about our brand and our products. If the customer asks about unrelated topics (general knowledge, homework, other companies, etc.), politely say you can only help with our store.
- Never ask for card numbers, passwords or other sensitive data.

Call the handoff_to_human tool instead of replying when:
- the answer is not in the knowledge documents, or you are not sure;
- the customer wants to place, change or cancel an order, or asks about a specific existing order;
- the customer reports a problem (wrong/damaged item, refund, complaint) or is angry;
- the customer asks to talk to a person;
- the customer sent a photo, voice note or file you cannot see.
When you hand off, write a short message to the customer in their language saying a team member will reply soon.`;

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

export async function decideReply(history: ChatTurn[]): Promise<AgentDecision> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "developer", content: `${INSTRUCTIONS}\n\n# Knowledge documents\n\n${loadKnowledge()}` },
    ...history.map((turn): OpenAI.Chat.Completions.ChatCompletionMessageParam =>
      turn.role === "customer"
        ? { role: "user", content: turn.text }
        : { role: "assistant", content: turn.text },
    ),
  ];

  client ??= new OpenAI();
  const completion = await client.chat.completions.create({
    model: config.openai.model,
    reasoning_effort: config.openai.reasoningEffort,
    messages,
    tools: [HANDOFF_TOOL],
    tool_choice: "auto",
  });

  const message = completion.choices[0]?.message;
  if (!message) {
    return handoff("AI returned no answer");
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
    return handoff(message.refusal ? `AI refused: ${message.refusal}` : "AI returned an empty reply");
  }
  return { action: "reply", text };
}

// Fallback handoff when the AI itself fails; the caller sends a default customer message.
function handoff(reason: string): AgentDecision {
  return { action: "handoff", reason, messageToCustomer: "" };
}
