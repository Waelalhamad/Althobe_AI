import type { ReactNode } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  CheckCircle2,
  ClipboardCheck,
  MessageCircle,
  MessagesSquare,
  PackageCheck,
  ShoppingBag,
  Truck,
  Undo2,
  UserPlus,
  type LucideIcon,
} from "lucide-react";
import { api } from "../api";
import { Card, ErrorNote } from "../components/ui";
import { ago, localDate, num, phone } from "../format";

// The team's home page: what needs doing now, in the order of the work, each with where to do it.
// Above it, an order's journey from the first message to the money, with how many orders are at each step.
export function Today() {
  const orders = useQuery({ queryKey: ["orders", { status: "new" }, ""], queryFn: () => api.orders({ status: "new" }), refetchInterval: 30_000 });
  const today = localDate(0);
  const overview = useQuery({ queryKey: ["overview", { from: today, to: today }], queryFn: () => api.overview({ from: today, to: today }), refetchInterval: 60_000 });
  const supervisor = useQuery({ queryKey: ["supervisor", 1], queryFn: () => api.supervisor(1), refetchInterval: 60_000 });
  const returns = useQuery({ queryKey: ["incoming-returns"], queryFn: api.incomingReturns, refetchInterval: 60_000, retry: false });

  const o = orders.data;
  const darb = o?.darb ?? false;
  const d = o?.darbCounts;
  // Five minutes or more: the assistant answers within a few minutes, so these really wait for someone.
  // Older than a day is a lost chat, not today's work. Newest first: the ones still likely to answer.
  const waiting = (supervisor.data?.waiting ?? []).filter((w) => w.minutes >= 5 && w.minutes < 24 * 60).sort((a, b) => b.since - a.since);
  const coming = (returns.data ?? []).filter((r) => !r.back);
  const t = overview.data?.period;

  const tasks: Task[] = [
    {
      icon: MessageCircle,
      title: "زباين ناطرين رد",
      how: "آخر رسالة منهم (آخر 24 ساعة) ما إلها رد من 5 دقايق أو أكتر، غالباً لأنو المحادثة مع الفريق. الأحدث فوق: افتح المحادثة ورد.",
      count: waiting.length,
      href: "/inbox",
      go: "المحادثات",
      tone: "bad",
      extra: waiting.slice(0, 5).map((w) => (
        <Link key={w.customer} href={`/inbox/${encodeURIComponent(w.customer)}`} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-xs hover:bg-card-2">
          <span className="ltr num">{phone(w.customer)}</span>
          <span className="truncate text-muted">{w.lastText}</span>
          <span className="shrink-0 text-warn">من {ago(w.since)}</span>
        </Link>
      )),
    },
    {
      icon: ClipboardCheck,
      title: "طلبات جديدة بدها تأكيد",
      how: "راسل الزبون أو اتصل فيه، تأكد من المقاس والعنوان، وبعدين خلّي حالة الطلب «متأكد».",
      count: o?.counts.new ?? 0,
      href: "/orders?tab=new",
      go: "الطلبات الجديدة",
      tone: "warn",
    },
    ...(darb
      ? ([
          {
            icon: Truck,
            title: "طلبات متأكدة لسا ما انبعتت لدرب السبيل",
            how: "افتح الطلب واضغط «ابعت لدرب»، تأكد من المدينة والمنطقة. إذا بعتّوها من تطبيق درب، اربطها برقم الشحنة.",
            count: o?.unsent ?? 0,
            href: "/orders?tab=unsent",
            go: "ابعتها لدرب",
            tone: "warn",
          },
          {
            icon: AlertTriangle,
            title: "شحنات مؤجلة عند درب",
            how: "الزبون ما رد على المندوب أو طلب يأجل. راسل الزبون وخبّرو إنو المندوب جاي.",
            count: d?.delayed ?? 0,
            href: "/orders?tab=delayed",
            go: "الشحنات المؤجلة",
            tone: "bad",
          },
          {
            icon: Undo2,
            title: "بضاعة راجعة لعنا",
            how: "طلبات انلغت أو الزبون رفضها. قرّروا: تتحول لزبون تاني بنفس المدينة، ولا ترجع للمخزن.",
            count: coming.length,
            href: "/stock",
            go: "البضاعة الراجعة",
            tone: "warn",
          },
          {
            icon: Banknote,
            title: "شحنات انسلمت ومصاريها لسا عند درب",
            how: "ما بدها شي منكم: درب بتحوّل المصاري عالمحفظة. إذا طوّلت، تابعوها بصفحة الفلوس.",
            count: d?.unpaid ?? 0,
            href: "/money",
            go: "الفلوس",
            tone: "info",
          },
        ] satisfies Task[])
      : []),
  ];
  const todo = tasks.filter((x) => x.count > 0);
  const done = tasks.filter((x) => x.count === 0);
  const loading = orders.isLoading;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold">شو لازم نعمل اليوم</h1>
        <p className="mt-1 text-sm text-muted">الشغل اللي ناطركم هلق، بالترتيب. كل سطر فيه شو تعمل ووين. الصفحة بتتحدّث لحالها.</p>
      </div>
      <ErrorNote error={orders.error} />

      <Journey
        steps={[
          { icon: MessagesSquare, title: "الزبون بيراسلنا", hint: "المساعد بيرد ويبعت الصور والسعر", value: t?.conversations },
          { icon: ShoppingBag, title: "الزبون بيأكد الملخص", hint: "بينحفظ «طلب جديد»", value: o?.counts.new },
          { icon: ClipboardCheck, title: "الفريق بيتأكد", hint: "المقاس والعنوان، والحالة «متأكد»", value: darb ? o?.unsent : o?.counts.confirmed },
          ...(darb
            ? [
                { icon: Truck, title: "بينبعت لدرب", hint: "المندوب بياخدو ويوصّلو", value: d?.active },
                { icon: PackageCheck, title: "مكتملة", hint: "الزبون استلم ودفع", value: d?.completed },
                { icon: Banknote, title: "المصاري بتوصلنا", hint: "درب بتحوّل عالمحفظة", value: d?.paid },
              ]
            : []),
        ]}
      />

      {!loading && todo.length === 0 && (
        <Card className="flex items-center gap-3 border border-ok/40">
          <CheckCircle2 size={28} className="text-ok" />
          <div>
            <div className="font-semibold">ما في شي ناطركم هلق 👌</div>
            <div className="text-sm text-muted">كل الطلبات متأكدة ومبعوتة، وما حدا ناطر رد.</div>
          </div>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {todo.map((x, n) => (
          <TaskCard key={x.title} n={n + 1} task={x} />
        ))}
      </div>

      {done.length > 0 && !loading && (
        <div className="flex flex-wrap gap-2">
          {done.map((x) => (
            <span key={x.title} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-xs text-muted">
              <CheckCircle2 size={14} className="text-ok" /> {x.title}: ما في
            </span>
          ))}
        </div>
      )}

      {t && (
        <Card className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <span className="text-sm font-semibold">اليوم لهلق</span>
          <Mini icon={MessagesSquare} label="محادثة" value={t.conversations} />
          <Mini icon={UserPlus} label="زبون جديد" value={t.newCustomers} />
          <Mini icon={ShoppingBag} label="طلب من المساعد" value={t.orders} />
          <Mini icon={ShoppingBag} label="طلب من الفريق" value={t.teamOrders ?? 0} />
          <Link href="/stats" className="ms-auto flex items-center gap-1 text-sm text-primary hover:underline">
            كل الأرقام <ArrowLeft size={14} />
          </Link>
        </Card>
      )}
    </div>
  );
}

type Task = {
  icon: LucideIcon;
  title: string;
  how: string;
  count: number;
  href: string;
  go: string;
  tone: "warn" | "bad" | "info";
  extra?: ReactNode[];
};

const TONE = {
  warn: { box: "border-warn/40", icon: "bg-warn/15 text-warn", count: "text-warn" },
  bad: { box: "border-bad/40", icon: "bg-bad/15 text-bad", count: "text-bad" },
  info: { box: "border-info/30", icon: "bg-info/15 text-info", count: "text-info" },
};

function TaskCard({ n, task }: { n: number; task: Task }) {
  const tone = TONE[task.tone];
  const Icon = task.icon;
  return (
    <Card className={`flex flex-col gap-3 border ${tone.box}`}>
      <div className="flex flex-wrap items-center gap-4">
        <div className={`grid size-11 shrink-0 place-items-center rounded-xl ${tone.icon}`}>
          <Icon size={22} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-semibold">
            <span className="text-xs text-muted">{n}.</span> {task.title}
            <span className={`num text-lg font-bold ${tone.count}`}>{num(task.count)}</span>
          </div>
          <div className="text-sm text-muted">{task.how}</div>
        </div>
        <Link href={task.href} className="flex items-center gap-1 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90">
          {task.go} <ArrowLeft size={15} />
        </Link>
      </div>
      {task.extra && task.extra.length > 0 && <div className="flex flex-col gap-0.5 border-t border-line pt-2">{task.extra}</div>}
    </Card>
  );
}

// An order's way from the first message to the money, with how many are at each step now.
function Journey({ steps }: { steps: { icon: LucideIcon; title: string; hint: string; value?: number }[] }) {
  return (
    <Card className="flex flex-col gap-3">
      <span className="text-sm font-semibold">شلون بيمشي الطلب</span>
      <div className="flex flex-wrap items-stretch gap-2">
        {steps.map((s, i) => {
          const Icon = s.icon;
          return (
            <div key={s.title} className="flex items-center gap-2">
              <div className="flex w-36 flex-col gap-1 rounded-xl bg-card-2 p-3">
                <div className="flex items-center justify-between">
                  <Icon size={16} className="text-primary" />
                  {s.value !== undefined && <span className="num text-sm font-bold">{num(s.value)}</span>}
                </div>
                <span className="text-sm font-medium">
                  {i + 1}. {s.title}
                </span>
                <span className="text-xs text-muted">{s.hint}</span>
              </div>
              {i < steps.length - 1 && <ArrowLeft size={16} className="hidden shrink-0 text-muted sm:block" />}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function Mini({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: number }) {
  return (
    <span className="flex items-center gap-2 text-sm">
      <Icon size={15} className="text-muted" />
      <span className="num font-bold">{num(value)}</span>
      <span className="text-muted">{label}</span>
    </span>
  );
}
