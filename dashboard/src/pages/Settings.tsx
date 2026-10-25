import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, CircleSlash, FlaskConical, Power } from "lucide-react";
import { api, type Settings } from "../api";
import { Badge, Button, Card, ErrorNote, PageHeader, Toggle } from "../components/ui";
import { ago } from "../format";
import { FollowUpCard, SupervisorCard, TelegramCard } from "./SettingsAlerts";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const s = q.data;
  const [numbers, setNumbers] = useState("");

  useEffect(() => {
    if (s) setNumbers(s.testNumbers.join("\n"));
  }, [s?.testNumbers.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: (patch: Partial<Pick<Settings, "aiReplies" | "testNumbers">>) => api.saveSettings(patch),
    onSuccess: (data) => queryClient.setQueryData(["settings"], data),
  });

  if (!s) return <ErrorNote error={q.error} />;

  const toggleAi = (on: boolean) => {
    if (on && !s.testNumbers.length && !window.confirm("المساعد رح يرد على كل الزباين بواتساب وإنستغرام وماسنجر. متأكد؟")) return;
    save.mutate({ aiReplies: on });
  };
  const parsedNumbers = numbers.split(/[\s,]+/).map((n) => n.replace(/\D/g, "")).filter(Boolean);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <PageHeader title="الإعدادات" subtitle="التغييرات بتشتغل فوراً، بدون إعادة تشغيل." />
      <ErrorNote error={save.error} />

      <Card className="flex items-start gap-4">
        <span className={`grid size-11 shrink-0 place-items-center rounded-xl ${s.aiReplies ? "bg-ok/12 text-ok" : "bg-card-2 text-muted"}`}>
          <Power size={20} />
        </span>
        <div className="flex-1">
          <h2 className="font-semibold">ردود المساعد</h2>
          <p className="mt-1 text-sm text-muted">
            {s.aiReplies
              ? "شغّال: المساعد بيرد على الزباين. بيوقف لحالو على أي محادثة رد فيها حدا من الفريق."
              : "استماع فقط: الرسائل بتنحفظ وبتبين هون، بس المساعد ما بيرد على حدا."}
          </p>
        </div>
        <Toggle checked={s.aiReplies} onChange={toggleAi} disabled={save.isPending || !s.channels.openai} />
      </Card>

      <Card className="flex flex-col gap-4">
        <div className="flex items-start gap-4">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-warn/12 text-warn">
            <FlaskConical size={20} />
          </span>
          <div className="flex-1">
            <h2 className="font-semibold">وضع التجربة</h2>
            <p className="mt-1 text-sm text-muted">
              إذا حطيت أرقام هون، المساعد بيرد بس على هالأرقام بواتساب (وبيسكت على إنستغرام وماسنجر). جرّبو من موبايلاتكن قبل ما تفتحوه للكل.
              فاضي = بيرد على الكل.
            </p>
          </div>
          {s.testNumbers.length > 0 && <Badge tone="warn">{s.testNumbers.length} رقم</Badge>}
        </div>
        <textarea
          value={numbers}
          onChange={(e) => setNumbers(e.target.value)}
          rows={3}
          placeholder={"218912345678\n905xxxxxxxxx"}
          className="ltr num rounded-xl border border-line bg-card-2 p-3 text-sm outline-none focus:border-primary"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => save.mutate({ testNumbers: parsedNumbers })} disabled={save.isPending}>
            حفظ الأرقام
          </Button>
          {s.testNumbers.length > 0 && (
            <Button variant="ghost" onClick={() => save.mutate({ testNumbers: [] })} disabled={save.isPending}>
              إلغاء وضع التجربة
            </Button>
          )}
          <span className="text-xs text-muted">الرقم مع رمز الدولة، بدون + ولا مسافات.</span>
        </div>
      </Card>

      <TelegramCard />
      <FollowUpCard />
      <SupervisorCard />

      <Card>
        <h2 className="mb-4 font-semibold">الربط</h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Check ok={Boolean(s.channels.whatsapp)} label="واتساب" detail={s.channels.whatsapp ? `${s.channels.whatsapp} · ${s.channels.whatsappPhoneNumberId ?? ""}` : "مفتاح الإرسال ناقص"} />
          <Check ok={s.channels.openai} label="OpenAI" detail={s.channels.openai ? `${s.model} · تفكير ${s.reasoningEffort}` : "OPENAI_API_KEY ناقص"} />
          <Check ok={s.channels.chatwoot} label="إنستغرام وماسنجر (Chatwoot)" detail={s.channels.chatwoot ? "مربوط" : "لسا ما انربط"} />
          <Check
            ok={Boolean(s.historySync && !s.historySync.error)}
            label="استيراد المحادثات القديمة"
            detail={
              !s.historySync
                ? "ما وصل شي لسا"
                : s.historySync.error
                  ? `ما انشارك: ${s.historySync.error}`
                  : `${s.historySync.progress ?? 0}% · المرحلة ${s.historySync.phase} · ${ago(s.historySync.at)}`
            }
          />
        </div>
      </Card>

      <Card>
        <h2 className="mb-4 font-semibold">قيم ثابتة (بتتغير من متغيرات Railway)</h2>
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <Info k="إيقاف المساعد بعد رد الفريق" v={`${s.humanPauseHours} ساعة`} />
          <Info k="انتظار قبل الرد (رسائل ورا بعض)" v={`${s.debounceMs / 1000} ثانية`} />
          <Info k="عدد الرسائل يلي بيشوفها المساعد" v={`آخر ${s.historyLimit}`} />
          <Info k="توقيت اللوحة" v={`UTC+${s.timezoneOffsetHours}`} />
        </dl>
      </Card>
    </div>
  );
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-card-2 p-3">
      {ok ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" /> : <CircleSlash size={18} className="mt-0.5 shrink-0 text-muted" />}
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="ltr text-start text-xs text-muted">{detail}</div>
      </div>
    </div>
  );
}

function Info({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-4 rounded-xl bg-card-2 p-3">
      <dt className="text-muted">{k}</dt>
      <dd className="num font-medium">{v}</dd>
    </div>
  );
}
