// Settings cards for the Telegram notifications and the supervisor.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageCircleMore, Search, Send, ShieldCheck } from "lucide-react";
import { api, type NotifyKind, type SupervisorSettings } from "../api";
import { Badge, Button, Card, ErrorNote, Toggle } from "../components/ui";
import { ago } from "../format";

const NOTIFY_LABELS: Record<NotifyKind, string> = {
  order: "طلب جديد جمعه المساعد",
  handoff: "المساعد حوّل زبون للفريق (ما عرف يجاوب)",
  lesson: "درس جديد للمساعد بانتظار موافقتك",
  error: "أخطاء ومشاكل بالنظام",
  supervisor: "تنبيهات المشرف (زبون ناطر، طلب ما تأكد، ملاحظات مهمة)",
  report: "التقرير اليومي",
};

export function TelegramCard() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["telegram"], queryFn: api.telegram });
  const t = q.data;
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const save = useMutation({
    mutationFn: api.saveTelegram,
    onSuccess: (data) => {
      queryClient.setQueryData(["telegram"], data);
      setToken("");
      setChatId("");
    },
  });
  const groups = useMutation({ mutationFn: api.telegramGroups });
  const test = useMutation({ mutationFn: api.telegramTest, onSuccess: () => void q.refetch() });

  const ready = Boolean(t?.bot && t.chat);
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <span className={`grid size-11 shrink-0 place-items-center rounded-xl ${ready ? "bg-ok/12 text-ok" : "bg-info/12 text-info"}`}>
          <Send size={20} />
        </span>
        <div className="flex-1">
          <h2 className="font-semibold">إشعارات تلغرام</h2>
          <p className="mt-1 text-sm text-muted">
            بوت تلغرام ببعت لغروب الفريق: الطلبات الجديدة، الزباين يلي بدهم حدا، الأخطاء، وتنبيهات وتقارير المشرف.
          </p>
        </div>
        {t && <Badge tone={ready ? "ok" : t.error ? "bad" : "warn"}>{ready ? "شغّال" : t.error ? "في مشكلة" : "ناقص"}</Badge>}
      </div>
      <ErrorNote error={q.error ?? save.error ?? groups.error ?? test.error} />
      {t?.error && <p className="ltr rounded-xl bg-bad/10 p-3 text-start text-xs text-bad">{t.error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl bg-card-2 p-3">
          <div className="text-xs text-muted">البوت</div>
          <div className="mt-1 text-sm">
            {t?.bot ? (
              <a href={`https://t.me/${t.bot.username}`} target="_blank" rel="noreferrer" className="ltr text-primary">
                @{t.bot.username}
              </a>
            ) : (
              "ما في توكن"
            )}
            {t?.tokenHint && <span className="ltr num ms-2 text-xs text-muted">{t.tokenHint}</span>}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="توكن جديد من BotFather"
              className="ltr min-w-0 flex-1 rounded-lg border border-line bg-card px-2 py-1.5 text-xs outline-none focus:border-primary"
            />
            <Button onClick={() => save.mutate({ token })} disabled={!token.trim() || save.isPending}>
              حفظ
            </Button>
          </div>
        </div>
        <div className="rounded-xl bg-card-2 p-3">
          <div className="text-xs text-muted">الغروب</div>
          <div className="mt-1 text-sm">
            {t?.chat ? (
              <>
                {t.chat.title ?? t.chat.username} <span className="ltr num text-xs text-muted">{t.chatId}</span>
              </>
            ) : t?.chatId ? (
              <span className="ltr num">{t.chatId}</span>
            ) : (
              "لسا ما انختار"
            )}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
              placeholder="-100… (أو دوّر تحت)"
              className="ltr num min-w-0 flex-1 rounded-lg border border-line bg-card px-2 py-1.5 text-xs outline-none focus:border-primary"
            />
            <Button onClick={() => save.mutate({ chatId })} disabled={!chatId.trim() || save.isPending}>
              حفظ
            </Button>
          </div>
        </div>
      </div>

      {t?.bot && (
        <div className="rounded-xl border border-line p-3 text-sm">
          <p className="text-muted">
            1. ضيف <span className="ltr">@{t.bot.username}</span> عالغروب. 2. ابعت بالغروب رسالة{" "}
            <span className="ltr">/start@{t.bot.username}</span>. 3. اضغط «دوّر على الغروب» واختارو.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={() => groups.mutate()} disabled={groups.isPending}>
              <Search size={16} /> {groups.isPending ? "عم يدوّر…" : "دوّر على الغروب"}
            </Button>
            {groups.data?.length === 0 && (
              <span className="text-xs text-muted">ما لقى غروب. تأكد إنك بعتت رسالة بالغروب بعد ما ضفت البوت.</span>
            )}
            {groups.data?.map((g) => (
              <Button key={g.id} onClick={() => save.mutate({ chatId: String(g.id) })} disabled={save.isPending}>
                اختار «{g.title ?? g.id}»
              </Button>
            ))}
          </div>
        </div>
      )}

      {t?.bot && t.chatId && (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? "عم يبعت…" : "ابعت رسالة تجربة"}
          </Button>
          {test.isSuccess && <span className="text-sm text-ok">انبعتت ✅ شوفو الغروب.</span>}
          {t.last && (
            <span className={`text-xs ${t.last.ok ? "text-muted" : "text-bad"}`}>
              آخر إشعار {ago(t.last.at)}: {t.last.ok ? "وصل" : t.last.error}
            </span>
          )}
        </div>
      )}

      {t && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <div className="text-xs text-muted">شو يوصل عالغروب:</div>
          {(Object.keys(NOTIFY_LABELS) as NotifyKind[]).map((kind) => (
            <label key={kind} className="flex items-center justify-between gap-3 text-sm">
              <span>{NOTIFY_LABELS[kind]}</span>
              <Toggle
                checked={!t.muted.includes(kind)}
                disabled={save.isPending}
                onChange={(on) => save.mutate({ muted: on ? t.muted.filter((k) => k !== kind) : [...t.muted, kind] })}
              />
            </label>
          ))}
        </div>
      )}
    </Card>
  );
}

