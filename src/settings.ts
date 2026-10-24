// Settings the team can change from the dashboard without a redeploy.
// A value saved in the dashboard wins over the environment variable.
import { config } from "./config.js";
import { getSetting, setSetting } from "./store.js";

// AI_REPLIES: "on" = the AI answers customers, "off" = listen-only.
export function aiRepliesEnabled(): boolean {
  const saved = getSetting("ai_replies");
  return saved === undefined ? config.aiReplies : saved === "on";
}

export function setAiReplies(on: boolean) {
  setSetting("ai_replies", on ? "on" : "off");
}

// Test mode: when the list is not empty, the AI only answers these WhatsApp numbers
// (and stays silent on Instagram/Messenger), so it can be tried on real chats safely.
export function testNumbers(): string[] {
  const saved = getSetting("test_numbers");
  if (!saved) return [];
  try {
    const list = JSON.parse(saved) as unknown;
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
  } catch {
    return [];
  }
}

export function setTestNumbers(numbers: string[]) {
  setSetting("test_numbers", JSON.stringify(numbers));
}

// Should the AI answer this conversation right now? Explains why not, for the log.
export function aiBlockedReason(whatsappNumber?: string): string | undefined {
  if (!aiRepliesEnabled()) return "listen-only mode (AI replies are off)";
  const test = testNumbers();
  if (test.length > 0 && !(whatsappNumber && test.includes(whatsappNumber))) {
    return "test mode (AI only answers the test numbers)";
  }
  return undefined;
}
