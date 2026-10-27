import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRight, Bot, History, ImagePlus, ShoppingBag, Inbox as InboxIcon, Pause, Play, Search, Send, User, UserRound, X } from "lucide-react";
import { api, CHANNEL_LABEL, channelOf, mediaUrl, type ConversationFilter, type ConversationSummary, type Message } from "../api";
import { Badge, Button, Empty, ErrorNote } from "../components/ui";
import { ago, country, pauseLabel, phone, time, until } from "../format";
import { prepareImage } from "../image";
import { OrderForm } from "../components/OrderForm";
import type { OrderInput } from "../api";

const FILTERS: { id: ConversationFilter; label: string }[] = [
  { id: "all", label: "الكل" },
  { id: "unanswered", label: "بلا رد" },
  { id: "ai", label: "مع المساعد" },
  { id: "paused", label: "مع الفريق" },
  { id: "handoff", label: "محوّلة" },
];

export function Inbox() {
  const params = useParams<{ customer?: string }>();
  const selected = params.customer;
  const [filter, setFilter] = useState<ConversationFilter>("all");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);

  const list = useQuery({
    queryKey: ["conversations", filter, search],
    queryFn: () => api.conversations(filter, search),
    refetchInterval: 8_000,
  });

  return (
    <div className="-m-4 flex h-[calc(100%+2rem)] sm:-m-6 sm:h-[calc(100%+3rem)] lg:-m-8 lg:h-[calc(100%+4rem)]">
      <section className={clsx("flex w-full flex-col border-e border-line md:w-96 md:shrink-0", selected && "hidden md:flex")}>
        <div className="flex flex-col gap-3 border-b border-line p-4">
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-xl font-bold">المحادثات</h1>
            <AnswerWaiting />
          </div>
          <label className="flex items-center gap-2 rounded-xl border border-line bg-card-2 px-3 py-2 focus-within:border-primary">
            <Search size={16} className="text-muted" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="ابحث برقم أو كلمة…"
              className="w-full bg-transparent text-sm outline-none"
            />
          </label>
          <div className="flex gap-1 overflow-x-auto">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={clsx(
                  "rounded-lg px-3 py-1 text-xs whitespace-nowrap",
                  filter === f.id ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ErrorNote error={list.error} />
          {list.data?.length === 0 && <Empty icon={InboxIcon} text="ما في محادثات هون." />}
          {list.data?.map((c) => <Row key={c.customer} c={c} active={c.customer === selected} />)}
        </div>
      </section>

      <section className={clsx("min-w-0 flex-1 flex-col", selected ? "flex" : "hidden md:flex")}>
        {selected ? (
          <Thread customer={selected} />
        ) : (
          <div className="grid flex-1 place-items-center">
            <Empty icon={InboxIcon} text="اختار محادثة من القائمة." />
          </div>
        )}
      </section>
    </div>
  );
}


function Row({ c, active }: { c: ConversationSummary; active: boolean }) {
  return (
    <Link
      href={`/inbox/${c.customer}`}
      className={clsx(
        "flex flex-col gap-1 border-b border-line px-4 py-3 transition",
        active ? "bg-primary-soft" : "hover:bg-card-2",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          {c.name && <span className="me-1">{c.name}</span>}
          <span className={clsx("ltr num", c.name && "text-xs font-normal text-muted")}>{phone(c.customer)}</span>
        </span>
        <span className="text-xs text-muted">{ago(c.lastAt)}</span>
      </div>
      <div className="flex items-center gap-2">
        <SourceIcon source={c.lastSource} />
        <span className="line-clamp-1 flex-1 text-sm text-muted">{c.lastText}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {channelOf(c.customer) !== "whatsapp" && <Badge tone="info">{CHANNEL_LABEL[channelOf(c.customer)]}</Badge>}
        {country(c.customer) && <Badge>{country(c.customer)}</Badge>}
        {c.pausedUntil ? <Badge tone="warn">{pauseLabel(c.pauseReason)}</Badge> : <Badge tone="primary">المساعد</Badge>}
        {c.lastSource === "customer" && <Badge tone="info">بلا رد</Badge>}
      </div>
    </Link>
  );
}

function SourceIcon({ source }: { source: string }) {
  if (source === "ai") return <Bot size={14} className="shrink-0 text-primary" />;
  if (source === "staff") return <UserRound size={14} className="shrink-0 text-info" />;
  return <User size={14} className="shrink-0 text-muted" />;
}

const MAX_PHOTOS = 10;

function Thread({ customer }: { customer: string }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["conversation", customer], queryFn: () => api.conversation(customer), refetchInterval: 5_000 });
  const [text, setText] = useState("");
  // Photos to send with the reply (shrunk to JPEG in the browser), one message each; the text is the first one's caption.
  const [photos, setPhotos] = useState<string[]>([]);
  const [sending, setSending] = useState<{ done: number; total: number }>();
  const [photoError, setPhotoError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const d = detail.data;
  const count = d?.messages.length ?? 0;

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [count, customer]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["conversation", customer] });
    void queryClient.invalidateQueries({ queryKey: ["conversations"] });
  };
  const pause = useMutation({ mutationFn: () => api.pause(customer), onSuccess: refresh });
  // "Record order": the AI fills the form from the chat, the team checks and saves.
  const [orderDraft, setOrderDraft] = useState<OrderInput>();
  const draft = useMutation({ mutationFn: () => api.orderDraft(customer), onSuccess: setOrderDraft });
  const resume = useMutation({ mutationFn: () => api.resume(customer), onSuccess: refresh });
  const send = useMutation({
    mutationFn: async () => {
      if (!photos.length) {
        await api.send(customer, text.trim());
        setText("");
        return;
      }
      // One by one, in order. A photo that went out leaves the list (and the caption with the first), so a
      // failure halfway can be retried with what's left.
      setSending({ done: 0, total: photos.length });
      for (const [n, photo] of photos.entries()) {
        await api.send(customer, n === 0 ? text.trim() : "", photo);
        if (n === 0) setText("");
        setPhotos((p) => p.slice(1));
        setSending({ done: n + 1, total: photos.length });
      }
    },
    onSettled: () => {
      setSending(undefined);
      refresh();
    },
  });

  const windowOpen = d?.windowOpenUntil ? d.windowOpenUntil > Date.now() : false;
  const canSend = Boolean(text.trim() || photos.length) && !send.isPending && windowOpen;

  async function pickPhotos(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return;
    setPhotoError(undefined);
    const room = MAX_PHOTOS - photos.length;
    if (images.length > room) setPhotoError(`فيك تبعت ${MAX_PHOTOS} صور بالمرة.`);
    for (const file of images.slice(0, Math.max(0, room))) {
      try {
        const { dataUrl } = await prepareImage(file);
        setPhotos((p) => (p.length < MAX_PHOTOS ? [...p, dataUrl] : p));
      } catch {
        setPhotoError("ما قدرت افتح وحدة من الصور، جرّب صور JPG أو PNG.");
      }
    }
  }
  const handoffs = d?.aiCalls.filter((c) => !["reply", "none", "photo", "draft"].includes(c.action)) ?? [];

  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <button onClick={() => navigate("/inbox")} className="text-muted md:hidden" aria-label="رجوع">
          <ArrowRight />
        </button>
        <div className="flex-1">
          <div className="text-start font-semibold">
            {d?.name && <span className="me-2">{d.name}</span>}
            <span className="ltr num">{phone(customer)}</span>
            {d?.username && <span className="ms-2 text-xs text-muted">@{d.username}</span>}
            {channelOf(customer) !== "whatsapp" && <span className="ltr ms-2 select-all text-xs font-normal text-muted" title="للصقها بوضع التجربة">{customer}</span>}
          </div>
          <div className="text-xs text-muted">
            {channelOf(customer) === "whatsapp" ? country(customer) : CHANNEL_LABEL[channelOf(customer)]}
            {d && ` · ${d.messages.length} رسالة`}
            {d?.windowOpenUntil && (windowOpen ? ` · نافذة الرد مفتوحة ${until(d.windowOpenUntil)}` : " · نافذة الـ 24 ساعة مسكّرة")}
          </div>
        </div>
        <Button variant="ghost" onClick={() => draft.mutate()} disabled={draft.isPending} title="المساعد بيعبّي الطلب من المحادثة، وانت بتتأكد وبتحفظ">
          <ShoppingBag size={16} /> {draft.isPending ? "عم يقرا المحادثة…" : "سجّل طلب"}
        </Button>
        {d?.pausedUntil ? (
          <>
            <Badge tone="warn">
              {pauseLabel(d.pauseReason)} · باقي {until(d.pausedUntil)}
            </Badge>
            <Button variant="ghost" onClick={() => resume.mutate()} disabled={resume.isPending}>
              <Play size={16} /> رجّع المساعد
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => pause.mutate()} disabled={pause.isPending}>
            <Pause size={16} /> استلم المحادثة
          </Button>
        )}
      </header>

      {draft.error && (
        <div className="border-b border-line px-4 py-2">
          <ErrorNote error={draft.error} />
        </div>
      )}
      {orderDraft && (
        <OrderForm
          initial={orderDraft}
          customer={customer}
          note="المساعد عبّى الطلب من المحادثة. تأكد من كل شي (خاصة الرقم والعنوان) قبل ما تحفظ."
          onClose={() => setOrderDraft(undefined)}
        />
      )}
      {handoffs[0] && (
        <div className="border-b border-line bg-warn/5 px-4 py-2 text-xs text-warn">
          آخر تحويل ({ago(handoffs[0].at)}): <span className="ltr">{handoffs[0].reason}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ErrorNote error={detail.error} />
        <div className="mx-auto flex max-w-3xl flex-col gap-2">
          {d?.messages.map((m, i) => (
            <Bubble key={m.id} m={m} showHistoryDivider={m.history === 0 && d.messages[i - 1]?.history === 1} />
          ))}
          <div ref={bottom} />
        </div>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send.mutate();
        }}
        className="flex flex-col gap-2 border-t border-line p-3"
      >
        <ErrorNote error={send.error} />
        {photoError && <p className="text-xs text-bad">{photoError}</p>}
        {photos.length > 0 && (
          <div className="flex flex-wrap gap-3 pt-2">
            {photos.map((photo, n) => (
              <div key={n} className="relative">
                <img src={photo} alt="" className="size-20 rounded-xl border border-line object-cover" />
                {!send.isPending && (
                  <button
                    type="button"
                    onClick={() => setPhotos((p) => p.filter((_, i) => i !== n))}
                    aria-label="شيل الصورة"
                    className="absolute -top-2 -start-2 grid size-6 place-items-center rounded-full bg-bad text-white"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {sending && (
          <p className="text-xs text-muted">
            عم ابعت الصور… <span className="num">{sending.done}</span>/<span className="num">{sending.total}</span>
          </p>
        )}
        {!windowOpen && d && (
          <p className="text-xs text-warn">
            مرّ أكتر من 24 ساعة على آخر رسالة من الزبون، فواتساب ما بيسمح برسالة عادية. الرد لازم يكون من التطبيق بقالب.
          </p>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              void pickPhotos([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="ghost"
            onClick={() => fileInput.current?.click()}
            disabled={!windowOpen || send.isPending || photos.length >= MAX_PHOTOS}
            aria-label="إضافة صور"
            title="إضافة صور (لحد 10)"
          >
            <ImagePlus size={16} />
          </Button>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (canSend) send.mutate();
              }
            }}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
              if (files.length) {
                e.preventDefault();
                void pickPhotos(files);
              }
            }}
            rows={1}
            placeholder={photos.length ? "اكتب تعليق على أول صورة (اختياري)…" : "اكتب رد كفريق… (المساعد بيوقف على هالمحادثة)"}
            className="max-h-40 min-h-11 flex-1 resize-y rounded-xl border border-line bg-card-2 px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
          <Button disabled={!canSend} aria-label="إرسال">
            <Send size={16} />
          </Button>
        </div>
      </form>
    </>
  );
}

// The text without the "[sent a photo]" label when the photo itself is shown.
function caption(m: Message) {
  if (!m.mediaFile) return m.text;
  if (m.mediaType === "audio") return m.text.replace(/^\[voice note\]\s*/, "");
  return m.text.replace(/^\[(sent a photo|sent a sticker|sent a video|sent product photo: [^\]]*)\]\s*/, "");
}

function Media({ m }: { m: Message }) {
  if (!m.mediaFile) return null;
  const url = mediaUrl(m.mediaFile);
  if (m.mediaType === "image" || m.mediaType === "sticker") {
    return (
      <a href={url} target="_blank" rel="noreferrer" className="mb-1 block">
        <img src={url} alt="" loading="lazy" className="max-h-72 rounded-xl object-contain" />
      </a>
    );
  }
  if (m.mediaType === "audio") {
    return (
      <div className="mb-1 flex flex-col gap-1">
        <audio controls preload="none" src={url} className="h-9 max-w-64" />
        <span className="text-[11px] text-muted">النص يلي سمعو المساعد:</span>
      </div>
    );
  }
  if (m.mediaType === "video") return <video controls preload="none" src={url} className="mb-1 max-h-72 rounded-xl" />;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="mb-1 block text-primary underline">
      فتح الملف
    </a>
  );
}

function Bubble({ m, showHistoryDivider }: { m: Message; showHistoryDivider: boolean }) {
  const mine = m.role === "business";
  return (
    <>
      {showHistoryDivider && (
        <div className="my-3 flex items-center gap-3 text-xs text-muted">
          <span className="h-px flex-1 bg-line" /> بداية الرسائل بعد ربط المساعد <span className="h-px flex-1 bg-line" />
        </div>
      )}
      <div className={clsx("flex", mine ? "justify-end" : "justify-start")}>
        <div
          className={clsx(
            "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm",
            m.source === "customer" && "rounded-ss-sm bg-card-2",
            m.source === "ai" && "rounded-se-sm bg-primary-soft",
            m.source === "staff" && "rounded-se-sm bg-info/12",
            m.history === 1 && "opacity-75",
          )}
        >
          <Media m={m} />
          {caption(m) && <p className="whitespace-pre-wrap break-words">{caption(m)}</p>}
          <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] text-muted">
            {m.history === 1 && <History size={11} />}
            {m.source === "ai" && (
              <>
                <Bot size={11} /> المساعد ·
              </>
            )}
            {m.source === "staff" && (
              <>
                <UserRound size={11} /> الفريق ·
              </>
            )}
            <span className="num">{time(m.at)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

// Lets the AI answer every customer left without a reply (e.g. they wrote while it was off).
function AnswerWaiting() {
  const queryClient = useQueryClient();
  const answer = useMutation({
    mutationFn: api.answerWaiting,
    onSuccess: () => setTimeout(() => queryClient.invalidateQueries({ queryKey: ["conversations"] }), 5_000),
  });
  const r = answer.data;
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={() => answer.mutate()}
        disabled={answer.isPending}
        className="rounded-lg bg-primary-soft px-3 py-1 text-xs text-primary hover:bg-primary hover:text-white disabled:opacity-50"
        title="المساعد بيرد على الزباين اللي ما انرد عليهم (مش المحادثات اللي الفريق ماسكها)"
      >
        رد على المتروكة
      </button>
      {r && (
        <span className="text-[11px] text-muted">
          {r.queued ? `عم يرد على ${r.queued}` : "ما في رسائل متروكة"}
          {r.withTeam > 0 && ` · ${r.withTeam} مع الفريق`}
        </span>
      )}
      {answer.error && <span className="text-[11px] text-bad">{answer.error.message}</span>}
    </div>
  );
}
