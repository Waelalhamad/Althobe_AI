import { useEffect, useRef, useState } from "react";
import { Smile } from "lucide-react";
import { Button } from "./ui";

// The emojis our team uses with customers first, then the usual groups. Recently used ones come on top.
const GROUPS: { name: string; emojis: string[] }[] = [
  { name: "الأكثر استعمال", emojis: ["🙏", "😊", "👌", "👍", "❤️", "🌹", "✅", "🔥", "😍", "🤝", "💯", "✨", "🎁", "📦", "🚚", "📍", "💰", "⏳"] },
  {
    name: "وجوه",
    emojis: ["😀", "😃", "😄", "😁", "😆", "😅", "😂", "🤣", "🙂", "😉", "😇", "🥰", "😘", "😋", "😎", "🤩", "🥳", "🤗", "🤔", "🤭", "😐", "😶", "🙄", "😏", "😌", "😴", "😢", "😭", "😤", "😡", "😱", "😳", "🥺", "😬", "🤐", "😷"],
  },
  {
    name: "إيدين",
    emojis: ["👋", "🤚", "✋", "🖐️", "👌", "🤌", "✌️", "🤞", "👍", "👎", "👏", "🙌", "👐", "🤲", "🙏", "💪", "☝️", "👇", "👈", "👉", "👆", "🫡", "🫶", "✍️"],
  },
  {
    name: "قلوب ورموز",
    emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🖤", "🤍", "🤎", "💖", "💕", "💔", "⭐", "🌟", "✨", "⚡", "🔥", "💯", "✅", "☑️", "❌", "⚠️", "❗", "❓", "🔔", "📢", "🎉", "🎊"],
  },
  {
    name: "تسوق وتوصيل",
    emojis: ["🛍️", "🛒", "📦", "🎁", "🏷️", "💰", "💵", "💳", "🧾", "🚚", "🛵", "🚗", "📍", "🗺️", "🏠", "🏪", "📞", "📱", "💬", "📷", "⏰", "⏳", "📅", "👔", "👕", "👖", "🧥", "👞"],
  },
  { name: "مناسبات", emojis: ["🌙", "☪️", "🕌", "🤲", "🕋", "📿", "🌹", "🌸", "💐", "🇱🇾", "🇸🇾", "☀️", "🌤️", "🌧️", "❄️", "☕", "🍵", "🍰"] },
];

const RECENT_KEY = "emoji-recent";
const recent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
};

export function EmojiPicker({ onPick, disabled }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(recent);
  const box = useRef<HTMLDivElement>(null);

  // Closes on a click outside or Escape.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (emoji: string) => {
    onPick(emoji);
    const next = [emoji, ...used.filter((e) => e !== emoji)].slice(0, 16);
    setUsed(next);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  };

  const groups = used.length ? [{ name: "استعملتها مؤخراً", emojis: used }, ...GROUPS] : GROUPS;

  return (
    <div ref={box} className="relative">
      <Button type="button" variant="ghost" onClick={() => setOpen((o) => !o)} disabled={disabled} aria-label="إيموجي" title="إيموجي">
        <Smile size={16} />
      </Button>
      {open && (
        <div className="absolute bottom-full start-0 z-20 mb-2 max-h-80 w-80 overflow-y-auto rounded-xl border border-line bg-card p-2 shadow-lg">
          {groups.map((g) => (
            <div key={g.name} className="mb-2">
              <div className="px-1 pb-1 text-xs text-muted">{g.name}</div>
              <div className="grid grid-cols-8 gap-0.5">
                {g.emojis.map((e, i) => (
                  <button
                    key={`${e}-${i}`}
                    type="button"
                    onClick={() => pick(e)}
                    className="grid size-9 place-items-center rounded-lg text-xl hover:bg-card-2"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
