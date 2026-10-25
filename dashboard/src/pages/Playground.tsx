import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Bot, Hand, ImagePlus, RotateCcw, Send, X } from "lucide-react";
import { api, mediaUrl, type ChatTurn, type Decision } from "../api";
import { prepareImage } from "../image";
import { Button, Card, ErrorNote, PageHeader } from "../components/ui";
import { num, secs, usd } from "../format";

type Turn = ChatTurn & { meta?: Decision };

const EXAMPLES = ["السلام عليكم، بكم الثوب؟", "شو المقاسات المتوفرة؟", "كم بياخد التوصيل لطرابلس؟", "بدي احكي مع موظف"];

export function Playground() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [image, setImage] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });

  const ask = useMutation({
    mutationFn: (history: Turn[]) => api.playground(history.map(({ role, text, image }) => ({ role, text, image }))),
    onSuccess: (decision) => {
      const reply =
        decision.action === "reply"
          ? decision.text || "(صور بس)"
          : decision.messageToCustomer || (decision.action === "order" ? "(رسالة الطلب الافتراضية)" : "(رسالة التحويل الافتراضية)");
      setTurns((t) => [...t, { role: "business", text: reply, meta: decision }]);
    },
  });

  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [turns.length, ask.isPending]);

  const submit = (value: string) => {
    const v = value.trim();
    if ((!v && !image) || ask.isPending) return;
    const next: Turn[] = [...turns, { role: "customer", text: v || "[sent a photo]", image }];
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
          <Button variant="ghost" onClick={() => setTurns([])} disabled={!turns.length}>
            <RotateCcw size={16} /> محادثة جديدة
          </Button>
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
                      : t.meta?.action === "handoff"
                        ? "bg-warn/12"
                        : t.meta?.action === "order"
                          ? "bg-ok/12"
                          : "bg-primary-soft",
                  )}
                >
                  {t.image && <img src={t.image} alt="" className="mb-1 max-h-48 rounded-xl" />}
                  {t.text !== "[sent a photo]" && t.text}
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
                {t.meta && <Meta d={t.meta} />}
              </div>
            ))}
            {ask.isPending && (
              <div className="flex items-center justify-end gap-2 text-sm text-muted">
                <Bot size={16} className="animate-pulse" /> عم يفكر…
              </div>
            )}
            <div ref={bottom} />
          </div>
        </div>
        <ErrorNote error={ask.error} />
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
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="اكتب متل الزبون…"
            className="flex-1 rounded-xl border border-line bg-card-2 px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
          <Button disabled={(!text.trim() && !image) || ask.isPending} aria-label="إرسال">
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
