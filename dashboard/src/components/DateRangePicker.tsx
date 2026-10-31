import { useEffect, useRef, useState } from "react";
import { DayPicker, type DateRange } from "react-day-picker";
import { ar } from "react-day-picker/locale";
import "react-day-picker/style.css";
import { CalendarDays } from "lucide-react";
import { localDate } from "../format";

// Dates are "YYYY-MM-DD" days (Damascus time, like the rest of the dashboard); the calendar works in plain local dates.
const toDate = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};
const toDay = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const label = (day: string) => toDate(day).toLocaleDateString("ar", { day: "numeric", month: "short" });

// Quick ranges, days back from today (both ends included).
const QUICK = [
  { label: "اليوم", from: 0, to: 0 },
  { label: "مبارح", from: 1, to: 1 },
  { label: "آخر 3 أيام", from: 2, to: 0 },
  { label: "آخر 7 أيام", from: 6, to: 0 },
  { label: "آخر 14 يوم", from: 13, to: 0 },
  { label: "آخر 30 يوم", from: 29, to: 0 },
  { label: "آخر 90 يوم", from: 89, to: 0 },
];

// A button with the chosen range; it opens a two-month calendar with quick ranges beside it.
export function DateRangePicker({
  from,
  to,
  onChange,
  openOnMount = false,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  openOnMount?: boolean;
}) {
  const [open, setOpen] = useState(openOnMount);
  const [range, setRange] = useState<DateRange | undefined>({ from: toDate(from), to: toDate(to) });
  const box = useRef<HTMLDivElement>(null);
  const today = toDate(localDate(0));

  useEffect(() => {
    if (open) setRange({ from: toDate(from), to: toDate(to) });
  }, [open, from, to]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const apply = (a: string, b: string) => {
    onChange(a, b);
    setOpen(false);
  };
  const chosen = range?.from ? `${label(toDay(range.from))}${range.to ? ` ← ${label(toDay(range.to))}` : ""}` : "اختار أول يوم";

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-xl border border-line bg-card-2 px-3 py-1.5 text-sm hover:border-primary"
      >
        <CalendarDays className="size-4 text-primary" />
        <span>{from === to ? label(from) : `${label(from)} ← ${label(to)}`}</span>
      </button>
      {open && (
        <div className="absolute start-0 top-full z-40 mt-2 flex flex-col gap-3 rounded-2xl border border-line bg-card p-3 shadow-2xl sm:flex-row">
          <div className="flex flex-row flex-wrap gap-1 sm:w-32 sm:flex-col">
            {QUICK.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => apply(localDate(q.from), localDate(q.to))}
                className="rounded-lg px-2 py-1.5 text-start text-sm text-muted hover:bg-card-2 hover:text-fg"
              >
                {q.label}
              </button>
            ))}
          </div>
          <div className="flex flex-col gap-2 border-line sm:border-s sm:ps-3">
            <DayPicker
              className="rdp-althobe"
              mode="range"
              dir="rtl"
              locale={ar}
              weekStartsOn={6}
              numberOfMonths={typeof window !== "undefined" && window.innerWidth < 640 ? 1 : 2}
              defaultMonth={new Date(today.getFullYear(), today.getMonth() - 1, 1)}
              endMonth={today}
              disabled={{ after: today }}
              selected={range}
              onSelect={setRange}
              showOutsideDays
            />
            <div className="flex items-center justify-between gap-2 border-t border-line pt-2 text-sm">
              <span className="text-muted">{chosen}</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setOpen(false)} className="rounded-lg px-3 py-1 text-muted hover:text-fg">
                  إلغاء
                </button>
                <button
                  type="button"
                  disabled={!range?.from}
                  onClick={() => range?.from && apply(toDay(range.from), toDay(range.to ?? range.from))}
                  className="rounded-lg bg-primary px-3 py-1 font-medium text-bg disabled:opacity-40"
                >
                  تطبيق
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
