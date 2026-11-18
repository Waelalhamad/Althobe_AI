// The team's side of the Libya warehouse count: per count, the system's number when it was sent next to his count and
// the difference for every cell, the pieces he found that aren't on the list, his note and photos. Approving moves
// each counted cell by its difference (orders saved since stay counted); rejecting changes nothing.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, ClipboardCheck, X } from "lucide-react";
import { api, mediaUrl, type StockCountReport } from "../api";
import { Badge, Button, Card, Empty, ErrorNote } from "./ui";
import { num, time } from "../format";

const STATUS = {
  pending: { label: "ناطر مراجعتكم", tone: "warn" },
  approved: { label: "انعتمد", tone: "ok" },
  rejected: { label: "انرفض", tone: "bad" },
} as const;

export function CountReports() {
  const q = useQuery({ queryKey: ["stock-counts"], queryFn: api.stockCounts, refetchInterval: 60_000 });
  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return null;
  if (!q.data.length)
    return <Empty icon={ClipboardCheck} text="لسا ما بعت جرد. بيلاقي «الجرد» بتلفونو: كل منتجاتنا بصورها، بيكتب العدد بس وبيبعت." />;
  return (
    <div className="flex flex-col gap-6">
      {q.data.map((c, i) => (
        <Report key={c.id} count={c} open={i === 0 || c.status === "pending"} />
      ))}
    </div>
  );
}

