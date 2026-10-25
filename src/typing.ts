// Replies that read like a person on WhatsApp: a few short messages with a pause between them.

// The AI separates messages with a blank line (see the instructions in agent.ts). At most 3 messages.
export function splitMessages(text: string): string[] {
  const parts = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length <= 3 ? parts : [...parts.slice(0, 2), parts.slice(2).join("\n\n")];
}

// Where the product photos go: at the AI's "[photos]" line if it wrote one, otherwise just before the last
// message ("حياك الله😊" / [photos] / "أي لون عجبك؟"). Without photos the line is just dropped.
const PHOTOS_LINE = /^[ \t]*\[photos\][ \t]*$/im;

export function splitAroundPhotos(text: string, hasPhotos: boolean): { before: string[]; after: string[] } {
  const marker = text.match(PHOTOS_LINE);
  if (marker?.index !== undefined) {
    const before = splitMessages(text.slice(0, marker.index));
    const after = splitMessages(text.slice(marker.index + marker[0].length));
    return hasPhotos ? { before, after } : { before: splitMessages([...before, ...after].join("\n\n")), after: [] };
  }
  const parts = splitMessages(text);
  return hasPhotos ? { before: parts.slice(0, -1), after: parts.slice(-1) } : { before: parts, after: [] };
}

// About as long as someone takes to type the next message: 1.2 to 5 seconds.
export function typingPause(text: string): Promise<void> {
  const ms = Math.min(5000, 1200 + text.length * 40);
  return new Promise((resolve) => setTimeout(resolve, ms));
}