const NUMBER_FIELDS: { key: keyof SupervisorSettings; label: string; unit: string }[] = [
  { key: "unansweredMinutes", label: "تنبيه إذا زبون ناطر رد أكتر من", unit: "دقيقة" },
  { key: "escalateMinutes", label: "تنبيه تاني (أحمر) بعد", unit: "دقيقة" },
  { key: "orderConfirmHours", label: "تنبيه إذا طلب ما تأكد بعد", unit: "ساعة" },
  { key: "workStart", label: "بداية الدوام", unit: "الساعة" },
  { key: "workEnd", label: "نهاية الدوام", unit: "الساعة" },
  { key: "reportHour", label: "وقت التقرير اليومي", unit: "الساعة" },
  { key: "dailyReviewCap", label: "أكتر عدد مراجعات باليوم (للتكلفة)", unit: "محادثة" },
];

export function SupervisorCard() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["supervisor", 1], queryFn: () => api.supervisor(1) });
  const s = q.data?.settings;
  const [draft, setDraft] = useState<Partial<SupervisorSettings>>({});
  const save = useMutation({
    mutationFn: api.saveSupervisor,
    onSuccess: () => {
      setDraft({});
      void queryClient.invalidateQueries({ queryKey: ["supervisor"] });
    },
  });
  if (!s) return <ErrorNote error={q.error} />;
  const value = (k: keyof SupervisorSettings) => (draft[k] ?? s[k]) as number;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <span className={`grid size-11 shrink-0 place-items-center rounded-xl ${s.enabled ? "bg-ok/12 text-ok" : "bg-card-2 text-muted"}`}>
          <ShieldCheck size={20} />
        </span>
        <div className="flex-1">
          <h2 className="font-semibold">المشرف العام</h2>
          <p className="mt-1 text-sm text-muted">
            بيراقب مين ناطر رد والطلبات يلي ما تأكدت (ببلاش)، وبيراجع المحادثات بالذكاء الاصطناعي كل نص ساعة. ما بيبعت شي للزباين أبداً.
          </p>
        </div>
        <Toggle checked={s.enabled} onChange={(on) => save.mutate({ enabled: on })} disabled={save.isPending} />
      </div>
      <label className="flex items-center justify-between gap-3 rounded-xl bg-card-2 p-3 text-sm">
        <span>
          مراجعة المحادثات والتقرير اليومي بالذكاء الاصطناعي
          <span className="block text-xs text-muted">تقريباً $0.001–0.003 للمحادثة الواحدة</span>
        </span>
        <Toggle checked={s.reviews} onChange={(on) => save.mutate({ reviews: on })} disabled={save.isPending} />
      </label>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {NUMBER_FIELDS.map((f) => (
          <label key={f.key} className="flex items-center justify-between gap-3 rounded-xl bg-card-2 p-3 text-sm">
            <span className="text-muted">{f.label}</span>
            <span className="flex items-center gap-2">
              <input
                type="number"
                value={value(f.key)}
                onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                className="num w-20 rounded-lg border border-line bg-card px-2 py-1 text-center outline-none focus:border-primary"
              />
              <span className="text-xs text-muted">{f.unit}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => save.mutate(draft)} disabled={!Object.keys(draft).length || save.isPending}>
          حفظ
        </Button>
        <span className="text-xs text-muted">الساعات بتوقيت ليبيا. نهاية الدوام 24 = نص الليل.</span>
        <ErrorNote error={save.error} />
      </div>
    </Card>
  );
}

