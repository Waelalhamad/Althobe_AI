// Display helpers (Arabic UI, Western digits so numbers and phone numbers stay easy to read).
const nf = new Intl.NumberFormat("en-US");

export const num = (n: number) => nf.format(Math.round(n));
export const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
export const usd = (n: number) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
export const secs = (ms: number) => (ms ? `${(ms / 1000).toFixed(1)}ث` : "—");

export function phone(n: string) {
  if (n.startsWith("cw:")) return `Chatwoot #${n.slice(3)}`;
  return n.length > 6 ? `+${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 8)} ${n.slice(8)}` : n;
}

export function country(n: string) {
  if (n.startsWith("218")) return "ليبيا";
  if (n.startsWith("90")) return "تركيا";
  if (n.startsWith("963")) return "سوريا";
  if (n.startsWith("962")) return "الأردن";
  if (n.startsWith("20")) return "مصر";
  if (n.startsWith("216")) return "تونس";
  return "";
}

export function ago(ms: number) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "الآن";
  const m = Math.round(s / 60);
  if (m < 60) return `قبل ${m} د`;
  const h = Math.round(m / 60);
  if (h < 24) return `قبل ${h} س`;
  return `قبل ${Math.round(h / 24)} يوم`;
}

export function until(ms: number) {
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  return m < 60 ? `${m} د` : `${Math.round(m / 60)} س`;
}

export const time = (ms: number) =>
  new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Short Arabic label for why the AI is paused in a chat.
export function pauseLabel(reason: string | null) {
  if (!reason) return "";
  if (reason.startsWith("AI order")) return "طلب جديد بدو تأكيد";
  if (reason.startsWith("AI handoff")) return "حوّلها المساعد للفريق";
  if (reason === "AI error") return "خطأ بالمساعد";
  if (reason.includes("dashboard")) return "الفريق من اللوحة";
  if (reason.includes("WhatsApp Business app")) return "الفريق رد من التطبيق";
  return reason;
}
