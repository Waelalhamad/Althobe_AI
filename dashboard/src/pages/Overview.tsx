import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Bot, CircleDollarSign, Gauge, Hand, MessageCircle, ShieldCheck, ShoppingBag, Timer, UserPlus, Users, TriangleAlert } from "lucide-react";
import { api, type FunnelDay, type OverviewQuery, type Totals } from "../api";
import { Badge, Card, Empty, ErrorNote, PageHeader, Stat } from "../components/ui";
import { ago, num, pct, phone, secs, usd } from "../format";

// Libya is UTC+2 all year (the server's "today" too).
const libyaDate = (daysAgo = 0) => new Date(Date.now() + 2 * 3600_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);

const PRESETS = [
  { id: "today", label: "اليوم", from: 0, to: 0 },
  { id: "yesterday", label: "مبارح", from: 1, to: 1 },
  { id: "2d", label: "آخر يومين", from: 1, to: 0 },
  { id: "3d", label: "آخر 3 أيام", from: 2, to: 0 },
  { id: "7d", label: "7 أيام", from: 6, to: 0 },
  { id: "30d", label: "30 يوم", from: 29, to: 0 },
] as const;

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

const C = {
  primary: "hsl(171 36% 52%)",
  info: "hsl(212 75% 66%)",
  warn: "hsl(38 90% 60%)",
  bad: "hsl(0 70% 62%)",
  ok: "hsl(152 55% 52%)",
  grid: "hsl(224 16% 15%)",
  muted: "hsl(220 10% 55%)",
};

const tooltipStyle = {
  contentStyle: { background: "hsl(224 18% 9%)", border: "1px solid hsl(224 16% 15%)", borderRadius: 12, direction: "rtl" as const },
  labelStyle: { color: "hsl(210 20% 94%)" },
};

