import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Megaphone } from "lucide-react";
import { api, mediaUrl, type CampaignTemplate } from "../api";
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

const TEMPLATE_STATUS: Record<string, { tone: "ok" | "warn" | "bad"; text: string }> = {
  APPROVED: { tone: "ok", text: "مقبول" },
  PENDING: { tone: "warn", text: "عم يتراجع" },
  REJECTED: { tone: "bad", text: "مرفوض" },
};

const DEFAULT_REPLIES = ["إيه ابعتلي الصور", "إيقاف العروض", ""];
const TEMPLATE_FIELD = "mt-1 block w-full rounded-xl border border-line bg-card-2 px-3 py-2";

// How each group is found (shown under the picker): what the customer said or did in the chat.
const SEGMENT_HELP: Record<string, string> = {
  fur_no_order: "كتبوا عن الفروة (أو الصقع) وما عملوا طلب.",
  no_order: "كتبولنا وما عملوا أي طلب. المجموعة كبيرة وفيها اللي كتب مرة وحدة بس: اختاروا آخر 30 يوم.",
  discount_no_order: "طلبوا خصم أو تخفيض أو «آخر سعر» (بكلامهم أو لما حوّلهم الذكاء الاصطناعي للفريق) وما طلبوا. مستثنى طلبات الجملة والتجار. مناسبة لعرض تنزيلات 20%.",
  size_too_big: "قالوا وزنهم فوق 105 كغ، أو سألوا عن مقاس أكبر من 62 (64…)، أو انقال لهم إنو أكبر مقاس عندنا 62، وما طلبوا. مناسبة لـ«طقم سادة فرملة وجهين» (لحد 64).",
  buyers: "انسلم طلبهم قبل (بدون اللي اشتكوا أو رجّعوا). مناسبة لعرض طقم تاني بسعر التنزيلات.",
};

