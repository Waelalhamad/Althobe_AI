import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Banknote, HandCoins, Landmark, Loader2, RefreshCw, Truck, Undo2, Wallet } from "lucide-react";
import { api, type MoneyStage } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Stat } from "../components/ui";
import { DARB_STATUS } from "../components/DarbSend";
import { STAGE } from "../components/DarbTrack";
import { ago, num, time } from "../format";

const DAY = 24 * 60 * 60 * 1000;
const PERIODS: { id: string; label: string; from: () => number | undefined }[] = [
  { id: "all", label: "كل الوقت", from: () => undefined },
  { id: "month", label: "هالشهر", from: () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() },
  { id: "30", label: "آخر 30 يوم", from: () => Date.now() - 30 * DAY },
  { id: "7", label: "آخر 7 أيام", from: () => Date.now() - 7 * DAY },
];

const dinar = (n: number) => (
  <>
    {num(n)} <span className="text-base font-normal text-muted">د</span>
  </>
);

// Money from Darb Assabil: what reached us, what the courier collected and Darb still holds, and what's on the way.
export function Money() {
  const queryClient = useQueryClient();
  const [period, setPeriod] = useState("all");
  const [stage, setStage] = useState<MoneyStage | undefined>();
  const [q, setQ] = useState("");
  const from = PERIODS.find((p) => p.id === period)?.from();
  const money = useQuery({ queryKey: ["money", period], queryFn: () => api.money(from), refetchInterval: 60_000 });
  const sync = useMutation({ mutationFn: api.syncDarb, onSuccess: () => queryClient.invalidateQueries({ queryKey: ["money"] }) });
  const m = money.data;

  const shipments = useMemo(() => {
    const needle = q.trim().replace(/^0/, "");
    return (m?.shipments ?? []).filter(
      (s) =>
        (!stage || s.stage === stage) &&
        (!needle || [s.reference, s.sh, s.name, s.phone, s.city, s.area].some((v) => v?.includes(needle))),
    );
  }, [m, stage, q]);

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="الفلوس"
        subtitle="من درب السبيل: شو وصلنا، شو انقبض من الزباين وبعدو عند درب، وشو عالطريق. بيتحدّث كل ربع ساعة."
        actions={
          <>
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={clsx("rounded-xl px-3 py-1.5 text-sm", period === p.id ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
              >
                {p.label}
              </button>
            ))}
            <Button variant="ghost" onClick={() => sync.mutate()} disabled={sync.isPending}>
              {sync.isPending ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />} حدّث من درب
            </Button>
          </>
        }
      />
      <ErrorNote error={money.error ?? sync.error} />

      {m && (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat icon={HandCoins} tone="ok" label="وصلتنا من درب" value={dinar(m.stages.paid.amount)} hint={`${m.stages.paid.count} شحنة`} />
            <Stat
              icon={Banknote}
              tone="warn"
              label="انقبضت، بعدها عند درب"
              value={dinar(m.stages.at_darb.amount)}
              hint={`${m.stages.at_darb.count} شحنة انسلمت وما تحوّلت`}
            />
            <Stat icon={Truck} tone="info" label="عالطريق" value={dinar(m.stages.on_way.amount)} hint={`${m.stages.on_way.count} شحنة لسا ما انسلمت`} />
            <Stat
              icon={Undo2}
              tone="bad"
              label="راجعة"
              value={dinar(m.stages.returned.amount)}
              hint={`${m.stages.returned.count} شحنة${m.stages.cancelled.count ? ` · ${m.stages.cancelled.count} ملغية` : ""}`}
            />
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="flex items-center gap-3">
              <Wallet size={20} className="text-primary" />
              <div>
                <div className="text-xs text-muted">رصيد محفظة درب هلأ</div>
                <div className="num text-lg font-semibold">{m.wallet === null ? "—" : `${num(m.wallet)} د`}</div>
              </div>
            </Card>
            <Card className="flex items-center gap-3">
              <Truck size={20} className="text-muted" />
              <div>
                <div className="text-xs text-muted">رسوم التوصيل (من المبيعات أو علينا)</div>
                <div className="num text-lg font-semibold">{num(m.shipping)} د</div>
              </div>
            </Card>
            <Card className="flex items-center gap-3">
              <Landmark size={20} className="text-info" />
              <div>
                <div className="text-xs text-muted">تحويل مصرفي (من طلباتنا، مش عن طريق درب)</div>
                <div className="num text-lg font-semibold">
                  {num(m.transfers.amount)} د <span className="text-xs font-normal text-muted">· {m.transfers.count} طلب</span>
                </div>
              </div>
            </Card>
          </div>

          {m.payouts.length > 0 && (
            <Card className="mt-4">
              <h3 className="mb-2 font-semibold">التحويلات من درب</h3>
              <ul className="flex flex-col divide-y divide-line text-sm">
                {m.payouts.map((p) => (
                  <li key={p.reference ?? p.at} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span>
                      <span className="num font-semibold">{num(p.amount)} د</span> · <span className="num">{p.count}</span> شحنة
                    </span>
                    <span className="text-xs text-muted">
                      {time(p.at)} {p.reference && <span className="num">· {p.reference}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card className="mt-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => setStage(undefined)}
                className={clsx("rounded-xl px-3 py-1.5 text-sm", !stage ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
              >
                الكل ({m.shipments.length})
              </button>
              {(Object.keys(STAGE) as MoneyStage[])
                .filter((s) => m.stages[s].count)
                .map((s) => (
                  <button
                    key={s}
                    onClick={() => setStage(s)}
                    className={clsx("rounded-xl px-3 py-1.5 text-sm", stage === s ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
                  >
                    {STAGE[s].label} ({m.stages[s].count})
                  </button>
                ))}
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="دوّر: رقم شحنة، اسم، رقم، مدينة"
                className="ms-auto w-full rounded-xl border border-line bg-card-2 px-3 py-1.5 text-sm outline-none focus:border-primary sm:w-64"
              />
            </div>
            {shipments.length === 0 ? (
              <Empty icon={Truck} text="ما في شحنات هون." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted">
                    <tr className="border-b border-line text-start">
                      <th className="p-2 text-start font-normal">الشحنة</th>
                      <th className="p-2 text-start font-normal">الزبون</th>
                      <th className="p-2 text-start font-normal">وين وصلت</th>
                      <th className="p-2 text-start font-normal">لإلنا</th>
                      <th className="p-2 text-start font-normal">المبلغ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipments.map((s) => (
                      <tr key={s.id} className="border-b border-line/60 align-top">
                        <td className="p-2">
                          <div className="num font-semibold">#{s.reference}</div>
                          <div className="text-xs text-muted">
                            {time(s.createdAt)}
                            {s.orderId && (
                              <>
                                {" · "}
                                <Link href="/orders" className="text-primary">
                                  طلب #{s.orderId}
                                </Link>
                              </>
                            )}
                          </div>
                        </td>
                        <td className="p-2">
                          <div>{s.name || "—"}</div>
                          <div className="ltr num text-start text-xs text-muted">{s.phone.replace(/^\+218/, "0")}</div>
                        </td>
                        <td className="p-2">
                          <Badge tone={STAGE[s.stage].tone}>{DARB_STATUS[s.status] ?? s.status}</Badge>
                          <div className="mt-1 text-xs text-muted">
                            {s.city}/{s.area}
                            {s.lastEventAt && ` · ${ago(s.lastEventAt)}`}
                          </div>
                        </td>
                        <td className="num p-2 font-semibold">{num(s.amount)} د</td>
                        <td className="p-2">
                          <Badge tone={STAGE[s.stage].tone}>{STAGE[s.stage].label}</Badge>
                          {s.paidAt && <div className="mt-1 text-xs text-muted">{s.payoutRef}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {m.lastSync && <div className="mt-3 text-xs text-muted">آخر تحديث من درب: {ago(m.lastSync)}</div>}
          </Card>
        </>
      )}
    </div>
  );
}
