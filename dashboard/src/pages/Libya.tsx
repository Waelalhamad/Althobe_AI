// The team's view of the Libya employee: his cash box and his bank account (balances, in and out over a period, Darb's
// payouts next to what he logged from Darb on either), the whole log, and his own stock with every change he made.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDownCircle, ArrowUpCircle, Boxes, HandCoins, Landmark, Wallet } from "lucide-react";
import { ACCOUNT_NAME, api, OPENING, type Account, type CashRow } from "../api";
import { Badge, Card, ErrorNote, PageHeader, Stat } from "../components/ui";
import { CashButtons, CashList, lyd } from "../components/StaffCash";
import { StaffStock, useStaffStock } from "../components/StaffStock";
import { CountReports } from "../components/CountReports";
import { OpeningCash, OpeningCashSummary, OpeningStock, OpeningStockSummary, useOpening } from "../components/Opening";
import { useStaffCash } from "./Staff";
import { num, time } from "../format";

const DAY = 24 * 60 * 60 * 1000;
const PERIODS: { id: string; label: string; from: () => number }[] = [
  { id: "all", label: "كل الوقت", from: () => 0 },
  { id: "month", label: "هالشهر", from: () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() },
  { id: "30", label: "آخر 30 يوم", from: () => Date.now() - 30 * DAY },
  { id: "7", label: "آخر 7 أيام", from: () => Date.now() - 7 * DAY },
];
const DARB = "درب السبيل";
// A line counts in the totals unless it is the opening, undone, a correction, or money moved between box and bank.
const counts = (r: CashRow, moves: string[]) => r.undoes === null && r.undoneBy === null && r.kind !== OPENING && !moves.includes(r.kind);
const ACCOUNTS: [Account | undefined, string][] = [
  [undefined, "الكل"],
  ["cash", "الصندوق"],
  ["bank", "البنك"],
];

