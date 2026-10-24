// Instagram + Messenger through Chatwoot (Agent Bot webhook).
import { config } from "../config.js";
import { decideReply } from "../agent.js";
import { addPrivateNote, getHistory, handOffToHuman, sendReply } from "../chatwoot.js";
import { log, scheduleReply } from "../scheduler.js";

// Shape of the Chatwoot Agent Bot "message_created" event (only the fields we use).
export type MessageCreatedEvent = {
  event: string;
  id: number;
  message_type: string; // "incoming" | "outgoing" | "activity" | "template"
  private?: boolean;
  account?: { id: number };
  conversation?: { id: number; status: string };
};

const DEFAULT_HANDOFF_MESSAGE = "شكراً لتواصلك! واحد من فريقنا رح يرد عليك بأقرب وقت 🙏";

const seenMessageIds = new Map<number, number>(); // message id -> time seen

export function handleChatwootEvent(event: MessageCreatedEvent) {
  if (event.event !== "message_created" || !config.aiReplies) return;
  if (event.message_type !== "incoming" || event.private) return; // ignore our own and team messages
  const accountId = event.account?.id;
  const conversation = event.conversation;
  if (!accountId || !conversation) return;

  // "pending" = the bot owns the conversation. "open" = a human took over, so the bot stays quiet.
  if (conversation.status !== "pending") return;

  if (seenMessageIds.has(event.id)) return; // Chatwoot may deliver the same event twice
  seenMessageIds.set(event.id, Date.now());

  scheduleReply(`cw:${conversation.id}`, config.debounceMs, () => respond(accountId, conversation.id));
}

async function respond(accountId: number, conversationId: number) {
  const key = `cw:${conversationId}`;
  try {
    const history = await getHistory(accountId, conversationId);
    const decision = await decideReply(history);

    if (decision.action === "reply") {
      await sendReply(accountId, conversationId, decision.text);
      log(key, "replied");
    } else {
      await sendReply(accountId, conversationId, decision.messageToCustomer || DEFAULT_HANDOFF_MESSAGE);
      await addPrivateNote(accountId, conversationId, `🤖 Handed off by AI: ${decision.reason}`);
      await handOffToHuman(accountId, conversationId);
      log(key, `handed off: ${decision.reason}`);
    }
  } catch (error) {
    // If anything fails, never leave the customer unanswered: give the chat to a human.
    log(key, `error: ${error instanceof Error ? error.message : String(error)}`);
    try {
      await addPrivateNote(accountId, conversationId, "🤖 AI error, please answer this customer.");
      await handOffToHuman(accountId, conversationId);
    } catch (handoffError) {
      log(key, `handoff after error also failed: ${String(handoffError)}`);
    }
  }
}

// Forget old message ids so memory stays small.
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, seenAt] of seenMessageIds) {
    if (seenAt < cutoff) seenMessageIds.delete(id);
  }
}, 10 * 60 * 1000).unref();
