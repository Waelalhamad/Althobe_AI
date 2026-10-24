import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowRight, Bot, History, Inbox as InboxIcon, Pause, Play, Search, Send, User, UserRound } from "lucide-react";
import { api, type ConversationFilter, type ConversationSummary, type Message } from "../api";
import { Badge, Button, Empty, ErrorNote } from "../components/ui";
import { ago, country, pauseLabel, phone, time, until } from "../format";

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
          <h1 className="text-xl font-bold">المحادثات</h1>
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
        <span className="ltr num text-sm font-semibold">{phone(c.customer)}</span>
        <span className="text-xs text-muted">{ago(c.lastAt)}</span>
      </div>
      <div className="flex items-center gap-2">
        <SourceIcon source={c.lastSource} />
        <span className="line-clamp-1 flex-1 text-sm text-muted">{c.lastText}</span>
      </div>
      <div className="flex flex-wrap gap-1">
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

function Thread({ customer }: { customer: string }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const detail = useQuery({ queryKey: ["conversation", customer], queryFn: () => api.conversation(customer), refetchInterval: 5_000 });
  const [text, setText] = useState("");
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
  const resume = useMutation({ mutationFn: () => api.resume(customer), onSuccess: refresh });
  const send = useMutation({
    mutationFn: () => api.send(customer, text.trim()),
    onSuccess: () => {
      setText("");
      refresh();
    },
  });

  const windowOpen = d?.windowOpenUntil ? d.windowOpenUntil > Date.now() : false;
  const handoffs = d?.aiCalls.filter((c) => c.action !== "reply") ?? [];

  return (
    <>
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <button onClick={() => navigate("/inbox")} className="text-muted md:hidden" aria-label="رجوع">
          <ArrowRight />
        </button>
        <div className="flex-1">
          <div className="ltr num text-start font-semibold">{phone(customer)}</div>
          <div className="text-xs text-muted">
            {country(customer)}
            {d && ` · ${d.messages.length} رسالة`}
            {d?.windowOpenUntil && (windowOpen ? ` · نافذة الرد مفتوحة ${until(d.windowOpenUntil)}` : " · نافذة الـ 24 ساعة مسكّرة")}
          </div>
        </div>
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
          if (text.trim()) send.mutate();
        }}
        className="flex flex-col gap-2 border-t border-line p-3"
      >
        <ErrorNote error={send.error} />
        {!windowOpen && d && (
          <p className="text-xs text-warn">
            مرّ أكتر من 24 ساعة على آخر رسالة من الزبون، فواتساب ما بيسمح برسالة عادية. الرد لازم يكون من التطبيق بقالب.
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (text.trim()) send.mutate();
              }
            }}
            rows={1}
            placeholder="اكتب رد كفريق… (المساعد بيوقف على هالمحادثة)"
            className="max-h-40 min-h-11 flex-1 resize-y rounded-xl border border-line bg-card-2 px-3 py-2.5 text-sm outline-none focus:border-primary"
          />
          <Button disabled={!text.trim() || send.isPending || !windowOpen} aria-label="إرسال">
            <Send size={16} />
          </Button>
        </div>
      </form>
    </>
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
          <p className="whitespace-pre-wrap break-words">{m.text}</p>
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
