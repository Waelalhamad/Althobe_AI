import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Bot, Clock, Hand, ImagePlus, Mic, RotateCcw, Send, Square, X } from "lucide-react";
import { api, mediaUrl, type ChatTurn, type Decision } from "../api";
import { prepareImage } from "../image";
import { Button, Card, ErrorNote, PageHeader } from "../components/ui";
import { num, secs, usd } from "../format";

// skipped: the follow-up test decided not to write (shown as a note, not sent to the AI).
// audio: a test voice note, for playing it back here (the AI gets its text, like on WhatsApp).
type Turn = ChatTurn & { meta?: Decision; followUp?: boolean; skipped?: boolean; audio?: string };

const MAX_VOICE_SECONDS = 120;

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const EXAMPLES = [
  "مرحبًا! هل يمكنني الحصول على مزيد من المعلومات حول هذا؟",
  "مرحبا",
  "بكم؟",
  "المقاس غلط ونبي نبدلو",
];

const CUSTOMER_TYPES = [
  { id: "new", label: "زبون جديد" },
  { id: "returning", label: "زبون كتبلنا قبل" },
  { id: "order", label: "عندو طلب" },
] as const;

export function Playground() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [image, setImage] = useState<string>();
  const [customerType, setCustomerType] = useState<(typeof CUSTOMER_TYPES)[number]["id"]>("new");
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });

  const ask = useMutation({
    mutationFn: (history: Turn[]) => api.playground(history.map(({ role, text, image }) => ({ role, text, image })), customerType),
    onSuccess: (decision) => {
      const reply =
        decision.action === "reply"
          ? decision.text || "(صور بس)"
          : decision.action === "none"
            ? `(ما بيرد، ما في شي يجاوب عليه${decision.reason ? `: ${decision.reason}` : ""})`
          : decision.action === "handoff" && decision.silent
            ? "(بدون رد للزبون، الفريق بيرد)"
            : decision.messageToCustomer || (decision.action === "order" ? "(رسالة الطلب الافتراضية)" : "(رسالة التحويل الافتراضية)");
      setTurns((t) => [...t, { role: "business", text: reply, meta: decision }]);
    },
  });

  // What the automatic follow-up would send if the customer went quiet now.
  const followUp = useMutation({
    mutationFn: (history: Turn[]) =>
      api.playgroundFollowUp(
        history.filter((t) => !t.skipped).map(({ role, text, image }) => ({ role, text, image })),
        customerType,
      ),
    onSuccess: ({ text, usage }) =>
      setTurns((t) => [
        ...t,
        text
          ? { role: "business", text, followUp: true, meta: { action: "reply", text, photos: [], usage } }
          : { role: "business", text: "ما رح يبعت متابعة هون (ما بتناسب المحادثة)", skipped: true },
      ]),
  });
  // A voice note: record in the browser, turn it into text on the server, then send it like a message.
  const voice = useMutation({
    mutationFn: async (blob: Blob) => ({ ...(await api.playgroundVoice(await blobAsDataUrl(blob))), audio: URL.createObjectURL(blob) }),
    onSuccess: ({ text: heard, audio }) => {
      const next: Turn[] = [...turns.filter((t) => !t.skipped), { role: "customer", text: heard, audio }];
      setTurns(next);
      ask.mutate(next);
    },
  });
  const [recording, setRecording] = useState<{ recorder: MediaRecorder; seconds: number }>();
  const [micError, setMicError] = useState<string>();
  const busy = ask.isPending || followUp.isPending || voice.isPending;

  const startRecording = async () => {
    setMicError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(undefined);
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size > 0) voice.mutate(blob);
      };
      recorder.start();
      setRecording({ recorder, seconds: 0 });
    } catch {
      setMicError("ما قدرنا نفتح المايك. اسمح للمتصفح يستعمل المايك وجرب مرة تانية.");
    }
  };

  // The recording timer; stops by itself after MAX_VOICE_SECONDS.
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      setRecording((r) => {
        if (!r) return r;
        if (r.seconds + 1 >= MAX_VOICE_SECONDS && r.recorder.state === "recording") r.recorder.stop();
        return { ...r, seconds: r.seconds + 1 };
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [recording?.recorder]);

  // Braces: the effect must not return what scrollIntoView returns (React would call it as a cleanup).
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [turns.length, busy]);

  const submit = (value: string) => {
    const v = value.trim();
    if ((!v && !image) || busy) return;
    const next: Turn[] = [...turns.filter((t) => !t.skipped), { role: "customer", text: v || "[sent a photo]", image }];
    setTurns(next);
    setText("");
    setImage(undefined);
    ask.mutate(next);
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col">
      <PageHeader
        title="جرّب المساعد"
        subtitle="احكي معو متل زبون، وفيك تبعتلو صورة. بيستعمل نفس المعلومات وصور المنتجات، بس ما بينبعت شي لحدا وما بينحسب بالأرقام."
        actions={
          <>
            <select
              value={customerType}
              onChange={(e) => setCustomerType(e.target.value as typeof customerType)}
              className="rounded-xl border border-line bg-card-2 px-3 py-1.5 text-sm outline-none focus:border-primary"
              aria-label="نوع الزبون"
            >
              {CUSTOMER_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
            <Button
              variant="ghost"
              onClick={() => followUp.mutate(turns)}
              disabled={busy || turns[turns.length - 1]?.role !== "business" || Boolean(turns[turns.length - 1]?.skipped)}
              title="شو رح يبعت إذا الزبون سكت بعد آخر رد"
            >
              <Clock size={16} /> جرّب رسالة المتابعة
            </Button>
            <Button variant="ghost" onClick={() => setTurns([])} disabled={!turns.length}>
              <RotateCcw size={16} /> محادثة جديدة
            </Button>
          </>
        }
      />
      <Card className="flex min-h-[50vh] flex-1 flex-col p-0">
        <div className="flex-1 overflow-y-auto p-4">
          {turns.length === 0 && (
            <div className="flex flex-wrap justify-center gap-2 py-10">
              {EXAMPLES.map((e) => (
                <button key={e} onClick={() => submit(e)} className="rounded-full border border-line bg-card-2 px-4 py-2 text-sm hover:border-primary">
                  {e}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-col gap-3">
            {turns.map((t, i) => (
              <div key={i} className={clsx("flex flex-col", t.role === "business" ? "items-end" : "items-start")}>
                <div
                  className={clsx(
                    "max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm",
                    t.role === "customer"
                      ? "bg-card-2"
                      : t.skipped
                        ? "border border-dashed border-line text-muted"
                      : t.meta?.action === "handoff"
                        ? "bg-warn/12"
                        : t.meta?.action === "order"
                          ? "bg-ok/12"
                          : "bg-primary-soft",
                  )}
                >
                  {t.image && <img src={t.image} alt="" className="mb-1 max-h-48 rounded-xl" />}
                  {t.audio ? (
                    <>
                      <audio src={t.audio} controls className="h-9 max-w-full" />
                      <span className="mt-1 block text-xs text-muted">المساعد سمعها: {t.text.replace(/^\[voice note\]\s*/, "")}</span>
                    </>
                  ) : (
                    t.text !== "[sent a photo]" && t.text
                  )}
                </div>
                {t.meta?.action === "reply" && t.meta.photos.length > 0 && (
                  <div className="mt-1 flex flex-wrap justify-end gap-1">
                    {t.meta.photos.map((id) => {
                      const p = catalog.data?.find((c) => c.id === id);
                      return p ? (
                        <img key={id} src={mediaUrl(p.file)} alt={p.name} title={p.name} className="size-24 rounded-xl object-cover" />
                      ) : null;
                    })}
                  </div>
                )}
                {t.followUp && <span className="mt-1 text-[11px] text-info">رسالة متابعة تلقائية</span>}
                {t.meta && <Meta d={t.meta} />}
              </div>
            ))}
            {busy && (
              <div className="flex items-center justify-end gap-2 text-sm text-muted">
                <Bot size={16} className="animate-pulse" /> عم يفكر…
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>
        <ErrorNote error={ask.error ?? followUp.error ?? voice.error} />
        {micError && <p className="px-4 pb-2 text-sm text-bad">{micError}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit(text);
          }}
          className="flex flex-wrap items-center gap-2 border-t border-line p-3"
        >
          {image && (
            <div className="relative">
              <img src={image} alt="" className="size-12 rounded-lg object-cover" />
              <button type="button" onClick={() => setImage(undefined)} className="absolute -end-2 -top-2 rounded-full bg-card p-0.5" aria-label="شيل الصورة">
                <X size={14} />
              </button>
            </div>
          )}
          <button type="button" onClick={() => fileInput.current?.click()} className="text-muted hover:text-primary" aria-label="أرفق صورة">
            <ImagePlus size={20} />
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) setImage((await prepareImage(file, 1024)).dataUrl);
            }}
          />
          <button
            type="button"
            onClick={() => (recording ? recording.recorder.stop() : startRecording())}
            disabled={busy && !recording}
            className={clsx("flex items-center gap-1 hover:text-primary", recording ? "text-bad" : "text-muted")}
            aria-label={recording ? "وقّف التسجيل وابعت" : "سجّل رسالة صوتية"}
            title={recording ? "وقّف التسجيل وابعت" : "سجّل رسالة صوتية متل الزبون"}
          >
            {recording ? <Square size={18} className="animate-pulse" /> : <Mic size={20} />}
            {recording && <span className="num text-xs">{recording.seconds}s</span>}
          </button>
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="اكتب متل الزبون…"
            className="flex-1 rounded-xl border border-line bg-card-2 px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
          <Button disabled={(!text.trim() && !image) || busy} aria-label="إرسال">
            <Send size={16} />
          </Button>
        </form>
      </Card>
    </div>
  );
}

function Meta({ d }: { d: Decision }) {
  const u = d.usage;
  const cost = u ? ((u.promptTokens - u.cachedTokens) * 0.25 + u.cachedTokens * 0.025 + u.completionTokens * 2) / 1e6 : 0;
  return (
    <div className="mt-1 flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-[11px] text-muted">
      {d.action === "order" && (
        <span className="flex flex-wrap items-center gap-1 text-ok">
          طلب (ما بينحفظ بالتجربة): {d.order.name} · <span className="ltr">{d.order.phone}</span> · {d.order.city} {d.order.address} ·{" "}
          {d.order.items.map((i) => [`${i.quantity}×`, i.product, i.color, i.size].filter(Boolean).join(" ")).join("، ")} · {d.order.total}
          {d.order.notes && ` · ${d.order.notes}`}
        </span>
      )}
      {d.action === "reply" && d.confidence !== undefined && <span className="num">ثقة {d.confidence}/100</span>}
      {d.action === "handoff" && (
        <span className="flex items-center gap-1 text-warn">
          <Hand size={12} /> تحويل للفريق: <span className="ltr">{d.reason}</span>
        </span>
      )}
      {u && (
        <span className="num">
          {secs(u.latencyMs)} · {num(u.promptTokens)}+{num(u.completionTokens)} توكن · {usd(cost)}
        </span>
      )}
    </div>
  );
}
