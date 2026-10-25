// Replies that read like a person on WhatsApp: a few short messages with a pause between them.

// The AI separates messages with a blank line (see the instructions in agent.ts). At most 3 messages.
export function splitMessages(text: string): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length <= 3 ? parts : [...parts.slice(0, 2), parts.slice(2).join("\n\n")];
}

// About as long as someone takes to type the next message: 1.2 to 5 seconds.
export function typingPause(text: string): Promise<void> {
  const ms = Math.min(5000, 1200 + text.length * 40);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