function NewTemplate({ refresh }: { refresh: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [buttons, setButtons] = useState(DEFAULT_REPLIES);
  const [notice, setNotice] = useState("");
  const replies = buttons.map((text) => text.trim()).filter(Boolean);
  const submit = useMutation({
    mutationFn: () => api.createTemplate({ name, header, body, footer, buttons: replies }),
    onSuccess: ({ status }) => {
      setNotice(`انبعت القالب لميتا. الحالة: ${TEMPLATE_STATUS[status]?.text ?? status}.`);
      setName("");
      setHeader("");
      setBody("");
      setFooter("");
      setButtons(DEFAULT_REPLIES);
      return refresh();
    },
  });

  return (
    <Card>
      <h3 className="mb-1 font-semibold">قالب جديد</h3>
      <p className="mb-3 text-xs text-muted">القالب تسويقي وبالعربي. ميتا لازم توافق عليه قبل ما تقدر تبعته بحملة.</p>
      <div className="grid items-start gap-4 md:grid-cols-2">
        <form onSubmit={(event) => {
          event.preventDefault();
          setNotice("");
          submit.mutate();
        }}>
          <fieldset disabled={submit.isPending} className="space-y-3">
            <label className="block text-sm">
              اسم القالب (أحرف إنكليزية صغيرة، أرقام أو _ بس)
              <input dir="ltr" className={TEMPLATE_FIELD} value={name} onChange={(event) => setName(event.target.value)} placeholder="winter_offer" pattern="[a-z0-9_]+" maxLength={512} required />
            </label>
            <label className="block text-sm">
              عنوان نصّي (اختياري)
              <input className={TEMPLATE_FIELD} value={header} onChange={(event) => setHeader(event.target.value)} maxLength={60} />
            </label>
            <label className="block text-sm">
              <span className="flex justify-between gap-2"><span>نص الرسالة</span><span dir="ltr" className="text-xs text-muted">{body.length} / 1024</span></span>
              <textarea className={TEMPLATE_FIELD} value={body} onChange={(event) => setBody(event.target.value)} rows={5} maxLength={1024} aria-describedby="template-body-help" required />
            </label>
            <p id="template-body-help" className="text-xs text-muted"><bdi dir="ltr">{"{{1}}"}</bdi> بيصير اسم الزبون. إذا بدك تستخدمه، حطّه بنص الرسالة، مو بأولها أو بآخرها.</p>
            <label className="block text-sm">
              التذييل (اختياري)
              <input className={TEMPLATE_FIELD} value={footer} onChange={(event) => setFooter(event.target.value)} maxLength={60} />
            </label>
            <div className="space-y-2">
              <p className="text-sm">أزرار الرد السريع (اختيارية، لحد ٣)</p>
              {buttons.map((text, index) => (
                <input key={index} className={TEMPLATE_FIELD} aria-label={`رد سريع ${index + 1}`} placeholder={`رد سريع ${index + 1}`} maxLength={25} value={text} onChange={(event) => setButtons((current) => current.map((label, slot) => slot === index ? event.target.value : label))} />
              ))}
            </div>
            <Button type="submit" disabled={!name || !body.trim() || submit.isPending}>{submit.isPending ? "عم ينبعت…" : "ابعت القالب لميتا"}</Button>
          </fieldset>
          <ErrorNote error={submit.error} />
          {notice && <p role="status" className="mt-2 text-sm text-ok">{notice}</p>}
        </form>
        <div className="rounded-xl border border-line bg-card-2 p-4">
          <p className="mb-2 text-xs font-semibold text-muted">هيك بتطلع الرسالة عالواتساب</p>
          <div className="max-w-sm rounded-2xl rounded-ss-sm bg-emerald-100 p-3 text-sm text-emerald-950 shadow-sm">
            {header.trim() && <p className="mb-1 break-words font-semibold">{header.trim()}</p>}
            <p className="whitespace-pre-wrap break-words">{body.trim().replace(/\{\{1\}\}/g, "محمد") || "اكتب نص الرسالة لتشوفها هون…"}</p>
            {footer.trim() && <p className="mt-2 break-words text-xs text-emerald-800">{footer.trim()}</p>}
            {replies.length > 0 && (
              <ul className="mt-2 divide-y divide-emerald-200 border-t border-emerald-200 text-center font-semibold text-emerald-800">
                {replies.map((label, index) => <li key={index} className="break-words py-2">{label}</li>)}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

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

      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">٢. قوالب الرسائل</h2>
          <Button variant="ghost" disabled={q.isFetching} onClick={() => void q.refetch()}>تحديث</Button>
        </div>
        {templatesError && <p className="text-sm text-bad">ما قدرت جيب القوالب: {templatesError}</p>}
        <ErrorNote error={removeTemplate.error} />
        {!templatesError && q.data && templates.length === 0 && (
          <Empty icon={Megaphone} text="ما في قوالب لسا. فيكن تعملوا أول قالب من النموذج تحت." />
        )}
        <div className="grid gap-2 md:grid-cols-2">
          {templates.map((t) => {
            const key = `${t.name}|${t.language}`;
            const status = TEMPLATE_STATUS[t.status];
            const inUse = q.data?.campaigns.some((campaign) => campaign.template === t.name && campaign.status === "running");
            return (
              <div key={key} className={`min-w-0 rounded-xl border ${pick === key ? "border-primary bg-primary/10" : "border-line bg-card-2"}`}>
                <button type="button" onClick={() => setPick(key)} aria-pressed={pick === key} className="block w-full rounded-xl p-3 text-start">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <bdi dir="ltr" className="break-all font-semibold">{t.name}</bdi>
                    <Badge><bdi dir="ltr">{t.language}</bdi></Badge>
                    <Badge tone={status?.tone}>{status?.text ?? t.status}</Badge>
                    <Badge>{t.category === "MARKETING" ? "تسويقي" : t.category === "UTILITY" ? "خدمي" : t.category}</Badge>
                    {t.imageHeader && <Badge tone="info">فيه صورة</Badge>}
                  </div>
                  <p className="whitespace-pre-wrap break-words text-sm text-muted">{t.body}</p>
                  {t.status === "REJECTED" && t.rejected_reason && <p className="mt-1 text-xs text-bad">سبب الرفض: <bdi>{t.rejected_reason}</bdi></p>}
                  {t.unsupported && <p className="mt-1 text-xs text-bad">ما بينبعت من هون: {t.unsupported}</p>}
                </button>
                <div className="flex items-center justify-end gap-2 px-3 pb-3">
                  {inUse && <span className="text-xs text-muted">عم تستخدمه حملة شغالة</span>}
                  <Button variant="danger" className="px-3 py-1" disabled={inUse || removeTemplate.isPending} onClick={() => {
                    if (confirm(`تحذف القالب «${t.name}» من ميتا بكل لغاته؟`)) removeTemplate.mutate(t.name);
                  }}>احذف</Button>
                </div>
              </div>
            );
          })}
        </div>

        {chosen?.imageHeader && (
          <div className="mt-4">
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
