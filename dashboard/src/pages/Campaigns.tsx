import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileText, Megaphone, RefreshCw } from "lucide-react";
import { api, mediaUrl, type CampaignTemplate } from "../api";
import { NewTemplate, TemplateRow, TEMPLATE_FOCUS } from "../components/CampaignTemplates";
import { SizeOffers } from "../components/SizeOffers";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { ago } from "../format";

const QUALITY: Record<string, { tone: "ok" | "warn" | "bad" | "muted"; text: string }> = {
  GREEN: { tone: "ok", text: "ممتازة" },
  YELLOW: { tone: "warn", text: "متوسطة: في ناس عم تحظر الرقم" },
  RED: { tone: "bad", text: "سيئة: لا تبعتوا حملات" },
};

const STATUS: Record<string, { tone: "ok" | "warn" | "muted" | "info"; text: string }> = {
  running: { tone: "ok", text: "شغالة" },
  paused: { tone: "warn", text: "واقفة" },
  done: { tone: "info", text: "خلصت" },
  stopped: { tone: "muted", text: "ملغاة" },
};

// How each group is found (shown under the picker): what the customer said or did in the chat.
const SEGMENT_HELP: Record<string, string> = {
  fur_no_order: "كتبوا عن الفروة (أو الصقع) وما عملوا طلب.",
  no_order: "كتبولنا وما عملوا أي طلب. المجموعة كبيرة وفيها اللي كتب مرة وحدة بس: اختاروا آخر 30 يوم.",
  discount_no_order: "طلبوا خصم أو تخفيض أو «آخر سعر» (بكلامهم أو لما حوّلهم الذكاء الاصطناعي للفريق) وما طلبوا. مستثنى طلبات الجملة والتجار. مناسبة لعرض تنزيلات 20%.",
  size_too_big: "قالوا وزنهم فوق 105 كغ، أو سألوا عن مقاس أكبر من 62 (64…)، أو انقال لهم إنو أكبر مقاس عندنا 62، وما طلبوا. مناسبة لـ«طقم سادة فرملة وجهين» (لحد 64).",
  buyers: "انسلم طلبهم قبل (بدون اللي اشتكوا أو رجّعوا). مناسبة لعرض طقم تاني بسعر التنزيلات.",
};

