import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  AlertTriangle,
  Bot,
  CheckCheck,
  ClipboardList,
  Clock,
  FileText,
  PackageCheck,
  RefreshCw,
  Star,
  ThumbsUp,
  User,
  UserX,
} from "lucide-react";
import { api, type IssueType, type Review, type SupervisorAlert } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Stat } from "../components/ui";
import { ago, num, phone, time, usd } from "../format";

const RANGES = [
  { days: 1, label: "اليوم" },
  { days: 7, label: "7 أيام" },
  { days: 30, label: "30 يوم" },
];

export const ISSUE_LABELS: Record<IssueType, string> = {
  slow_reply: "رد متأخر",
  unanswered_question: "سؤال بلا جواب",
  irrelevant_reply: "رد مو عالسؤال (نسخ ولصق)",
  rude_or_cold: "أسلوب جاف أو مو لطيف",
  wrong_info: "معلومة غلط",
  missed_sale: "ضيّع فرصة بيع",
  no_follow_up: "ما رجع للزبون",
  order_not_handled: "طلب ما تكمّل",
  unclear_message: "رسالة مو واضحة",
  other: "غير شي",
};

const OUTCOMES: Record<Review["outcome"], { label: string; tone: "ok" | "info" | "bad" | "muted" | "warn" }> = {
  ordered: { label: "طلب", tone: "ok" },
  interested: { label: "لسا عم يفكر", tone: "info" },
  lost: { label: "راح الزبون", tone: "bad" },
  no_reply_needed: { label: "ما بدها رد", tone: "muted" },
  support: { label: "متابعة طلب", tone: "warn" },
};

const SEVERITY = { high: { label: "مهم", tone: "bad" }, medium: { label: "متوسط", tone: "warn" }, low: { label: "بسيط", tone: "muted" } } as const;

const mins = (m: number) => (m < 60 ? `${m} د` : `${Math.floor(m / 60)} س ${m % 60 ? `${m % 60} د` : ""}`);

