import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Bot, CircleDollarSign, Gauge, Hand, MessageCircle, ShieldCheck, ShoppingBag, Timer, UserPlus, Users, TriangleAlert } from "lucide-react";
import { api, type Totals } from "../api";
import { Badge, Card, Empty, ErrorNote, PageHeader, Stat } from "../components/ui";
import { ago, num, pct, phone, secs, usd } from "../format";

const RANGES = [
  { days: 1, label: "اليوم" },
  { days: 7, label: "7 أيام" },
  { days: 30, label: "30 يوم" },
];

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
  const [days, setDays] = useState(7);
  const q = useQuery({ queryKey: ["overview", days], queryFn: () => api.overview(days), refetchInterval: 30_000 });
  const d = q.data;
  const t: Totals | undefined = d ? (days === 1 ? d.today : d.period) : undefined;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="نظرة عامة"
        subtitle="أرقام واتساب والمساعد. بتتحدّث كل 30 ثانية، بتوقيت ليبيا."
        actions={RANGES.map((r) => (
          <button
            key={r.days}
            onClick={() => setDays(r.days)}
            className={`rounded-xl px-3 py-1.5 text-sm ${days === r.days ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg"}`}
          >
            {r.label}
          </button>
        ))}
      />
      <ErrorNote error={q.error} />

      {t && d && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Stat icon={Users} label="محادثات" value={num(t.conversations)} hint={`${num(t.customerMessages)} رسالة من الزباين`} />
            <Stat icon={UserPlus} label="زباين جدد" value={num(t.newCustomers)} hint="أول مرة بيكتبولنا" tone="info" />
            <Stat
              icon={ShoppingBag}
              label="الطلبات"
              value={<Link href="/orders">{num(t.orders + (t.teamOrders ?? 0))}</Link>}
              hint={`${num(t.orders)} جمعها المساعد · ${num(t.teamOrders ?? 0)} سجّلها الفريق`}
              tone="ok"
            />
            <Stat icon={Bot} label="ردود المساعد" value={num(t.aiReplies)} hint={`${num(t.staffMessages)} رد من الفريق`} tone="ok" />
            <Stat
              icon={Hand}
              label="تحويلات للفريق"
              value={num(t.handoffs)}
              hint={t.errors ? `${num(t.errors)} خطأ` : "بدون أخطاء"}
              tone={t.errors ? "bad" : "warn"}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              icon={ShieldCheck}
              label="حلّها المساعد لحالو"
              value={pct(t.aiOnlyConversations, t.aiConversations)}
              hint={`${num(t.aiOnlyConversations)} من ${num(t.aiConversations)} محادثة رد فيها المساعد، بلا تحويل (الطلبات محسوبة نجاح)`}
            />
            <Stat
              icon={Gauge}
              label="نسبة التحويل"
              value={pct(t.handoffs + t.errors, t.aiReplies + t.handoffs + t.orders + t.errors)}
              hint="من كل قرارات المساعد"
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

          {days > 1 && (
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

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <h2 className="mb-1 font-semibold">أوقات رسائل الزباين</h2>
              <p className="mb-4 text-xs text-muted">كل ساعة من اليوم، بتوقيت ليبيا. بيساعد بتوقيت الإعلانات ودوام الفريق.</p>
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
                        href={h.channel === "whatsapp" ? `/inbox/${h.customer}` : "/handoffs"}
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

function Usage({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-card-2 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="num mt-1 font-semibold">{value}</div>
    </div>
  );
}