export function Campaigns() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["campaigns"], queryFn: api.campaigns, refetchInterval: 30_000 });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const [segment, setSegment] = useState("fur_no_order");
  const [days, setDays] = useState(30);
  const count = useQuery({ queryKey: ["campaign-count", segment, days], queryFn: () => api.campaignCount(segment, days) });
  const [pick, setPick] = useState(""); // "name|language"
  const [photo, setPhoto] = useState("");
  const [cap, setCap] = useState(50);
  const [testTo, setTestTo] = useState("");
  const [note, setNote] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["campaigns"] });

  const templates = Array.isArray(q.data?.templates) ? q.data.templates : [];
  const templatesError = q.data && !Array.isArray(q.data.templates) ? q.data.templates.error : "";
  const chosen: CampaignTemplate | undefined = templates.find((t) => `${t.name}|${t.language}` === pick);
  const ready = chosen && chosen.status === "APPROVED" && !chosen.unsupported && (!chosen.imageHeader || photo);

  const test = useMutation({
    mutationFn: () => api.campaignTest({ template: chosen!.name, language: chosen!.language, photo: photo || undefined, to: testTo }),
    onSuccess: () => setNote("انبعتت التجربة: شوفها على الرقم. إذا ما وصلت خلال دقيقة، في مشكلة بالقالب أو الرقم."),
  });
  const create = useMutation({
    mutationFn: () => api.createCampaign({ template: chosen!.name, language: chosen!.language, segment, days, dailyCap: cap, photo: photo || undefined }),
    onSuccess: () => {
      setNote("انعملت الحملة وهي واقفة: اضغط «ابدأ» تحتها لما تكون جاهز.");
      refresh();
    },
  });
  const action = useMutation({ mutationFn: (a: { id: number; action: "start" | "pause" | "stop" }) => api.campaignAction(a.id, a.action), onSuccess: refresh });
  const removeTemplate = useMutation({
    mutationFn: api.deleteTemplate,
    onSuccess: (_result, name) => {
      setPick((current) => current.startsWith(name + "|") ? "" : current);
      return refresh();
    },
  });

  const health = q.data?.health;
  const quality = health ? QUALITY[health.quality] ?? { tone: "muted" as const, text: health.quality } : undefined;

  return (
    <div dir="rtl" className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="رسائل للزباين القدام"
        subtitle="بعد 24 ساعة من آخر رسالة للزبون، واتساب ما بيسمح إلا بقالب وافقت عليه ميتا. فيكن تعملوا القالب من هون وتتابعوا حالته. أو نزّلوا ملف أرقام لإعلان فيسبوك (أأمن على الرقم)."
      />
      <ErrorNote error={q.error ?? test.error ?? create.error ?? action.error} />

      {health && quality && (
        <Card>
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-semibold">صحة الرقم عند ميتا</h2>
            <Badge tone={quality.tone}>{quality.text}</Badge>
            {health.canSend && health.canSend !== "AVAILABLE" && <Badge tone="warn">الإرسال محدود</Badge>}
          </div>
          {health.notes.length > 0 && (
            <ul className="mt-2 list-disc ps-5 text-sm text-muted">
              {health.notes.map((n) => (
                <li key={n} className="ltr text-start">{n}</li>
              ))}
            </ul>
          )}
          {health.quality !== "GREEN" && (
            <p className="mt-2 text-sm text-warn">
              الرقم مش بأحسن حالاته: ابعتوا لعدد صغير ومهتم (مثلاً 30–50 باليوم)، وكل ما الناس حظرت أكتر بتنزل الجودة. إذا صارت حمرا، الحملات بتوقف لحالها.
            </p>
          )}
        </Card>
      )}

      <Card>
        <h2 className="mb-3 font-semibold">١. مين الزباين؟</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            المجموعة
            <select value={segment} onChange={(e) => setSegment(e.target.value)} className="mt-1 block rounded-xl border border-line bg-card-2 px-3 py-2">
              {Object.entries(q.data?.segments ?? {}).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            كتبولنا بآخر
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="mt-1 block rounded-xl border border-line bg-card-2 px-3 py-2">
              {[7, 14, 30, 60, 90, 180, 365].map((d) => (
                <option key={d} value={d}>{d} يوم</option>
              ))}
            </select>
          </label>
          <div className="text-sm text-muted">
            {count.data ? (
              <>
                <b className="text-fg">{count.data.send}</b> بتوصلهم الحملة · <b className="text-fg">{count.data.ads}</b> بملف الإعلان
              </>
            ) : (
              "…"
            )}
          </div>
          <a href={api.audienceUrl(segment, days)} className="ms-auto inline-flex items-center gap-2 rounded-xl border border-line bg-card-2 px-4 py-2 text-sm font-semibold hover:border-primary/60">
            <Download className="size-4" /> نزّل ملف الأرقام للإعلان
          </a>
        </div>
        {SEGMENT_HELP[segment] && <p className="mt-2 text-xs text-muted">{SEGMENT_HELP[segment]}</p>}
        <p className="mt-2 text-xs text-muted">
          الحملة ما بتبعت لـ: اللي عندهم طلب، القائمة السوداء، اللي طلبوا يوقفوا الرسائل، اللي كتبوا آخر 24 ساعة، اللي محوّلين للفريق، اللي اشتكوا من طلب، الأرقام من برا ليبيا، واللي وصلتهم حملة بآخر أسبوع. ملف الإعلان بيشيل بس القائمة السوداء واللي طلبوا يوقفوا.
        </p>
      </Card>

      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">٢. قوالب الرسائل</h2>
              {q.data && !templatesError && <Badge><span className="num">{templates.length}</span> قالب</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted">تابع حالة القوالب واختار القالب اللي بدك تجرّبه أو تبعته.</p>
          </div>
          <Button type="button" variant="ghost" className={TEMPLATE_FOCUS} disabled={q.isFetching} onClick={() => void q.refetch()}>
            <RefreshCw size={15} className={q.isFetching ? "motion-safe:animate-spin" : undefined} aria-hidden="true" />
            {q.isFetching ? "عم يتحدّث…" : "تحديث"}
          </Button>
        </div>
        {templatesError && <div role="alert" className="px-5 pb-4 wrap-anywhere"><ErrorNote error={templatesError} /></div>}
        {removeTemplate.error && <div role="alert" className="px-5 pb-4 wrap-anywhere"><ErrorNote error={removeTemplate.error} /></div>}
        {!templatesError && q.data && templates.length === 0 && (
          <div className="border-t border-line px-5"><Empty icon={FileText} text="ما في قوالب لسا. فيكن تعملوا أول قالب من النموذج تحت." /></div>
        )}
        {templates.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-b-2xl border-t border-line">
            {templates.map((template) => {
              const key = `${template.name}|${template.language}`;
              return (
                <TemplateRow
                  key={key}
                  template={template}
                  selected={pick === key}
                  inUse={Boolean(q.data?.campaigns.some((campaign) => campaign.template === template.name && campaign.status === "running"))}
                  deletePending={removeTemplate.isPending}
                  deleting={removeTemplate.isPending && removeTemplate.variables === template.name}
                  onSelect={() => setPick(key)}
                  onDelete={() => {
                    if (confirm(`تحذف القالب «${template.name}» من ميتا بكل لغاته؟`)) removeTemplate.mutate(template.name);
                  }}
                />
              );
            })}
          </ul>
        )}

        {chosen?.imageHeader && (
          <div className="border-t border-line px-5 py-4">
            <p className="mb-2 text-sm">اختار الصورة اللي بتطلع فوق الرسالة:</p>
            <div className="grid grid-cols-4 gap-2 md:grid-cols-8">
              {(catalog.data ?? []).map((c) => (
                <button key={c.id} onClick={() => setPhoto(c.id)} className={`rounded-xl border-2 ${photo === c.id ? "border-primary" : "border-transparent"}`} title={`${c.product ?? ""} ${c.name}`}>
                  <img src={mediaUrl(c.file)} alt={c.name} loading="lazy" className="aspect-square w-full rounded-lg object-cover" />
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>

      <NewTemplate refresh={refresh} />

      <SizeOffers templates={templates} />

      <Card>
        <h2 className="mb-3 font-semibold">٣. جرّب وابعت</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            رقمك للتجربة (مع رمز الدولة)
            <input value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="9639…" className="ltr mt-1 block rounded-xl border border-line bg-card-2 px-3 py-2" />
          </label>
          <Button variant="ghost" disabled={!ready || !testTo || test.isPending} onClick={() => test.mutate()}>
            ابعت تجربة
          </Button>
          <label className="text-sm">
            كم رسالة باليوم
            <input type="number" min={10} max={500} value={cap} onChange={(e) => setCap(Number(e.target.value))} className="num mt-1 block w-28 rounded-xl border border-line bg-card-2 px-3 py-2" />
          </label>
          <Button
            disabled={!ready || !count.data?.send || create.isPending}
            onClick={() => {
              if (confirm(`تعمل حملة «${chosen!.name}» لـ ${count.data!.send} زبون، ${cap} باليوم؟\n(بتنعمل واقفة، وبتبدأ لما تضغط «ابدأ»)`)) create.mutate();
            }}
          >
            اعمل الحملة
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted">الإرسال بوقت الدوام بس، رسالة كل 20 ثانية. ردود الزباين بتروح للمساعد وبيكمّل البيع معهم.</p>
        {note && <p className="mt-2 text-sm">{note}</p>}
      </Card>

      <Card className="p-0">
        <h2 className="px-5 py-3 font-semibold">الحملات</h2>
        {(q.data?.campaigns ?? []).length === 0 && <Empty icon={Megaphone} text="ما في حملات لسا." />}
        <ul className="divide-y divide-line">
          {(q.data?.campaigns ?? []).map((c) => {
            const total = Object.values(c.counts).reduce((a, b) => a + b, 0);
            const n = (k: string) => c.counts[k] ?? 0;
            const st = STATUS[c.status];
            return (
              <li key={c.id} className="space-y-2 px-5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold ltr">{c.template}</span>
                  <Badge tone={st.tone}>{st.text}</Badge>
                  <span className="text-sm text-muted">
                    {c.segmentLabel} · آخر {c.days} يوم · {c.dailyCap} باليوم · {ago(c.createdAt)}
                  </span>
                  <span className="ms-auto flex gap-2">
                    {(c.status === "paused") && (
                      <Button className="px-3 py-1" onClick={() => confirm("تبدأ الإرسال؟") && action.mutate({ id: c.id, action: "start" })}>ابدأ</Button>
                    )}
                    {c.status === "running" && (
                      <Button variant="ghost" className="px-3 py-1" onClick={() => action.mutate({ id: c.id, action: "pause" })}>وقّف</Button>
                    )}
                    {(c.status === "paused" || c.status === "running") && (
                      <Button variant="danger" className="px-3 py-1" onClick={() => confirm("تلغي الحملة؟ اللي ما وصلتهم ما رح توصلهم.") && action.mutate({ id: c.id, action: "stop" })}>الغيها</Button>
                    )}
                  </span>
                </div>
                {c.note && <p className="text-sm text-warn">{c.note}</p>}
                <div className="num flex flex-wrap gap-2 text-sm">
                  <Badge>بالدور {n("queued")} من {total}</Badge>
                  <Badge tone="info">انبعتت {n("sent") + n("delivered") + n("read")} (اليوم {c.sentToday})</Badge>
                  <Badge tone="ok">وصلت {n("delivered") + n("read")}</Badge>
                  <Badge tone="ok">قريت {n("read")}</Badge>
                  <Badge tone={n("failed") ? "bad" : "muted"}>فشلت {n("failed")}</Badge>
                  <Badge tone="primary">ردّوا {c.replied}</Badge>
                  <Badge tone="primary">طلبوا {c.orders}</Badge>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