export function Libya() {
  const [period, setPeriod] = useState("month");
  const [direction, setDirection] = useState<"in" | "out">();
  const [kind, setKind] = useState<string>();
  const [account, setAccount] = useState<Account>();
  const [formAccount, setFormAccount] = useState<Account>("cash");
  const [tab, setTab] = useState<"cash" | "stock" | "count">("cash");
  const cash = useStaffCash(5000);
  const opening = useOpening();
  const from = PERIODS.find((p) => p.id === period)!.from();
  const c = cash.data;

  const moves = c?.moveKinds ?? [];
  const inPeriod = useMemo(() => (c?.rows ?? []).filter((r) => r.at >= from && (!account || r.account === account)), [c, from, account]);
  // Totals leave out the opening count (money he already had, not money that came in), a line that was undone and the correction that undid it (they cancel each other).
  const sum = (dir: "in" | "out", k?: string) => inPeriod.filter((r) => counts(r, moves) && r.direction === dir && (!k || r.kind === k)).reduce((n, r) => n + r.amount, 0);
  const shown = inPeriod.filter((r) => (!direction || r.direction === direction) && (!kind || r.kind === kind));
  const kinds = [...new Set(inPeriod.filter((r) => !direction || r.direction === direction).map((r) => r.kind))];

  // Darb's payouts since the log began (older ones were before the employee logged anything), against what he logged
  // from Darb in his box and his bank together (Darb may pay either way).
  const firstAt = c?.rows[c.rows.length - 1]?.at;
  const compareFrom = firstAt === undefined ? undefined : Math.max(from, new Date(firstAt).setHours(0, 0, 0, 0));
  const money = useQuery({
    queryKey: ["money-libya", compareFrom],
    queryFn: () => api.money(compareFrom),
    enabled: compareFrom !== undefined,
    retry: false,
  });
  const darbPaid = (money.data?.payouts ?? []).filter((p) => compareFrom !== undefined && p.at >= compareFrom).reduce((n, p) => n + p.amount, 0);
  const darbLogged = (c?.rows ?? []).filter((r) => compareFrom !== undefined && r.at >= compareFrom && r.kind === DARB && counts(r, moves)).reduce(
    (n, r) => n + (r.direction === "in" ? r.amount : -r.amount),
    0,
  );
  const gap = darbPaid - darbLogged;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="موظف ليبيا"
        subtitle="صندوقو وحسابو بالبنك (شو دخل وشو طلع، من وين ولشو، بالدينار) وجرد المستودع: بيعدّ مخزوننا بدون ما يشوف أعدادو، وأنتو بتعتمدو الجرد أو بترفضوه. هو بيفوت من تلفونو بكلمة سر STAFF_PASSWORD، وما بيشوف غير هالشي."
        actions={
          <div className="flex gap-1 rounded-xl bg-card-2 p-1">
            {(
              [
                ["cash", "المصاري"],
                ["count", "الجرد"],
                ["stock", "مخزونو القديم"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={clsx("rounded-lg px-4 py-1.5 text-sm", tab === id ? "bg-primary text-white" : "text-muted hover:text-fg")}
              >
                {label}
              </button>
            ))}
          </div>
        }
      />

      {tab === "count" ? (
        <CountReports />
      ) : tab === "stock" ? (
        <StockTab />
      ) : (
        <>
          <ErrorNote error={cash.error} />
          <div className="mb-4 flex flex-wrap gap-2">
            {ACCOUNTS.map(([a, label]) => (
              <button
                key={label}
                onClick={() => {
                  setAccount(a);
                  setKind(undefined);
                  if (a) setFormAccount(a);
                }}
                className={clsx("rounded-xl px-3 py-1.5 text-sm", account === a ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
              >
                {label}
              </button>
            ))}
            <span className="mx-1 h-8 w-px bg-line" />
            {PERIODS.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriod(p.id)}
                className={clsx("rounded-xl px-3 py-1.5 text-sm", period === p.id ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
              >
                {p.label}
              </button>
            ))}
          </div>
          {opening.data && (!opening.data.cash || !opening.data.bank) && (
            <div className="mb-4 grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
              {!opening.data.cash && <OpeningCash account="cash" />}
              {!opening.data.bank && <OpeningCash account="bank" />}
            </div>
          )}
          {c && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {account ? (
                  <Stat
                    icon={account === "bank" ? Landmark : Wallet}
                    label={account === "bank" ? "بحسابو بالبنك" : "معو بالصندوق"}
                    value={lyd(c.balances[account])}
                    tone={c.balances[account] < 0 ? "bad" : "primary"}
                    hint="مجموع كل حركاتو"
                  />
                ) : (
                  <Stat
                    icon={Wallet}
                    label="معو كلو"
                    value={lyd(c.balances.cash + c.balances.bank)}
                    tone={c.balances.cash + c.balances.bank < 0 ? "bad" : "primary"}
                    hint={`صندوق ${lyd(c.balances.cash)} · بنك ${lyd(c.balances.bank)}`}
                  />
                )}
                <Stat icon={ArrowDownCircle} tone="ok" label="استلم" value={lyd(sum("in"))} hint={`منها من درب ${lyd(sum("in", DARB))}`} />
                <Stat icon={ArrowUpCircle} tone="bad" label="دفع / سلّم" value={lyd(sum("out"))} hint={`منها للشركة ${lyd(sum("out", "تحويل للشركة"))}`} />
                <Stat
                  icon={HandCoins}
                  tone={!money.data ? "info" : Math.abs(gap) < 1 ? "ok" : "warn"}
                  label="درب حوّلت / هو سجّل"
                  value={money.data ? `${num(darbPaid)} / ${num(darbLogged)}` : "—"}
                  hint={
                    compareFrom === undefined
                      ? "لسا ما سجّل شي"
                      : money.error
                        ? "ما قدرنا نجيب تحويلات درب"
                        : Math.abs(gap) < 1
                          ? `متطابق من ${time(compareFrom).slice(0, 5)}`
                          : gap > 0
                            ? `ناقص ${lyd(gap)} ما سجّلها من درب`
                            : `سجّل ${lyd(-gap)} أكتر من تحويلات درب`
                  }
                />
              </div>

              <div className="mt-2 flex flex-col gap-1">
                <OpeningCashSummary account="cash" />
                <OpeningCashSummary account="bank" />
              </div>
              <Card className="mt-4 flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-semibold">سجّل حركة عنو</h3>
                  <div className="ms-auto flex gap-1 rounded-xl bg-card-2 p-1">
                    {(["cash", "bank"] as const).map((a) => (
                      <button
                        key={a}
                        onClick={() => setFormAccount(a)}
                        className={clsx("rounded-lg px-3 py-1 text-sm", formAccount === a ? "bg-primary text-white" : "text-muted hover:text-fg")}
                      >
                        {ACCOUNT_NAME[a]}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex max-w-md flex-col gap-3">
                  <CashButtons account={formAccount} kinds={c.kinds} />
                </div>
              </Card>

              <Card className="mt-4">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {(
                    [
                      [undefined, "الكل"],
                      ["in", "استلم"],
                      ["out", "دفع"],
                    ] as const
                  ).map(([d, label]) => (
                    <button
                      key={label}
                      onClick={() => {
                        setDirection(d);
                        setKind(undefined);
                      }}
                      className={clsx("rounded-xl px-3 py-1.5 text-sm", direction === d ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="mx-1 h-5 w-px bg-line" />
                  {kinds.map((k) => (
                    <button
                      key={k}
                      onClick={() => setKind(kind === k ? undefined : k)}
                      className={clsx("rounded-xl px-3 py-1.5 text-sm", kind === k ? "bg-primary-soft font-semibold text-primary" : "bg-card-2 text-muted hover:text-fg")}
                    >
                      {k}
                    </button>
                  ))}
                  <span className="ms-auto text-sm text-muted">
                    <span className="num">{shown.length}</span> حركة
                  </span>
                </div>
                <CashList rows={shown} showWho showAccount={!account} />
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

function StockTab() {
  const q = useStaffStock(300);
  const opening = useOpening();
  const log = q.data?.log ?? [];
  const counting = opening.data && !opening.data.stock;
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div>
        <p className="mb-3 text-sm text-muted">
          مخزونو هو، منفصل عن «المخزون والراجع»: المساعد والطلبات ما بيقروه وما بيغيّروه. أي تعديل هون بينسجل باسم الإدارة.
        </p>
        {counting ? q.data && <OpeningStock current={q.data.rows} /> : <StaffStock />}
      </div>
      <div className="flex flex-col gap-6">
      <OpeningStockSummary />
      <Card>
        <h3 className="mb-2 flex items-center gap-2 font-semibold">
          <Boxes size={18} /> سجل التعديلات
        </h3>
        {!log.length && <p className="py-6 text-center text-sm text-muted">لسا ما في تعديلات.</p>}
        <ul className="flex flex-col divide-y divide-line text-sm">
          {log.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-semibold">
                {l.product} · {l.color} · <span className="num">{l.size}</span>
              </span>
              <span className="num">
                {l.before === null ? "جديد" : l.before} ← {l.after === null ? "انشال" : l.after}
              </span>
              {l.before !== null && l.after !== null && (
                <Badge tone={l.after > l.before ? "ok" : "bad"}>
                  <span className="num ltr">{l.after > l.before ? `+${l.after - l.before}` : l.after - l.before}</span>
                </Badge>
              )}
              {l.reason === "opening" && <Badge tone="primary">جرد افتتاحي</Badge>}
              {l.byRole === "admin" && <Badge tone="info">الإدارة</Badge>}
              <span className="ltr num ms-auto text-xs text-muted">{time(l.at)}</span>
            </li>
          ))}
        </ul>
      </Card>
      </div>
    </div>
  );
}
