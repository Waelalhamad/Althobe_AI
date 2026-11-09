import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban } from "lucide-react";
import { api } from "../api";
import { Badge, Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { ago, phone } from "../format";

export function Blacklist() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["blacklist"], queryFn: api.blacklist });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickedSend, setPickedSend] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<string>("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["blacklist"] });

  const add = useMutation({
    mutationFn: (customers: string[]) => api.addBlacklist(customers, "رجع أو انلغى بسبب الزبون"),
    onSuccess: () => {
      setPicked(new Set());
      refresh();
    },
  });
  const remove = useMutation({ mutationFn: (c: string) => api.removeBlacklist(c), onSuccess: refresh });
  const send = useMutation({
    mutationFn: (customers: string[]) => api.sendBlacklist(customers),
    onSuccess: (r) => {
      setPickedSend(new Set());
      setResult(`انبعتت لـ ${r.sent.length}${r.failed.length ? `، وفشلت ${r.failed.length}: ${r.failed.map((f) => `${phone(f.customer)} (${f.error})`).join("، ")}` : ""}`);
      refresh();
    },
  });

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, c: string) => {
    const n = new Set(set);
    n.has(c) ? n.delete(c) : n.add(c);
    setter(n);
  };
  const candidates = q.data?.candidates ?? [];
  const list = q.data?.list ?? [];
  const unsent = list.filter((b) => !b.notifiedAt);

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="القائمة السوداء"
        subtitle="زباين رجعت أو انلغت طلباتهم بسببهم (ما ردوا على المندوب، لغوا الطلب). المساعد ما يرد عليهم، والفريق ينتبه لما يكتبوا. اللي رجع بسبب المقاس أو المواصفات ما يطلعش هنا."
      />
      <ErrorNote error={q.error ?? add.error ?? remove.error ?? send.error} />

      <Card className="p-0">
        <div className="flex items-center justify-between px-5 py-3">
          <h2 className="font-semibold">مقترحين ({candidates.length})</h2>
          <button
            disabled={picked.size === 0 || add.isPending}
            onClick={() => add.mutate([...picked])}
            className="rounded-xl bg-primary px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            أضف المحدد للقائمة ({picked.size})
          </button>
        </div>
        {candidates.length === 0 && <Empty icon={Ban} text="ما في مقترحين." />}
        <ul className="divide-y divide-line">
          {candidates.map((c) => (
            <li key={c.customer} className="flex items-center gap-3 px-5 py-3">
              <input type="checkbox" checked={picked.has(c.customer)} onChange={() => toggle(picked, setPicked, c.customer)} />
              <div className="min-w-44">
                <div className="font-semibold">{c.name || "—"}</div>
                <div className="ltr num text-start text-xs text-muted">{phone(c.customer)} · {c.city}</div>
              </div>
              <p className="flex-1 text-sm text-muted">{c.reason}</p>
              <Badge tone="warn">{c.amount} د.ل</Badge>
              <Link href={`/inbox/${c.customer}`} className="text-xs text-primary">المحادثة</Link>
            </li>
          ))}
        </ul>
      </Card>

      <Card className="p-0">
        <div className="flex items-center justify-between px-5 py-3">
          <h2 className="font-semibold">في القائمة ({list.length})</h2>
          <button
            disabled={pickedSend.size === 0 || send.isPending}
            onClick={() => {
              if (confirm(`تبعت رسالة القائمة السوداء لـ ${pickedSend.size} زبون؟\n\n${q.data?.message}`)) send.mutate([...pickedSend]);
            }}
            className="rounded-xl bg-bad px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            ابعت الرسالة للمحدد ({pickedSend.size})
          </button>
        </div>
        {unsent.length > 0 && (
          <button className="px-5 pb-2 text-xs text-primary" onClick={() => setPickedSend(new Set(unsent.map((b) => b.customer)))}>
            حدد كل اللي ما انبعتلهمش ({unsent.length})
          </button>
        )}
        {result && <p className="px-5 pb-2 text-sm">{result}</p>}
        {list.length === 0 && <Empty icon={Ban} text="القائمة فاضية." />}
        <ul className="divide-y divide-line">
          {list.map((b) => (
            <li key={b.customer} className="flex items-center gap-3 px-5 py-3">
              <input type="checkbox" checked={pickedSend.has(b.customer)} onChange={() => toggle(pickedSend, setPickedSend, b.customer)} />
              <div className="min-w-44">
                <div className="font-semibold">{b.name || "—"}</div>
                <div className="ltr num text-start text-xs text-muted">{phone(b.customer)}</div>
              </div>
              <p className="flex-1 text-sm text-muted">{b.reason}</p>
              {b.notifiedAt ? <Badge tone="info">انبعتتله {ago(b.notifiedAt)}</Badge> : <Badge>ما انبعتتله</Badge>}
              <Link href={`/inbox/${b.customer}`} className="text-xs text-primary">المحادثة</Link>
              <button className="text-xs text-bad" onClick={() => confirm("تشيلو من القائمة؟") && remove.mutate(b.customer)}>شيله</button>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold">نص الرسالة</h2>
        <pre className="whitespace-pre-wrap text-sm text-muted">{q.data?.message}</pre>
      </Card>
    </div>
  );
}
