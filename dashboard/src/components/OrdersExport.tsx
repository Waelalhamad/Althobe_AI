import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, Download, FileSpreadsheet, Send, X } from "lucide-react";
import { api, type OrderStatus } from "../api";
import { Button, ErrorNote } from "./ui";

// Local day as YYYY-MM-DD, `daysAgo` days back.
export const day = (daysAgo = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const monthStart = () => `${day().slice(0, 8)}01`;

const RANGES = [
  { id: "today", label: "اليوم", from: () => day(), to: () => day() },
  { id: "yesterday", label: "مبارح", from: () => day(1), to: () => day(1) },
  { id: "week", label: "آخر 7 أيام", from: () => day(6), to: () => day() },
  { id: "month", label: "هالشهر", from: monthStart, to: () => day() },
  { id: "all", label: "الكل", from: () => "", to: () => "" },
  { id: "custom", label: "تاريخ معيّن", from: () => day(6), to: () => day() },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const inputClass = "w-full rounded-xl border border-line bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary";

// The "Excel" button on the orders page: pick a period (and keep the page's status filter or not), then download,
// or send the last 24 hours to the Telegram group now.
export function OrdersExport({ status, statusLabel }: { status?: OrderStatus; statusLabel?: string }) {
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<RangeId>("today");
  const [from, setFrom] = useState(day(6));
  const [to, setTo] = useState(day());
  const [onlyStatus, setOnlyStatus] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !panel.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const telegram = useMutation({ mutationFn: api.sendOrdersSheet });

  const picked = RANGES.find((r) => r.id === range)!;
  const query = {
    from: range === "custom" ? from : picked.from(),
    to: range === "custom" ? to : picked.to(),
    status: onlyStatus ? status : undefined,
  };
  const badRange = range === "custom" && (!from || !to || from > to);

  return (
    <div className="relative" ref={panel}>
      <Button variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <FileSpreadsheet size={16} className="text-ok" /> Excel
      </Button>
      {open && (
        <div className="absolute end-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-line bg-card p-4 shadow-2xl shadow-black/40">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-xl bg-ok/12 text-ok">
                <FileSpreadsheet size={17} />
              </span>
              <div>
                <h3 className="text-sm font-bold">تنزيل الطلبات Excel</h3>
                <p className="text-xs text-muted">شيت الطلبات وشيت ملخص (المدن، الألوان، المقاسات)</p>
              </div>
            </div>
            <button onClick={() => setOpen(false)} aria-label="سكّر" className="text-muted hover:text-fg">
              <X size={18} />
            </button>
          </div>

          <span className="text-xs text-muted">الفترة</span>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            {RANGES.map((r) => (
              <button
                key={r.id}
                onClick={() => setRange(r.id)}
                className={clsx(
                  "rounded-lg border px-2 py-1.5 text-xs transition",
                  range === r.id ? "border-primary bg-primary-soft font-semibold text-primary" : "border-line bg-card-2 text-muted hover:text-fg",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
          {range === "custom" && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">من</span>
                <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">لـ</span>
                <input type="date" value={to} min={from} max={day()} onChange={(e) => setTo(e.target.value)} className={inputClass} />
              </label>
            </div>
          )}

          {status && (
            <button
              onClick={() => setOnlyStatus((v) => !v)}
              className="mt-3 flex w-full items-center gap-2 rounded-xl border border-line bg-card-2 px-3 py-2 text-start text-xs"
            >
              <span
                className={clsx(
                  "flex size-4 shrink-0 items-center justify-center rounded border",
                  onlyStatus ? "border-primary bg-primary text-white" : "border-muted",
                )}
              >
                {onlyStatus && <Check size={12} />}
              </span>
              بس الطلبات «{statusLabel}»
              <span className="ms-auto text-muted">{onlyStatus ? "" : "كل الحالات"}</span>
            </button>
          )}

          <a
            href={badRange ? undefined : api.ordersExportUrl(query)}
            aria-disabled={badRange}
            onClick={() => !badRange && setTimeout(() => setOpen(false), 300)}
            className={clsx(
              "mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110",
              badRange && "pointer-events-none opacity-50",
            )}
          >
            <Download size={16} /> تنزيل الملف
          </a>

          <div className="mt-3 border-t border-line pt-3">
            <button
              onClick={() => telegram.mutate()}
              disabled={telegram.isPending}
              className="flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs text-muted transition hover:bg-card-2 hover:text-fg disabled:opacity-50"
            >
              <Send size={14} /> {telegram.isPending ? "عم يبعت…" : "ابعت شيت آخر 24 ساعة عالتلغرام هلق"}
            </button>
            {telegram.data && (
              <p className="mt-1 text-center text-xs text-ok">
                {telegram.data.orders ? `انبعت ✓ (${telegram.data.orders} طلب)` : "انبعت ✓ (ما في طلبات بآخر 24 ساعة)"}
              </p>
            )}
            <ErrorNote error={telegram.error} />
            <p className="mt-2 text-center text-[11px] leading-relaxed text-muted">
              الشيت بيوصل للتلغرام لحالو كل يوم بساعة التقرير اليومي. بتقدر توقفو من الإعدادات ← التنبيهات.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
