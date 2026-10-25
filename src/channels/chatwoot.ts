// Instagram + Messenger through Chatwoot (Agent Bot webhook).
import { config } from "../config.js";
import { decideReply } from "../agent.js";
import { addPrivateNote, getHistory, handOffToHuman, sendReply } from "../chatwoot.js";
import { log, scheduleReply } from "../scheduler.js";
import { recordAiCall, saveOrder } from "../store.js";
import { notifyHandoff, notifyOrder, orderNote, orderOneLine } from "../orders.js";
import { notifyError } from "../telegram.js";
import { splitMessages, typingPause } from "../typing.js";
import { aiBlockedReason } from "../settings.js";

// Shape of the Chatwoot Agent Bot "message_created" event (only the fields we use).
export type MessageCreatedEvent = {
  event: string;
  id: number;
  message_type: string; // "incoming" | "outgoing" | "activity" | "template"
  private?: boolean;
  account?: { id: number };
  conversation?: { id: number; status: string };
};

const DEFAULT_HANDOFF_MESSAGE = "حاضر، لحظة نتأكدلك ونرجعلك 🙏";
const DEFAULT_ORDER_MESSAGE = "تمام، تم الحجز 🙏 شويه ونتواصلو معاك لتأكيد التوصيل";

const seenMessageIds = new Map<number, number>(); // message id -> time seen

export function handleChatwootEvent(event: MessageCreatedEvent) {
  if (event.event !== "message_created" || aiBlockedReason()) return;
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
    recordAiCall({
      customer: key,
      channel: "chatwoot",
      action: decision.action,
      reason:
        decision.action === "handoff"
          ? decision.reason
          : decision.action === "order"
            ? orderOneLine(decision.order)
            : undefined,
      usage: decision.usage,
    });

    if (decision.action === "reply") {
      for (const [i, part] of splitMessages(decision.text).entries()) {
        if (i > 0) await typingPause(part);
        await sendReply(accountId, conversationId, part);
      }
      log(key, "replied");
    } else if (decision.action === "order") {
      const id = saveOrder({ customer: key, channel: "chatwoot", ...decision.order });
      await sendReply(accountId, conversationId, decision.messageToCustomer || DEFAULT_ORDER_MESSAGE);
      await addPrivateNote(accountId, conversationId, orderNote(id, decision.order));
      await handOffToHuman(accountId, conversationId);
      log(key, `order #${id} collected, team must confirm: ${orderOneLine(decision.order)}`);
      notifyOrder(id, key, decision.order);
    } else {
      await sendReply(accountId, conversationId, decision.messageToCustomer || DEFAULT_HANDOFF_MESSAGE);
      await addPrivateNote(accountId, conversationId, `🤖 Handed off by AI: ${decision.reason}`);
      await handOffToHuman(accountId, conversationId);
      log(key, `handed off: ${decision.reason}`);
      notifyHandoff(key, decision.reason);
    }
  } catch (error) {
    // If anything fails, never leave the customer unanswered: give the chat to a human.
    const message = error instanceof Error ? error.message : String(error);
    recordAiCall({ customer: key, channel: "chatwoot", action: "error", reason: message });
    log(key, `error: ${message}`);
    notifyError(`المساعد ما قدر يرد على Instagram/Messenger #${conversationId}`, message);
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
