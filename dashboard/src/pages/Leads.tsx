import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Download, Megaphone, MessageCircle, Search, Users } from "lucide-react";
import { api, type Lead, type LeadFilter } from "../api";
import { Badge, Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { day } from "../components/OrdersExport";
import { ago, num, phone, time } from "../format";

const FILTERS: { id: LeadFilter; label: string }[] = [
  { id: "all", label: "الكل" },
  { id: "ordered", label: "طلبو" },
  { id: "no_order", label: "ما طلبو" },
  { id: "ad", label: "من الإعلانات" },
];

// On the last time we heard from them.
const PERIODS = [
  { id: "today", label: "اليوم", from: () => day(), to: () => day() },
  { id: "week", label: "آخر 7 أيام", from: () => day(6), to: () => day() },
  { id: "month", label: "آخر 30 يوم", from: () => day(29), to: () => day() },
  { id: "all", label: "كل الفترة", from: () => "", to: () => "" },
] as const;
type PeriodId = (typeof PERIODS)[number]["id"];

const STAGE: Record<Lead["stage"], { label: string; tone: "ok" | "muted" | "warn" }> = {
  ordered: { label: "طلب", tone: "ok" },
  cancelled: { label: "طلب وألغى", tone: "muted" },
  no_order: { label: "ما طلب", tone: "warn" },
};

const PAGE = 200;

// The number to call: the one on their order, else their WhatsApp number.
const leadPhone = (l: Lead) => (l.phone && l.phone !== l.customer ? l.phone : phone(l.customer));

export function Leads() {
  const [filter, setFilter] = useState<LeadFilter>("all");
  const [period, setPeriod] = useState<PeriodId>("all");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  useEffect(() => {
    const id = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(id);
  }, [text]);
  useEffect(() => setShown(PAGE), [filter, period, q]);

  const p = PERIODS.find((x) => x.id === period)!;
  const query = { filter, q, from: p.from(), to: p.to() };
  const leads = useQuery({ queryKey: ["leads", query], queryFn: () => api.leads(query), refetchInterval: 60_000 });
  const list = leads.data?.leads ?? [];

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="الزباين"
        subtitle="كل حدا راسلنا أو طلب منا، مع اسمو (من الطلب أو من الواتساب) ورقمو. الاسم من الواتساب بينحفظ من أول رسالة بيبعتها بعد هالتحديث."
        actions={
          <a
            href={api.leadsExportUrl(query)}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            <Download size={16} /> تنزيل Excel
          </a>
        }
      />

      <Card className="mb-4 flex flex-col gap-3">
        <label className="flex items-center gap-2 rounded-xl border border-line bg-card-2 px-3 py-2 focus-within:border-primary">
          <Search size={16} className="text-muted" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="ابحث بالاسم أو الرقم أو المدينة…"
            className="w-full bg-transparent text-sm outline-none"
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={clsx("rounded-xl px-3 py-1.5 text-sm", filter === f.id ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
            >
              {f.label} <span className="num">{leads.data ? `(${num(leads.data.counts[f.id])})` : ""}</span>
            </button>
          ))}
          <span className="mx-1 hidden h-5 w-px bg-line sm:block" />
          {PERIODS.map((x) => (
            <button
              key={x.id}
              onClick={() => setPeriod(x.id)}
              className={clsx(
                "rounded-xl border px-3 py-1.5 text-sm",
                period === x.id ? "border-primary text-primary" : "border-line text-muted hover:text-fg",
              )}
            >
              {x.label}
            </button>
          ))}
        </div>
      </Card>

      <ErrorNote error={leads.error} />
      {leads.data && !list.length && (
        <Card>
          <Empty icon={Users} text="ما في زباين هون." />
        </Card>
      )}

      {list.length > 0 && (
        <>
          {/* Phones: one card per customer */}
          <div className="flex flex-col gap-2 md:hidden">
            {list.slice(0, shown).map((l) => (
              <Link key={l.customer} href={`/inbox/${encodeURIComponent(l.customer)}`}>
                <Card className="flex flex-col gap-1.5 !p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{l.name || <span className="text-muted">بدون اسم</span>}</span>
                    <Badge tone={STAGE[l.stage].tone}>{STAGE[l.stage].label}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span className="ltr num">{leadPhone(l)}</span>
                    {l.city && <span>{l.city}</span>}
                    {l.orders > 0 && <span className="num">{l.orders} طلب · {num(l.spent)} د</span>}
                    {l.fromAd && <span className="inline-flex items-center gap-1"><Megaphone size={12} /> إعلان</span>}
                    <span>{ago(l.lastAt)}</span>
                  </div>
                  {l.lastText && <p className="truncate text-xs text-muted">{l.lastText}</p>}
                </Card>
              </Link>
            ))}
          </div>

          {/* Wider screens: a table */}
          <Card className="hidden overflow-x-auto !p-0 md:block">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-xs text-muted">
                <tr className="text-start">
                  <th className="px-4 py-3 text-start font-medium">الاسم</th>
                  <th className="px-3 py-3 text-start font-medium">الرقم</th>
                  <th className="px-3 py-3 text-start font-medium">المدينة</th>
                  <th className="px-3 py-3 text-start font-medium">الحالة</th>
                  <th className="px-3 py-3 text-start font-medium">الطلبات</th>
                  <th className="px-3 py-3 text-start font-medium">آخر تواصل</th>
                  <th className="px-3 py-3 text-start font-medium">آخر رسالة</th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {list.slice(0, shown).map((l) => (
                  <tr key={l.customer} className="border-b border-line/60 last:border-0 hover:bg-card-2/60">
                    <td className="px-4 py-2.5">
                      <div className="font-medium">{l.name || <span className="text-muted">بدون اسم</span>}</div>
                      {(l.waName && l.waName !== l.name) || l.username ? (
                        <div className="text-xs text-muted">
                          {[l.waName !== l.name && l.waName, l.username && `@${l.username}`].filter(Boolean).join(" · ")}
                        </div>
                      ) : null}
                    </td>
                    <td className="ltr num whitespace-nowrap px-3 py-2.5 text-start">{leadPhone(l)}</td>
                    <td className="px-3 py-2.5">{l.city || <span className="text-muted">—</span>}</td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <Badge tone={STAGE[l.stage].tone}>{STAGE[l.stage].label}</Badge>
                        {l.fromAd && (
                          <span title="جا من إعلان" className="text-muted">
                            <Megaphone size={14} />
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="num whitespace-nowrap px-3 py-2.5">
                      {l.orders ? `${l.orders} · ${num(l.spent)} د` : <span className="text-muted">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-muted" title={time(l.lastAt)}>
                      {ago(l.lastAt)}
                    </td>
                    <td className="max-w-64 truncate px-3 py-2.5 text-xs text-muted">{l.lastText}</td>
                    <td className="px-3 py-2.5">
                      <Link href={`/inbox/${encodeURIComponent(l.customer)}`} className="text-muted hover:text-primary" aria-label="المحادثة">
                        <MessageCircle size={16} />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {list.length > shown && (
            <button onClick={() => setShown((n) => n + PAGE)} className="mx-auto mt-4 block rounded-xl bg-card-2 px-4 py-2 text-sm text-muted hover:text-fg">
              عرض المزيد ({num(list.length - shown)})
            </button>
          )}
        </>
      )}
    </div>
  );
}
