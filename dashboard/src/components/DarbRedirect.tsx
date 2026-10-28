import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowLeft, Loader2, Shuffle } from "lucide-react";
import { api, PAYMENT_LABEL, type Order, type RedirectMatch } from "../api";
import { Badge, Button, ErrorNote } from "./ui";
import { DARB_STATUS } from "./DarbSend";
import { Modal } from "./DarbTrack";
import { ago, num } from "../format";

const inputClass = "w-full rounded-xl border border-line bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary";

// A cancelled (or refused) order's shipment goes to another customer in the same city who ordered the same pieces.
// The team picks who, checks the change, and presses تمام: only then Darb's shipment changes.
export function DarbRedirect({ order, onClose }: { order: Order; onClose: () => void }) {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["redirect", order.id], queryFn: () => api.redirectMatches(order.id) });
  const [pick, setPick] = useState<RedirectMatch>();
  const [area, setArea] = useState("");
  const [notes, setNotes] = useState("");
  const [total, setTotal] = useState(0);
  const [payment, setPayment] = useState<"cash" | "transfer">("cash");
  const send = useMutation({
    mutationFn: () => api.redirect(order.id, { to: pick!.orderId, area, notes, total, payment }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["redirects"] });
      onClose();
    },
  });
  const choose = (m: RedirectMatch) => {
    setPick(m);
    setArea(m.area);
    setNotes(m.address);
    setTotal(m.total);
    setPayment(m.payment === "transfer" ? "transfer" : "cash");
  };
  const v = q.data;

  return (
    <Modal
      title={
        <>
          <Shuffle size={18} /> حوّل الشحنة لطلب متلها
        </>
      }
      onClose={onClose}
    >
      <ErrorNote error={q.error} />
      {q.isLoading && <Loader2 className="mx-auto animate-spin text-muted" />}
      {v && (
        <>
          <div className="rounded-xl bg-card-2 p-3 text-sm">
            شحنة طلب <span className="num font-semibold">#{order.id}</span> ({order.name}) ·{" "}
            <span className="num">{v.shipment.sh && v.shipment.sh !== v.shipment.reference ? `${v.shipment.sh} · فرع #${v.shipment.reference}` : `#${v.shipment.reference}`}</span>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge tone={v.pickedUp ? "info" : "warn"}>{DARB_STATUS[v.shipment.status] ?? v.shipment.status}</Badge>
              {v.shipment.city}
              {v.shipment.area && ` / ${v.shipment.area}`} · {v.pickedUp ? "المندوب استلمها" : "لسا ما استلمها المندوب"}
            </div>
          </div>

          {v.matches.length === 0 && <p className="text-sm text-muted">ما في طلب متلها بنفس المدينة هلأ.</p>}

          {!pick && v.matches.length > 0 && (
            <>
              <p className="text-sm text-muted">طلبات بنفس القطع بـ {v.shipment.city}، اختار لمين تروح:</p>
              <ul className="flex flex-col gap-2">
                {v.matches.map((m) => (
                  <li key={m.orderId}>
                    <button
                      type="button"
                      onClick={() => choose(m)}
                      className="flex w-full flex-col gap-1 rounded-xl border border-line p-3 text-start text-sm hover:border-primary"
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="num font-semibold">#{m.orderId}</span>
                        <span className="font-semibold">{m.name}</span>
                        <Badge tone={m.status === "new" ? "warn" : "info"}>{m.status === "new" ? "جديد، مش متأكد" : "متأكد"}</Badge>
                        <span className="text-xs text-muted">{ago(m.createdAt)}</span>
                      </span>
                      <span className="ltr num text-start text-xs text-muted">{m.phone}</span>
                      <span className="text-xs text-muted">
                        {m.area || "المنطقة؟"} · {num(m.total)} د · {PAYMENT_LABEL[m.payment]}
                      </span>
                      {m.shipment && (
                        <span className="text-xs text-warn">إلو شحنة لسا ما انستلمت (#{m.shipment.reference})، رح تنلغى</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          {pick && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2 rounded-xl bg-card-2 p-3 text-sm">
                <span>
                  {order.name} <span className="ltr num text-xs text-muted">{order.phone}</span>
                </span>
                <ArrowLeft size={16} className="shrink-0 text-primary" />
                <span className="font-semibold">
                  {pick.name} <span className="ltr num text-xs font-normal text-muted">{pick.phone}</span>
                </span>
              </div>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">المنطقة بـ {v.shipment.city}</span>
                <select value={area} onChange={(e) => setArea(e.target.value)} className={inputClass}>
                  <option value="">اختار المنطقة</option>
                  {v.areas.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </select>
                {v.pickedUp && <span className="text-xs text-warn">الشحنة بالطريق: المنطقة بتنكتب بملاحظة المندوب، ما بتتغيّر عند درب.</span>}
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-muted">ملاحظة المندوب (العنوان واللوكيشن)</span>
                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className={inputClass} />
              </label>
              <div className="flex flex-wrap gap-3">
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  <span className="text-muted">المبلغ</span>
                  <input type="number" min={0} value={total} onChange={(e) => setTotal(Number(e.target.value))} className={clsx(inputClass, "num")} />
                </label>
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  <span className="text-muted">الدفع</span>
                  <select value={payment} onChange={(e) => setPayment(e.target.value as "cash" | "transfer")} className={inputClass}>
                    <option value="cash">{PAYMENT_LABEL.cash}</option>
                    <option value="transfer">{PAYMENT_LABEL.transfer} (المندوب ما بيقبض شي)</option>
                  </select>
                </label>
              </div>
              {pick.shipment && <p className="text-xs text-warn">شحنة الطلب #{pick.orderId} القديمة (#{pick.shipment.reference}) رح تنلغى عند درب.</p>}
              <ErrorNote error={send.error} />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => send.mutate()} disabled={send.isPending || (!v.pickedUp && !area)}>
                  {send.isPending ? <Loader2 size={16} className="animate-spin" /> : <Shuffle size={16} />} تمام، حوّلها
                </Button>
                <Button variant="ghost" onClick={() => setPick(undefined)} disabled={send.isPending}>
                  رجوع
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