export function Supervisor() {
  const [days, setDays] = useState(7);
  const [onlyIssues, setOnlyIssues] = useState(true);
  const [reportIndex, setReportIndex] = useState(0);
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["supervisor", days], queryFn: () => api.supervisor(days), refetchInterval: 30_000 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["supervisor"] });
  const run = useMutation({ mutationFn: api.runSupervisor, onSuccess: refresh });
  const report = useMutation({ mutationFn: api.supervisorReport, onSuccess: () => (setReportIndex(0), refresh()) });
  const resolve = useMutation({ mutationFn: api.resolveAlert, onSuccess: refresh });
  const d = q.data;

  const highIssues = d?.reviews.reduce((n, r) => n + r.issues.filter((i) => i.severity === "high").length, 0) ?? 0;
  const reviews = d ? (onlyIssues ? d.reviews.filter((r) => r.issues.length) : d.reviews) : [];
  const issueRows = d
    ? (Object.entries(d.issues) as [IssueType, { team: number; ai: number }][]).sort((a, b) => b[1].team + b[1].ai - (a[1].team + a[1].ai))
    : [];
  const maxIssue = Math.max(1, ...issueRows.map(([, v]) => v.team + v.ai));
  const currentReport = d?.reports[reportIndex];
  const openAlerts = d?.alerts.filter((a) => !a.resolvedAt) ?? [];

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="المشرف العام"
        subtitle="بيراقب ردود الفريق والمساعد: مين ناطر رد، سرعة الرد، الأسلوب، المعلومات الغلط، والفرص يلي راحت. الملاحظات المهمة بتوصل عالتلغرام."
        actions={
          <>
            {RANGES.map((r) => (
              <button
                key={r.days}
                onClick={() => setDays(r.days)}
                className={clsx("rounded-xl px-3 py-1.5 text-sm", days === r.days ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
              >
                {r.label}
              </button>
            ))}
            <Button onClick={() => run.mutate()} disabled={run.isPending}>
              <RefreshCw size={16} className={run.isPending ? "animate-spin" : ""} /> {run.isPending ? "عم يراجع…" : "راجع المحادثات هلق"}
            </Button>
          </>
        }
      />
      <ErrorNote error={q.error ?? run.error ?? report.error} />
      {run.data && <p className="mb-4 text-sm text-muted">راجع {num(run.data.reviewed)} محادثة جديدة.</p>}

      {d && !d.settings.enabled && (
        <Card className="mb-6 border-warn/40">
          المشرف موقّف. شغّلو من <Link href="/settings" className="text-primary">الإعدادات</Link>.
        </Card>
      )}

      {d && (
        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Stat
              icon={UserX}
              label="ناطرين رد هلق"
              value={num(d.waiting.length)}
              hint={d.waiting.length ? `أطول انتظار ${mins(d.waiting[0]!.minutes)}` : "ما في حدا ناطر"}
              tone={d.waiting.some((w) => w.minutes >= d.settings.unansweredMinutes) ? "bad" : "ok"}
            />
            <Stat
              icon={Clock}
              label="سرعة الرد (النص)"
              value={d.response.replies ? mins(d.response.p50Min) : "—"}
              hint={d.response.replies ? `90% خلال ${mins(d.response.p90Min)} · ${num(d.response.slow)} رد متأخر` : "بوقت الدوام بس"}
              tone="info"
            />
            <Stat
              icon={Star}
              label="تقييم المحادثات"
              value={d.avgScore === null ? "—" : `${d.avgScore} / 5`}
              hint={`${num(d.reviews.length)} محادثة انراجعت · تكلفة ${usd(d.costUsd)}`}
              tone={d.avgScore !== null && d.avgScore < 3.5 ? "warn" : "ok"}
            />
            <Stat icon={AlertTriangle} label="ملاحظات مهمة" value={num(highIssues)} hint={`${num(openAlerts.length)} تنبيه مفتوح`} tone={highIssues ? "bad" : "ok"} />
            <Stat
              icon={PackageCheck}
              label="طلبات بدها تأكيد"
              value={<Link href="/orders">{num(d.unconfirmedOrders)}</Link>}
              hint={`تنبيه بعد ${d.settings.orderConfirmHours} ساعة`}
              tone={d.unconfirmedOrders ? "warn" : "ok"}
            />
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
            <Card className="xl:col-span-3">
              <h2 className="mb-1 font-semibold">ناطرين رد هلق</h2>
              <p className="mb-3 text-xs text-muted">آخر رسالة بالمحادثة من الزبون وما حدا رد. التنبيه بعد {d.settings.unansweredMinutes} دقيقة بوقت الدوام.</p>
              {d.waiting.length === 0 ? (
                <Empty icon={CheckCheck} text="كل الزباين انرد عليهم 👌" />
              ) : (
                <ul className="flex max-h-96 flex-col divide-y divide-line overflow-y-auto">
                  {d.waiting.map((w) => (
                    <li key={w.customer}>
                      <Link href={`/inbox/${w.customer}`} className="flex items-start justify-between gap-3 py-2.5 hover:text-primary">
                        <div className="min-w-0">
                          <div className="ltr num text-start text-sm">{phone(w.customer)}</div>
                          <div className="truncate text-xs text-muted">{w.lastText}</div>
                        </div>
                        <Badge tone={w.minutes >= d.settings.escalateMinutes ? "bad" : w.minutes >= d.settings.unansweredMinutes ? "warn" : "muted"}>
                          {mins(w.minutes)}
                          {w.messages > 1 && ` · ${w.messages} رسائل`}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="xl:col-span-2">
              <h2 className="mb-1 font-semibold">شو المشاكل يلي بتتكرر</h2>
              <p className="mb-3 text-xs text-muted">من مراجعة المحادثات بهالفترة.</p>
              {issueRows.length === 0 ? (
                <Empty icon={ThumbsUp} text="ما في مشاكل مسجلة." />
              ) : (
                <ul className="flex flex-col gap-3">
                  {issueRows.map(([type, v]) => (
                    <li key={type}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span>{ISSUE_LABELS[type]}</span>
                        <span className="num text-muted">
                          {v.team > 0 && `👤 ${v.team}`} {v.ai > 0 && `🤖 ${v.ai}`}
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-card-2">
                        <div className="h-full rounded-full bg-warn" style={{ width: `${((v.team + v.ai) / maxIssue) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-semibold">
                <FileText size={18} /> التقرير اليومي
              </h2>
              <div className="flex flex-wrap items-center gap-2">
                {d.reports.slice(0, 7).map((r, i) => (
                  <button
                    key={r.id}
                    onClick={() => setReportIndex(i)}
                    className={clsx("num rounded-lg px-2.5 py-1 text-xs", i === reportIndex ? "bg-primary text-white" : "bg-card-2 text-muted")}
                  >
                    {r.day.slice(5)}
                  </button>
                ))}
                <Button variant="ghost" onClick={() => report.mutate()} disabled={report.isPending}>
                  {report.isPending ? "عم يكتب…" : "اعمل تقرير اليوم هلق"}
                </Button>
              </div>
            </div>
            {currentReport ? (
              <>
                <p className="mb-2 text-xs text-muted">
                  {currentReport.day} · {time(currentReport.at)}
                </p>
                <div className="whitespace-pre-wrap rounded-xl bg-card-2 p-4 text-sm leading-7">{currentReport.text}</div>
              </>
            ) : (
              <Empty icon={FileText} text={`التقرير بيطلع كل يوم الساعة ${d.settings.reportHour}:00 وبيوصل عالتلغرام.`} />
            )}
          </Card>

          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 font-semibold">
                <ClipboardList size={18} /> مراجعة المحادثات
              </h2>
              <div className="flex gap-2">
                <button
                  onClick={() => setOnlyIssues(true)}
                  className={clsx("rounded-lg px-3 py-1 text-xs", onlyIssues ? "bg-primary text-white" : "bg-card-2 text-muted")}
                >
                  يلي فيها ملاحظات
                </button>
                <button
                  onClick={() => setOnlyIssues(false)}
                  className={clsx("rounded-lg px-3 py-1 text-xs", !onlyIssues ? "bg-primary text-white" : "bg-card-2 text-muted")}
                >
                  الكل ({num(d.reviews.length)})
                </button>
              </div>
            </div>
            {reviews.length === 0 ? (
              <Empty icon={ClipboardList} text="لسا ما في مراجعات. المشرف بيراجع المحادثات كل نص ساعة، أو اضغط «راجع المحادثات هلق»." />
            ) : (
              <ul className="flex flex-col gap-3">
                {reviews.map((r) => (
                  <ReviewCard key={r.id} r={r} />
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <h2 className="mb-3 flex items-center gap-2 font-semibold">
              <AlertTriangle size={18} /> التنبيهات
            </h2>
            {d.alerts.length === 0 ? (
              <Empty icon={CheckCheck} text="ما في تنبيهات بهالفترة." />
            ) : (
              <ul className="flex flex-col divide-y divide-line">
                {d.alerts.map((a) => (
                  <AlertRow key={a.id} a={a} onResolve={() => resolve.mutate(a.id)} />
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function ReviewCard({ r }: { r: Review }) {
  const outcome = OUTCOMES[r.outcome];
  return (
    <li className="rounded-xl border border-line bg-card-2/50 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge tone={r.score >= 4 ? "ok" : r.score === 3 ? "warn" : "bad"}>
          <Star size={12} /> {r.score}/5
        </Badge>
        <Badge tone={outcome.tone}>{outcome.label}</Badge>
        {r.customer.startsWith("cw:") ? (
          <span className="ltr num text-sm">{phone(r.customer)}</span>
        ) : (
          <Link href={`/inbox/${r.customer}`} className="ltr num text-sm hover:text-primary">
            {phone(r.customer)}
          </Link>
        )}
        <span className="text-xs text-muted">{ago(r.at)}</span>
      </div>
      <p className="text-sm">{r.summary}</p>
      {r.issues.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {r.issues.map((i, n) => (
            <li key={n} className="rounded-lg bg-card p-3 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY[i.severity].tone}>{SEVERITY[i.severity].label}</Badge>
                <span className="flex items-center gap-1 text-xs text-muted">
                  {i.who === "ai" ? <Bot size={12} /> : <User size={12} />} {i.who === "ai" ? "المساعد" : "الفريق"} · {ISSUE_LABELS[i.type]}
                </span>
              </div>
              <p>{i.problem}</p>
              {i.quote && <p className="mt-1 border-s-2 border-line ps-2 text-xs text-muted">«{i.quote}»</p>}
              <p className="mt-1 text-primary">💡 {i.advice}</p>
            </li>
          ))}
        </ul>
      )}
      {r.praise && <p className="mt-2 text-xs text-ok">👍 {r.praise}</p>}
    </li>
  );
}

function AlertRow({ a, onResolve }: { a: SupervisorAlert; onResolve: () => void }) {
  return (
    <li className={clsx("flex items-start justify-between gap-3 py-3", a.resolvedAt && "opacity-50")}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={SEVERITY[a.severity].tone}>{SEVERITY[a.severity].label}</Badge>
          <span className="font-medium">{a.title}</span>
        </div>
        <div className="mt-1 text-xs text-muted">
          {a.customer && !a.customer.startsWith("cw:") ? (
            <Link href={`/inbox/${a.customer}`} className="ltr num hover:text-primary">
              {phone(a.customer)}
            </Link>
          ) : (
            a.customer && <span className="ltr num">{phone(a.customer)}</span>
          )}{" "}
          · {ago(a.at)} {a.detail && `· ${a.detail}`}
        </div>
      </div>
      {!a.resolvedAt && (
        <button onClick={onResolve} className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs hover:border-primary">
          انحلّت
        </button>
      )}
    </li>
  );
}