export function FollowUpCard() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["followup"], queryFn: api.followUp });
  const [minutes, setMinutes] = useState<number>();
  const save = useMutation({
    mutationFn: api.saveFollowUp,
    onSuccess: (data) => {
      queryClient.setQueryData(["followup"], data);
      setMinutes(undefined);
    },
  });
  const f = q.data;
  if (!f) return <ErrorNote error={q.error} />;
  const { settings: s, stats } = f;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <span className={`grid size-11 shrink-0 place-items-center rounded-xl ${s.enabled ? "bg-ok/12 text-ok" : "bg-card-2 text-muted"}`}>
          <MessageCircleMore size={20} />
        </span>
        <div className="flex-1">
          <h2 className="font-semibold">رسالة المتابعة التلقائية</h2>
          <p className="mt-1 text-sm text-muted">
            إذا الزبون سكت بعد رد المساعد، بيبعتلو رسالة وحدة لطيفة بس (بلا ضغط)، بوقت الدوام وجوّا الـ 24 ساعة تبع واتساب. إذا قال
            «بفكر» أو شكر أو اشتكى أو عندو طلب، ما بيبعت شي. ما بتشتغل إلا إذا ردود المساعد شغّالة. أسلوبها بيتعدل من ملف «طريقة
            الكلام».
          </p>
        </div>
        <Toggle checked={s.enabled} onChange={(on) => save.mutate({ enabled: on })} disabled={save.isPending} />
      </div>
      <div className="flex flex-wrap items-center gap-3 rounded-xl bg-card-2 p-3 text-sm">
        <span className="text-muted">بيبعتها بعد سكوت</span>
        <input
          type="number"
          min={30}
          max={1200}
          value={minutes ?? s.afterMinutes}
          onChange={(e) => setMinutes(Number(e.target.value))}
          className="num w-20 rounded-lg border border-line bg-card px-2 py-1 text-center outline-none focus:border-primary"
        />
        <span className="text-xs text-muted">دقيقة (من 30 لـ 1200)</span>
        <Button onClick={() => save.mutate({ afterMinutes: minutes })} disabled={minutes === undefined || save.isPending}>
          حفظ
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-3 text-center">
        {[
          { label: "انبعتت (آخر 7 أيام)", value: stats.sent },
          { label: "الزبون رد بعدها", value: stats.replied },
          { label: "ما بعت (ما بتناسب)", value: stats.skipped },
        ].map((x) => (
          <div key={x.label} className="rounded-xl bg-card-2 p-3">
            <div className="num text-xl font-semibold">{x.value}</div>
            <div className="mt-1 text-xs text-muted">{x.label}</div>
          </div>
        ))}
      </div>
      <ErrorNote error={save.error} />
    </Card>
  );
}