function Report({ count: c, open: openFirst }: { count: StockCountReport; open: boolean }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(openFirst);
  const [onlyDiff, setOnlyDiff] = useState(true);
  const done = () => {
    void queryClient.invalidateQueries({ queryKey: ["stock-counts"] });
    void queryClient.invalidateQueries({ queryKey: ["stock"] });
  };
  const approve = useMutation({ mutationFn: () => api.approveCount(c.id), onSuccess: done });
  const reject = useMutation({ mutationFn: (reason: string) => api.rejectCount(c.id, reason), onSuccess: done });

  const counted = c.cells.filter((x) => x.counted !== null);
  const diffs = counted.filter((x) => x.counted !== x.system);
  const short = diffs.reduce((n, x) => n + Math.max(0, x.system - x.counted!), 0);
  const over = diffs.reduce((n, x) => n + Math.max(0, x.counted! - x.system), 0);
  const shown = c.cells.filter((x) => !onlyDiff || x.counted === null || x.counted !== x.system);
  const products = [...new Set(shown.map((x) => x.product))];
  const moved = c.status === "pending" && c.cells.some((x) => x.now !== null && x.now !== x.system);
  const s = STATUS[c.status];

  return (
    <Card className="flex flex-col gap-4">
      <button type="button" onClick={() => setOpen(!open)} className="flex flex-wrap items-center gap-2 text-start">
        <ClipboardCheck size={18} className="text-primary" />
        <b>جرد</b>
        <span className="ltr num text-sm text-muted">{time(c.at)}</span>
        <Badge tone={s.tone}>{s.label}</Badge>
        <span className="num ms-auto text-sm text-muted">
          انعدّ {counted.length}/{c.cells.length} · فرق بـ {diffs.length} خانة
        </span>
      </button>

      {open && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Mini label="خانات انعدّت" value={`${num(counted.length)} / ${num(c.cells.length)}`} />
            <Mini label="خانات فيها فرق" value={num(diffs.length)} tone={diffs.length ? "warn" : "ok"} />
            <Mini label="ناقص عن السيستم" value={`${num(short)} قطعة`} tone={short ? "bad" : undefined} />
            <Mini label="زايد عن السيستم" value={`${num(over)} قطعة`} tone={over ? "ok" : undefined} />
          </div>

          {c.status === "rejected" && c.reason && <p className="text-sm text-bad">سبب الرفض: {c.reason}</p>}
          {moved && (
            <p className="text-sm text-warn">
              في خانات تغيّرت بالسيستم من وقت ما بعت الجرد (طلبات أو تعديل): الاعتماد بيضيف الفرق بس، فالطلبات يلي انحفظت بعدو بتضل محسوبة.
            </p>
          )}

          <label className="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
            الفروقات والخانات يلي ما انعدّت بس
          </label>

          {!shown.length && <p className="text-sm text-ok">كل الخانات يلي انعدّت متطابقة مع السيستم.</p>}
          {products.map((p) => (
            <div key={p} className="overflow-x-auto">
              <h4 className="mb-1 font-semibold">{p}</h4>
              <table className="w-full min-w-[420px] text-sm">
                <thead className="text-muted">
                  <tr className="text-start">
                    <th className="py-1 text-start font-normal">اللون</th>
                    <th className="py-1 text-start font-normal">المقاس</th>
                    <th className="py-1 text-center font-normal">السيستم</th>
                    <th className="py-1 text-center font-normal">الجرد</th>
                    <th className="py-1 text-center font-normal">الفرق</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {shown
                    .filter((x) => x.product === p)
                    .map((x) => {
                      const d = x.counted === null ? null : x.counted - x.system;
                      return (
                        <tr key={`${x.color}|${x.size}`}>
                          <td className="py-1.5">{x.color}</td>
                          <td className="num py-1.5">{x.size}</td>
                          <td className="num py-1.5 text-center">
                            {x.system}
                            {c.status === "pending" && x.now !== null && x.now !== x.system && <span className="text-xs text-muted"> (هلق {x.now})</span>}
                          </td>
                          <td className="num py-1.5 text-center font-semibold">{x.counted ?? <span className="font-normal text-muted">ما انعدّت</span>}</td>
                          <td className={clsx("num ltr py-1.5 text-center font-bold", d === null ? "" : d < 0 ? "text-bad" : d > 0 ? "text-ok" : "text-muted")}>
                            {d === null ? "" : d > 0 ? `+${d}` : d}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          ))}

          {c.extras.length > 0 && (
            <div>
              <h4 className="mb-1 font-semibold text-warn">قطع لقاها ومش بالقائمة (ما بتنضاف للمخزون)</h4>
              <ul className="flex flex-col gap-1 text-sm">
                {c.extras.map((e, n) => (
                  <li key={n}>
                    {e.product} · {e.color || "—"} · <span className="num">{e.size || "—"}</span> · <b className="num">{e.quantity ?? "؟"}</b> قطعة
                  </li>
                ))}
              </ul>
            </div>
          )}
          {c.note && (
            <div>
              <h4 className="mb-1 font-semibold">ملاحظاتو</h4>
              <p className="whitespace-pre-wrap text-sm">{c.note}</p>
            </div>
          )}
          {c.photos.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {c.photos.map((f) => (
                <a key={f} href={mediaUrl(f)} target="_blank" rel="noreferrer">
                  <img src={mediaUrl(f)} alt="" className="size-28 rounded-xl object-cover" />
                </a>
              ))}
            </div>
          )}

          <ErrorNote error={approve.error ?? reject.error} />
          {c.status === "pending" && (
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={approve.isPending || reject.isPending}
                onClick={() =>
                  window.confirm(
                    `نعتمد الجرد؟ ${diffs.length} خانة بالمخزون بتتغيّر بالفرق (ناقص ${short}، زايد ${over}). الخانات يلي ما انعدّت والقطع المش بالقائمة ما بتتغيّر.`,
                  ) && approve.mutate()
                }
              >
                <Check size={16} /> اعتمد وحدّث المخزون
              </Button>
              <Button
                variant="ghost"
                disabled={approve.isPending || reject.isPending}
                onClick={() => {
                  const reason = window.prompt("ليش رافضينو؟ (بيشوفها الموظف، فاضي مسموح)");
                  if (reason !== null) reject.mutate(reason);
                }}
              >
                <X size={16} /> ارفض
              </Button>
            </div>
          )}
          {approve.data && <p className="text-sm text-ok">انعتمد: تغيّرت {approve.data.changed} خانة بالمخزون.</p>}
        </>
      )}
    </Card>
  );
}

function Mini({ label, value, tone }: { label: string; value: string; tone?: "ok" | "warn" | "bad" }) {
  return (
    <div className="rounded-xl bg-card-2 p-3">
      <div className="text-xs text-muted">{label}</div>
      <div className={clsx("num text-lg font-bold", tone && `text-${tone}`)}>{value}</div>
    </div>
  );
}
