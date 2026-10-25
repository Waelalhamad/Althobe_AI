import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GraduationCap } from "lucide-react";
import { api, type Lesson } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { ago, phone } from "../format";

const inputClass = "w-full rounded-xl border border-line bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary";

type Tab = "pending" | "unanswered" | "approved" | "done";

export function Learning() {
  const [tab, setTab] = useState<Tab>("pending");
  const q = useQuery({ queryKey: ["learning"], queryFn: api.learning, refetchInterval: 30_000 });
  const d = q.data;
  const tabs: { key: Tab; label: string; n?: number }[] = [
    { key: "pending", label: "بانتظار موافقتك", n: d?.pending.length },
    { key: "unanswered", label: "ما حدا جاوب", n: d?.unanswered.length },
    { key: "approved", label: "تعلّمها", n: d?.approved.length },
    { key: "done", label: "متجاهلة / معروفة" },
  ];
  const list = d?.[tab] ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="التعلّم"
        subtitle="لما المساعد ما بيعرف ويحوّل للفريق، بيكتب درس من رد الفريق. وافق عليه وبيصير يجاوب لحالو المرة الجاية."
      />
      <ErrorNote error={q.error} />
      {d && d.waiting > 0 && (
        <p className="mb-3 text-sm text-muted">{d.waiting} محادثة محوّلة عم تستنى رد الفريق، بعد الرد بشوي بيطلع الدرس هون.</p>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-xl px-3 py-1.5 text-sm ${tab === t.key ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg"}`}
          >
            {t.label}
            {t.n ? ` (${t.n})` : ""}
          </button>
        ))}
      </div>
      {d && list.length === 0 && (
        <Card>
          <Empty icon={GraduationCap} text="ما في شي هون هلق." />
        </Card>
      )}
      <div className="flex flex-col gap-3">
        {list.map((l) => (tab === "pending" || tab === "unanswered" ? <LessonEditor key={l.id} lesson={l} /> : <LessonRow key={l.id} lesson={l} />))}
      </div>
    </div>
  );
}

function ChatLink({ lesson }: { lesson: Lesson }) {
  return (
    <Link href={`/inbox/${lesson.customer}`} className="ltr num text-sm font-semibold hover:text-primary">
      {phone(lesson.customer)}
    </Link>
  );
}

// A lesson to approve (pending), or a gap the owner answers themselves (unanswered).
function LessonEditor({ lesson }: { lesson: Lesson }) {
  const queryClient = useQueryClient();
  const [question, setQuestion] = useState(lesson.question || lesson.asked);
  const [answer, setAnswer] = useState(lesson.answer);
  const done = () => queryClient.invalidateQueries({ queryKey: ["learning"] });
  const approve = useMutation({ mutationFn: () => api.approveLesson(lesson.id, question, answer), onSuccess: done });
  const ignore = useMutation({ mutationFn: () => api.ignoreLesson(lesson.id), onSuccess: done });

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ChatLink lesson={lesson} />
        {lesson.seen > 1 && <Badge tone="warn">انسأل {lesson.seen} مرات</Badge>}
        {lesson.status === "unanswered" && <Badge tone="bad">الفريق ما رد</Badge>}
        <span className="text-xs text-muted">{ago(lesson.updatedAt)}</span>
      </div>
      {lesson.asked && (
        <p className="mb-2 whitespace-pre-line text-sm">
          <span className="text-muted">الزبون كتب: </span>
          {lesson.asked}
        </p>
      )}
      {lesson.teamReply && (
        <p className="mb-3 whitespace-pre-line text-sm">
          <span className="text-muted">الفريق رد: </span>
          {lesson.teamReply}
        </p>
      )}
      <label className="mb-1 block text-xs text-muted">لما الزبون يسأل</label>
      <input value={question} onChange={(e) => setQuestion(e.target.value)} className={`${inputClass} mb-2`} />
      <label className="mb-1 block text-xs text-muted">الجواب</label>
      <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={3} placeholder="اكتب الجواب الصح" className={inputClass} />
      {lesson.note && <p className="mt-2 text-xs text-muted">ملاحظة: {lesson.note}</p>}
      <ErrorNote error={approve.error ?? ignore.error} />
      <div className="mt-3 flex gap-2">
        <Button onClick={() => approve.mutate()} disabled={!question.trim() || !answer.trim() || approve.isPending}>
          وافق وعلّمو
        </Button>
        <Button variant="ghost" onClick={() => ignore.mutate()} disabled={ignore.isPending}>
          تجاهل
        </Button>
      </div>
    </Card>
  );
}

function LessonRow({ lesson }: { lesson: Lesson }) {
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <ChatLink lesson={lesson} />
        {lesson.status === "approved" && <Badge tone="ok">تعلّمها</Badge>}
        {lesson.status === "ignored" && <Badge>متجاهلة</Badge>}
        {lesson.status === "skipped" && <Badge tone="info">معروفة أو ما بتنفع درس</Badge>}
        <span className="text-xs text-muted">{ago(lesson.updatedAt)}</span>
      </div>
      {lesson.question && <p className="text-sm"><span className="text-muted">لما يسأل: </span>{lesson.question}</p>}
      {lesson.answer && <p className="text-sm"><span className="text-muted">الجواب: </span>{lesson.answer}</p>}
      {lesson.note && <p className="mt-1 text-xs text-muted">{lesson.note}</p>}
      {lesson.status === "approved" && (
        <p className="mt-2 rounded-xl bg-card-2 p-3 text-sm whitespace-pre-line">
          <span className="text-muted">هلق المساعد بيرد: </span>
          {lesson.retest || "عم يجرّب…"}
        </p>
      )}
    </Card>
  );
}