export function Overview() {
  const [preset, setPreset] = useState<string>("7d");
  const [custom, setCustom] = useState({ from: libyaDate(6), to: libyaDate(0) });
  // Only some hours of each day (e.g. 18:00 → 00:00), or the whole day.
  const [hours, setHours] = useState<{ from: number; to: number } | null>(null);
  const p = PRESETS.find((x) => x.id === preset);
  const query: OverviewQuery = {
    ...(p ? { from: libyaDate(p.from), to: libyaDate(p.to) } : custom),
    ...(hours ? { hourFrom: hours.from, hourTo: hours.to } : {}),
  };
  const q = useQuery({ queryKey: ["overview", query], queryFn: () => api.overview(query), refetchInterval: 30_000 });
  const d = q.data;
  const t: Totals | undefined = d?.period;
  const b: Totals | undefined = d?.previous;
  const multiDay = query.from !== query.to;
  const select = "rounded-lg border border-line bg-card-2 px-2 py-1";

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="نظرة عامة"
        subtitle="أرقام واتساب والمساعد، بتوقيت ليبيا. كل رقم بينقارن مع نفس المدة اللي قبلها (ونفس الساعات)."
        actions={[...PRESETS, { id: "custom", label: "مخصص" }].map((r) => (
          <button
            key={r.id}
            onClick={() => setPreset(r.id)}
            className={`rounded-xl px-3 py-1.5 text-sm ${preset === r.id ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg"}`}
          >
            {r.label}
          </button>
        ))}
      />
      <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
        {preset === "custom" && (
          <label className="flex items-center gap-2">
            <span className="text-muted">من</span>
            <input type="date" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} className={select} />
            <span className="text-muted">لـ</span>
            <input type="date" value={custom.to} min={custom.from} max={libyaDate(0)} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} className={select} />
          </label>
        )}
        <label className="flex items-center gap-2">
          <span className="text-muted">الساعات</span>
          <select value={hours ? "some" : "all"} onChange={(e) => setHours(e.target.value === "all" ? null : { from: 18, to: 0 })} className={select}>
            <option value="all">كل اليوم</option>
            <option value="some">ساعات محددة</option>
          </select>
        </label>
        {hours && (
          <label className="flex items-center gap-2">
            <span className="text-muted">من</span>
            <select value={hours.from} onChange={(e) => setHours({ ...hours, from: Number(e.target.value) })} className={`num ${select}`}>
              {HOURS.map((h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </select>
            <span className="text-muted">لـ</span>
            <select value={hours.to} onChange={(e) => setHours({ ...hours, to: Number(e.target.value) })} className={`num ${select}`}>
              {HOURS.map((h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ErrorNote error={q.error} />

      {t && b && d && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Stat icon={Users} label="محادثات" value={num(t.conversations)} hint={<>{num(t.customerMessages)} رسالة من الزباين <Delta now={t.conversations} before={b.conversations} /></>} />
            <Stat icon={UserPlus} label="زباين جدد" value={num(t.newCustomers)} hint={<>أول مرة بيكتبولنا <Delta now={t.newCustomers} before={b.newCustomers} /></>} tone="info" />
            <Stat
              icon={ShoppingBag}
              label="الطلبات"
              value={<Link href="/orders">{num(t.orders + (t.teamOrders ?? 0))}</Link>}
              hint={<>{num(t.orders)} جمعها المساعد · {num(t.teamOrders ?? 0)} سجّلها الفريق <Delta now={t.orders + (t.teamOrders ?? 0)} before={b.orders + (b.teamOrders ?? 0)} /></>}
              tone="ok"
            />
            <Stat icon={Bot} label="ردود المساعد" value={num(t.aiReplies)} hint={`${num(t.staffMessages)} رد من الفريق`} tone="ok" />
            <Stat
              icon={Hand}
              label="تحويلات للفريق"
              value={num(t.handoffs)}
              hint={<>{t.errors ? `${num(t.errors)} خطأ` : "بدون أخطاء"} <Delta now={t.handoffs} before={b.handoffs} lowerIsBetter /></>}
              tone={t.errors ? "bad" : "warn"}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              icon={ShieldCheck}
              label="حلّها المساعد لحالو"
              value={pct(t.aiOnlyConversations, t.aiConversations)}
              hint={<>{num(t.aiOnlyConversations)} من {num(t.aiConversations)} محادثة رد فيها المساعد، بلا تحويل <Delta now={rate(t.aiOnlyConversations, t.aiConversations)} before={rate(b.aiOnlyConversations, b.aiConversations)} points /></>}
            />
            <Stat
              icon={Gauge}
              label="نسبة التحويل"
              value={pct(t.handoffs + t.errors, t.aiReplies + t.handoffs + t.orders + t.errors)}
              hint={<>من كل قرارات المساعد <Delta now={rate(t.handoffs + t.errors, t.aiReplies + t.handoffs + t.orders + t.errors)} before={rate(b.handoffs + b.errors, b.aiReplies + b.handoffs + b.orders + b.errors)} points lowerIsBetter /></>}
              tone="warn"
            />
            <Stat
              icon={Timer}
              label="سرعة تفكير المساعد"
              value={secs(t.latency.p50Ms)}
              hint={`المتوسط ${secs(t.latency.avgMs)} · 90% أسرع من ${secs(t.latency.p90Ms)} (عدا انتظار 4ث لآخر رسالة)`}
              tone="info"
            />
            <Stat
              icon={CircleDollarSign}
              label="تكلفة OpenAI"
              value={usd(t.costUsd)}
              hint={
                t.aiReplies + t.handoffs + t.orders
                  ? `${usd(t.costUsd / (t.aiReplies + t.handoffs + t.orders))} للرد · ${num(t.tokens.prompt + t.tokens.completion)} توكن`
                  : "تقدير حسب أسعار gpt-5-mini"
              }
              tone="ok"
            />
          </div>

          {multiDay && (
            <Card>
              <h2 className="mb-4 font-semibold">الحركة اليومية</h2>
              <div className="h-72" dir="ltr">
                <ResponsiveContainer>
                  <AreaChart data={d.daily}>
                    <defs>
                      <linearGradient id="gPrimary" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={C.primary} stopOpacity={0.35} />
                        <stop offset="100%" stopColor={C.primary} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="day" tick={{ fill: C.muted, fontSize: 12 }} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis tick={{ fill: C.muted, fontSize: 12 }} allowDecimals={false} width={40} />
                    <Tooltip {...tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Area type="monotone" dataKey="conversations" name="محادثات" stroke={C.primary} fill="url(#gPrimary)" strokeWidth={2} />
                    <Area type="monotone" dataKey="aiReplies" name="ردود المساعد" stroke={C.info} fill="transparent" strokeWidth={2} />
                    <Area type="monotone" dataKey="staffMessages" name="ردود الفريق" stroke={C.muted} fill="transparent" strokeWidth={2} strokeDasharray="4 4" />
                    <Area type="monotone" dataKey="handoffs" name="تحويلات" stroke={C.warn} fill="transparent" strokeWidth={2} />
                    <Area type="monotone" dataKey="orders" name="طلبات" stroke={C.ok} fill="transparent" strokeWidth={2} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          <Funnel data={d.funnel} total={d.funnelTotal} before={d.previousFunnelTotal} multiDay={multiDay} />

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <h2 className="mb-1 font-semibold">أوقات رسائل الزباين</h2>
              <p className="mb-4 text-xs text-muted">كل ساعة من اليوم، بتوقيت ليبيا، لكل أيام الفترة (مش بس الساعات المحددة). بيساعد بتوقيت الإعلانات ودوام الفريق.</p>
              <div className="h-60" dir="ltr">
                <ResponsiveContainer>
                  <BarChart data={d.hourly}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis dataKey="hour" tick={{ fill: C.muted, fontSize: 11 }} />
                    <YAxis tick={{ fill: C.muted, fontSize: 11 }} allowDecimals={false} width={36} />
                    <Tooltip {...tooltipStyle} cursor={{ fill: "hsl(224 16% 12%)" }} labelFormatter={(h) => `الساعة ${h}:00`} />
                    <Bar dataKey="customerMessages" name="رسائل" fill={C.primary} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>

            <Card className="xl:col-span-2">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-semibold">آخر التحويلات</h2>
                <Link href="/handoffs" className="text-xs text-primary">
                  الكل
                </Link>
              </div>
              {d.recentHandoffs.length === 0 ? (
                <Empty icon={MessageCircle} text="ما في تحويلات بهالفترة." />
              ) : (
                <ul className="flex flex-col divide-y divide-line">
                  {d.recentHandoffs.slice(0, 8).map((h, i) => (
                    <li key={i}>
                      <Link
                        href={h.channel !== "chatwoot" ? `/inbox/${h.customer}` : "/handoffs"}
                        className="flex flex-col gap-1 py-2.5 hover:text-primary"
                      >
                        <div className="flex items-center justify-between gap-2 text-sm">
                          <span className="ltr num">{phone(h.customer)}</span>
                          <span className="text-xs text-muted">{ago(h.at)}</span>
                        </div>
                        <div className="flex items-start gap-2 text-xs text-muted">
                          {h.action === "error" && (
                            <Badge tone="bad">
                              <TriangleAlert size={12} /> خطأ
                            </Badge>
                          )}
                          <span className="ltr line-clamp-2 text-start">{h.reason}</span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <h2 className="mb-3 font-semibold">استهلاك OpenAI بالفترة</h2>
            <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <Usage label="توكن داخلة (سؤال + معلومات)" value={num(t.tokens.prompt)} />
              <Usage label="منها من الكاش (أرخص 10×)" value={`${num(t.tokens.cached)} · ${pct(t.tokens.cached, t.tokens.prompt)}`} />
              <Usage label="توكن طالعة (الرد)" value={num(t.tokens.completion)} />
              <Usage label="منها تفكير" value={num(t.tokens.reasoning)} />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

const STOPS = [
  { key: "beforePrice", label: "وقف قبل السعر", color: C.muted },
  { key: "afterPrice", label: "وقف بعد السعر", color: C.warn },
  { key: "booking", label: "وقف بنص الحجز", color: C.info },
  { key: "ordered", label: "طلب", color: C.ok },
] as const;

const rate = (part: number, whole: number) => (whole > 0 ? (100 * part) / whole : 0);

// The change against the period before: a percent for counts, percentage points for rates (points).
function Delta({ now, before, points, lowerIsBetter }: { now: number; before: number; points?: boolean; lowerIsBetter?: boolean }): ReactNode {
  const diff = points ? now - before : before > 0 ? (100 * (now - before)) / before : undefined;
  if (diff === undefined || Math.abs(diff) < 0.5) return <span className="text-muted">· زي قبل</span>;
  const good = lowerIsBetter ? diff < 0 : diff > 0;
  return (
    <span className={good ? "text-ok" : "text-bad"}>
      · {diff > 0 ? "▲" : "▼"} <span className="num">{Math.abs(Math.round(diff))}{points ? " نقطة" : "%"}</span>
    </span>
  );
}

// New chats by the day they started: how many ordered, and where the others stopped.
function Funnel({ data, total, before, multiDay }: { data: FunnelDay[]; total: FunnelDay; before: FunnelDay; multiDay: boolean }) {
  const daily = data.map((d) => ({ ...d, rate: d.chats ? Math.round((1000 * d.ordered) / d.chats) / 10 : 0 }));
  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">نسبة الشراء ووين بيوقفو الزباين</h2>
        <span className="text-sm text-muted">
          <span className="num font-semibold text-fg">{pct(total.ordered, total.chats)}</span> من {num(total.chats)} محادثة جديدة طلبت{" "}
          <Delta now={rate(total.ordered, total.chats)} before={rate(before.ordered, before.chats)} points />
          <span className="ms-1">(قبل: <span className="num">{pct(before.ordered, before.chats)}</span>)</span>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {STOPS.map((s) => (
          <div key={s.key} className="rounded-xl bg-card-2 p-3">
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="size-2 rounded-full" style={{ background: s.color }} />
              {s.label}
            </div>
            <div className="num mt-1 font-semibold">
              {num(total[s.key])} <span className="text-xs font-normal text-muted">· {pct(total[s.key], total.chats)}</span>
            </div>
            <div className="mt-1 text-xs">
              <Delta now={rate(total[s.key], total.chats)} before={rate(before[s.key], before.chats)} points lowerIsBetter={s.key !== "ordered"} />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">
        كل محادثة محسوبة بيوم ما بلّشت. «بنص الحجز»: طلبنا الاسم أو الرقم أو العنوان، أو بعتنا الملخص، وما صار طلب.
      </p>
      {multiDay && (
        <div className="mt-4 h-72" dir="ltr">
          <ResponsiveContainer>
            <ComposedChart data={daily}>
              <CartesianGrid stroke={C.grid} vertical={false} />
              <XAxis dataKey="day" tick={{ fill: C.muted, fontSize: 12 }} tickFormatter={(v: string) => v.slice(5)} />
              <YAxis yAxisId="n" tick={{ fill: C.muted, fontSize: 12 }} allowDecimals={false} width={40} />
              <YAxis yAxisId="r" orientation="right" tick={{ fill: C.muted, fontSize: 12 }} unit="%" width={40} />
              <Tooltip {...tooltipStyle} cursor={{ fill: "hsl(224 16% 12%)" }} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {STOPS.map((s) => (
                <Bar key={s.key} yAxisId="n" dataKey={s.key} name={s.label} stackId="f" fill={s.color} />
              ))}
              <Line yAxisId="r" type="monotone" dataKey="rate" name="نسبة الشراء %" stroke={C.primary} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function Usage({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-card-2 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-1 font-semibold">{value}</div>
    </div>
  );
}
