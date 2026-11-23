import { useEffect, useId, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CheckCheck, ChevronDown, Loader2, MessageCircle, Plus, Reply, Send, Trash2, X } from "lucide-react";
import { api, type CampaignTemplate } from "../api";
import { Badge, Button, Card, ErrorNote } from "./ui";

const STATUS: Record<string, { tone: "ok" | "warn" | "bad"; text: string }> = {
  APPROVED: { tone: "ok", text: "مقبول" },
  PENDING: { tone: "warn", text: "بالمراجعة" },
  REJECTED: { tone: "bad", text: "مرفوض" },
};
export const TEMPLATE_FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const FIELD = "block w-full min-w-0 rounded-xl border bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary focus:ring-1 focus:ring-primary";
const VARIABLE = "{{1}}";
const DEFAULT_REPLIES = [{ id: 0, text: "إيه ابعتلي الصور" }, { id: 1, text: "إيقاف العروض" }];

function Counter({ value, max }: { value: string; max: number }) {
  return <span dir="ltr" className={`num shrink-0 font-mono text-xs ${value.length > max ? "font-semibold text-bad" : "text-muted"}`}>{value.length} / {max}</span>;
}

function TemplatePreview({ header, body, footer, replies }: { header: string; body: string; footer: string; replies: string[] }) {
  return (
    <aside aria-labelledby="template-preview-heading" className="min-w-0 lg:sticky lg:top-4">
      <Card className="p-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary-soft text-primary"><MessageCircle size={18} aria-hidden="true" /></span>
          <div>
            <h3 id="template-preview-heading" className="text-sm font-semibold">معاينة واتساب</h3>
            <p className="text-xs text-muted">هيك رح يشوف الزبون رسالتك</p>
          </div>
          <span className="ms-auto"><Badge tone="primary">مباشرة</Badge></span>
        </div>
        <div className="max-h-96 min-h-64 overflow-y-auto rounded-b-2xl border-t border-line bg-[#eee7dd] p-4"
          style={{ backgroundImage: "radial-gradient(circle at 4px 4px, #b5a38f55 1px, transparent 1.5px), radial-gradient(circle at 12px 12px, #b5a38f33 1px, transparent 1.5px)", backgroundSize: "16px 16px" }}>
          <div className="mx-auto mb-4 w-fit rounded-lg bg-white/80 px-2.5 py-1 text-xs font-medium text-slate-600 shadow-xs">اليوم</div>
          <div className="ms-1 max-w-sm">
            <div className="relative rounded-xl rounded-ss-none bg-[#dcf8c6] px-3 py-2.5 text-sm text-slate-900 shadow-sm before:absolute before:-start-2 before:top-0 before:size-2 before:bg-[#dcf8c6] before:[clip-path:polygon(0_0,100%_0,0_100%)] before:content-['']">
              {header && <p className="mb-1 font-semibold wrap-anywhere">{header}</p>}
              <p className={`whitespace-pre-wrap wrap-anywhere ${body ? "" : "text-slate-600"}`}>{body.split(VARIABLE).join("محمد") || "اكتب نص الرسالة لتشوفها هون…"}</p>
              {footer && <p className="mt-2 text-xs wrap-anywhere text-slate-600">{footer}</p>}
              <div dir="ltr" className="mt-1 flex items-center gap-1 text-[11px] text-slate-600">
                <time dateTime="10:42">10:42</time><CheckCheck size={14} className="text-sky-700" aria-hidden="true" />
              </div>
            </div>
            {replies.length > 0 && (
              <ul className="mt-2 space-y-1.5">
                {replies.map((label, index) => (
                  <li key={index} className="flex items-center justify-center gap-2 rounded-full bg-white px-3 py-1.5 text-center text-sm font-semibold text-emerald-800 shadow-xs">
                    <Reply size={15} className="shrink-0 -scale-x-100" aria-hidden="true" /><bdi className="wrap-anywhere">{label}</bdi>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </Card>
    </aside>
  );
}

export function NewTemplate({ refresh }: { refresh: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [header, setHeader] = useState("");
  const [body, setBody] = useState("");
  const [footer, setFooter] = useState("");
  const [buttons, setButtons] = useState(DEFAULT_REPLIES);
  const [notice, setNotice] = useState("");
  const nextReplyId = useRef(DEFAULT_REPLIES.length);
  const bodyInput = useRef<HTMLTextAreaElement>(null);
  const replies = buttons.map(({ text }) => text.trim()).filter(Boolean);
  const nameError = !name ? "اكتب اسم للقالب." : /[^a-z0-9_]/.test(name) ? "الاسم بيقبل أحرف إنكليزية صغيرة وأرقام وشرطة سفلية (_) بس." : "";
  const showNameError = Boolean((name || nameTouched) && nameError);
  const bodyError = body.length > 1024 ? "النص أطول من ١٠٢٤ حرف."
    : /[{}]/.test(body.split(VARIABLE).join("")) ? "المتغيّر الوحيد المسموح هو اسم الزبون."
    : body.trim().startsWith(VARIABLE) || body.trim().endsWith(VARIABLE) ? "حط اسم الزبون بنص الرسالة، مو بأولها أو بآخرها."
    : "";
  const variableError = (text: string) => /[{}]/.test(text) ? "اسم الزبون مسموح بنص الرسالة بس." : "";
  const footerError = footer.length > 60 ? "التذييل أطول من ٦٠ حرف." : variableError(footer);
  const invalid = Boolean(nameError || !body.trim() || bodyError || variableError(header) || footerError || replies.some(variableError));

  const submit = useMutation({
    mutationFn: () => api.createTemplate({ name, header, body, footer, buttons: replies }),
    onSuccess: ({ status }) => {
      setNotice(`انبعت القالب لميتا. الحالة: ${STATUS[status]?.text ?? status}.`);
      setName("");
      setNameTouched(false);
      setHeader("");
      setBody("");
      setFooter("");
      setButtons(DEFAULT_REPLIES);
      return refresh();
    },
  });

  function insertCustomerName() {
    const input = bodyInput.current;
    if (!input) return;
    const { selectionStart, selectionEnd } = input;
    setBody(body.slice(0, selectionStart) + VARIABLE + body.slice(selectionEnd));
    input.focus();
    requestAnimationFrame(() => input.setSelectionRange(selectionStart + VARIABLE.length, selectionStart + VARIABLE.length));
  }

  return (
    <Card>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="new-template-heading" className="font-semibold">قالب جديد</h3>
          <p className="mt-1 text-sm text-muted">ميتا لازم توافق عالقالب قبل ما تقدر تستخدمه بحملة.</p>
        </div>
        <Badge>عربي · تسويقي</Badge>
      </div>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <form aria-labelledby="new-template-heading" className="min-w-0" onSubmit={(event) => {
          event.preventDefault();
          if (invalid || submit.isPending) return;
          setNotice("");
          submit.mutate();
        }}>
          <fieldset disabled={submit.isPending} className="min-w-0 space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="template-name" className="block text-sm font-medium">اسم القالب</label>
              <input id="template-name" dir="ltr" className={`${FIELD} font-mono ${showNameError ? "border-bad" : "border-line"}`} value={name} onChange={(event) => setName(event.target.value)} onBlur={() => setNameTouched(true)} placeholder="winter_offer" maxLength={512} autoComplete="off" spellCheck={false} required aria-invalid={showNameError} aria-describedby={`template-name-help${showNameError ? " template-name-error" : ""}`} />
              <p id="template-name-help" className="text-xs text-muted">أحرف إنكليزية صغيرة، أرقام أو شرطة سفلية (_) بس.</p>
              {showNameError && <p id="template-name-error" className="text-xs text-bad">{nameError}</p>}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="template-header" className="block text-sm font-medium">عنوان نصّي <span className="font-normal text-muted">(اختياري)</span></label>
              <input id="template-header" className={`${FIELD} ${variableError(header) ? "border-bad" : "border-line"}`} value={header} onChange={(event) => setHeader(event.target.value)} placeholder="مثلاً: عروض الشتوية" maxLength={60} aria-invalid={Boolean(variableError(header))} aria-describedby={variableError(header) ? "template-header-error" : undefined} />
              {variableError(header) && <p id="template-header-error" className="text-xs text-bad">{variableError(header)}</p>}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="template-body" className="text-sm font-medium">نص الرسالة</label>
                <Counter value={body} max={1024} />
              </div>
              <textarea id="template-body" ref={bodyInput} className={`${FIELD} min-h-28 resize-y ${bodyError ? "border-bad" : "border-line"}`} value={body} onChange={(event) => setBody(event.target.value)} rows={5} placeholder="مثلاً: مرحبا! جهزنالك عرض عالشتوية…" aria-invalid={Boolean(bodyError)} aria-describedby={`template-body-help${bodyError ? " template-body-error" : ""}`} required />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <button type="button" className={`${TEMPLATE_FOCUS} inline-flex items-center gap-1 rounded-full bg-primary-soft px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/20`} onClick={insertCustomerName}><Plus size={14} aria-hidden="true" /> اسم الزبون</button>
                <p id="template-body-help" className="text-xs text-muted"><bdi dir="ltr">{VARIABLE}</bdi> بيتبدّل باسم الزبون. حطّه بنص الرسالة.</p>
              </div>
              {bodyError && <p id="template-body-error" className="text-xs text-bad">{bodyError}</p>}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="template-footer" className="text-sm font-medium">التذييل <span className="font-normal text-muted">(اختياري)</span></label>
                <Counter value={footer} max={60} />
              </div>
              <input id="template-footer" className={`${FIELD} ${footerError ? "border-bad" : "border-line"}`} value={footer} onChange={(event) => setFooter(event.target.value)} placeholder="مثلاً: العرض لنهاية الأسبوع" aria-invalid={Boolean(footerError)} aria-describedby={`template-footer-help${footerError ? " template-footer-error" : ""}`} />
              <p id="template-footer-help" className="text-xs text-muted">بيطلع بخط صغير تحت نص الرسالة.</p>
              {footerError && <p id="template-footer-error" className="text-xs text-bad">{footerError}</p>}
            </div>
            <div role="group" aria-labelledby="template-replies-heading" className="space-y-2 border-t border-line pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p id="template-replies-heading" className="text-sm font-medium">أزرار الرد السريع</p>
                  <p className="text-xs text-muted">اختيارية، فيك تضيف لحد ٣ أزرار.</p>
                </div>
                <Button type="button" variant="ghost" className={`${TEMPLATE_FOCUS} px-3 py-1.5`} disabled={buttons.length >= 3} onClick={() => {
                  const id = nextReplyId.current++;
                  setButtons((current) => [...current, { id, text: "" }]);
                  requestAnimationFrame(() => document.getElementById(`template-reply-${id}`)?.focus());
                }}><Plus size={15} aria-hidden="true" /> ضيف زر</Button>
              </div>
              {buttons.map(({ id, text }, index) => {
                const error = variableError(text);
                return (
                  <div key={id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor={`template-reply-${id}`} className="text-xs text-muted">الرد {index + 1}</label>
                      <Counter value={text} max={25} />
                    </div>
                    <div className="flex items-center gap-2">
                      <input id={`template-reply-${id}`} className={`${FIELD} ${error ? "border-bad" : "border-line"}`} placeholder="نص الزر" maxLength={25} value={text} aria-invalid={Boolean(error)} aria-describedby={error ? `template-reply-${id}-error` : undefined} onChange={(event) => setButtons((current) => current.map((button) => button.id === id ? { ...button, text: event.target.value } : button))} />
                      <button type="button" className={`${TEMPLATE_FOCUS} grid size-9 shrink-0 place-items-center rounded-xl text-muted hover:bg-bad/10 hover:text-bad`} aria-label={`شيل الرد ${index + 1}`} onClick={() => setButtons((current) => current.filter((button) => button.id !== id))}><X size={16} aria-hidden="true" /></button>
                    </div>
                    {error && <p id={`template-reply-${id}-error`} className="text-xs text-bad">{error}</p>}
                  </div>
                );
              })}
            </div>
            <div className="border-t border-line pt-4">
              <Button type="submit" className={`${TEMPLATE_FOCUS} w-full sm:w-auto`} disabled={invalid || submit.isPending}>
                {submit.isPending ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
                {submit.isPending ? "عم نقدّم القالب…" : "قدّم لميتا"}
              </Button>
            </div>
          </fieldset>
          {submit.error && <div role="alert" className="mt-3 wrap-anywhere"><ErrorNote error={submit.error} /></div>}
          {notice && <p role="status" className="mt-3 flex items-start gap-2 rounded-xl border border-ok/30 bg-ok/10 px-3 py-2 text-sm text-ok"><CheckCircle2 size={16} className="mt-0.5 shrink-0" aria-hidden="true" />{notice}</p>}
        </form>
        <TemplatePreview header={header.trim()} body={body.trim()} footer={footer.trim()} replies={replies} />
      </div>
    </Card>
  );
}

export function TemplateRow({ template, selected, inUse, deleting, deletePending, onSelect, onDelete }: {
  template: CampaignTemplate;
  selected: boolean;
  inUse: boolean;
  deleting: boolean;
  deletePending: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const body = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const node = body.current;
    if (!node || expanded) return;
    const measure = () => setClipped(node.scrollHeight > node.clientHeight);
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded, template.body]);
  const status = STATUS[template.status];
  const category = template.category === "MARKETING" ? "تسويقي" : template.category === "UTILITY" ? "خدمي" : template.category === "AUTHENTICATION" ? "مصادقة" : template.category;

  return (
    <li className={`px-5 py-4 ${selected ? "bg-primary-soft" : ""}`}>
      <div className="grid gap-x-5 gap-y-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="min-w-0 text-sm font-semibold wrap-anywhere"><bdi dir="ltr" className="font-mono">{template.name}</bdi></h3>
            <Badge tone={status?.tone}><bdi>{status?.text ?? template.status}</bdi></Badge>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge><bdi dir="ltr">{template.language}</bdi></Badge>
            <Badge>{category}</Badge>
            {template.imageHeader && <Badge tone="info">فيه صورة</Badge>}
          </div>
          {template.body && (
            <div>
              <p id={bodyId} ref={body} dir="auto" className={`text-sm whitespace-pre-wrap wrap-anywhere text-muted ${expanded ? "" : "line-clamp-2"}`}>{template.body}</p>
              {(clipped || expanded) && <button type="button" aria-expanded={expanded} aria-controls={bodyId} className={`${TEMPLATE_FOCUS} mt-1 inline-flex items-center gap-1 rounded text-xs font-medium text-primary hover:underline`} onClick={() => setExpanded(!expanded)}>{expanded ? "اختصر النص" : "شوف النص كامل"}<ChevronDown size={13} className={expanded ? "rotate-180" : undefined} aria-hidden="true" /></button>}
            </div>
          )}
          {template.status === "REJECTED" && template.rejected_reason && <p className="text-xs wrap-anywhere text-bad">سبب الرفض: <bdi>{template.rejected_reason}</bdi></p>}
          {template.unsupported && <p className="text-xs wrap-anywhere text-bad">ما بينبعت من هون: {template.unsupported}</p>}
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2 sm:justify-end">
            <Button type="button" variant="ghost" className={`${TEMPLATE_FOCUS} px-3 py-1.5 ${selected ? "border-primary/60 text-primary" : ""}`} aria-pressed={selected} onClick={onSelect}>
              {selected && <CheckCircle2 size={15} aria-hidden="true" />}{selected ? "مختار" : "اختار القالب"}
            </Button>
            <button type="button" className={`${TEMPLATE_FOCUS} grid size-9 place-items-center rounded-xl text-bad hover:bg-bad/10 disabled:cursor-not-allowed disabled:opacity-40`} aria-label={`حذف القالب ${template.name}`} title={inUse ? "عم تستخدمه حملة شغالة" : "حذف"} disabled={inUse || deletePending} onClick={onDelete}>
              {deleting ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
            </button>
          </div>
          {inUse && <p className="text-xs text-muted sm:text-end">عم تستخدمه حملة شغالة</p>}
        </div>
      </div>
    </li>
  );
}
