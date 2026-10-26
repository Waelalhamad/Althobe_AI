import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Truck, X } from "lucide-react";
import { api, type DarbShipment, type Order } from "../api";
import { Button, ErrorNote } from "./ui";
import { num } from "../format";

const inputClass = "w-full rounded-xl border border-line bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary";

// Darb Assabil's shipment statuses, in Arabic.
export const DARB_STATUS: Record<string, string> = {
  pending: "بانتظار المندوب",
  booked: "انحجزت",
  processing: "عالطريق",
  "on-branch": "بالفرع",
  completed: "انسلمت",
  cancelled: "ملغية",
  resent: "انبعتت من جديد",
  delayed: "متأخرة",
  released: "انسلمت للزبون",
  returning: "راجعة",
  returned: "رجعت",
};

// Sends a confirmed order to Darb Assabil: the team checks the guessed city/area, the address note and the amount
// to collect, sees Darb's delivery price, and sends.
export function DarbSend({ order, onClose }: { order: Order; onClose: () => void }) {
  const queryClient = useQueryClient();
  const preview = useQuery({ queryKey: ["darb-preview", order.id], queryFn: () => api.darbPreview(order.id), staleTime: Infinity });
  const [s, setS] = useState<DarbShipment>({ city: "", area: "", notes: "", total: 0 });
  useEffect(() => {
    const p = preview.data;
    if (p) setS({ city: p.guess?.city ?? "", area: p.guess?.area ?? "", notes: p.notes, total: p.total });
  }, [preview.data]);
  const areas = useMemo(() => preview.data?.zones.find((z) => z.city === s.city)?.areas ?? [], [preview.data, s.city]);

  // Darb's price for this place, asked again when the city, area or amount changes.
  const quote = useQuery({
    queryKey: ["darb-quote", order.id, s.city, s.area, s.total],
    queryFn: () => api.darbQuote(order.id, s),
    enabled: Boolean(s.city && s.area && s.total > 0),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const send = useMutation({
    mutationFn: () => api.sendToDarb(order.id, s),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      onClose();
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate();
        }}
        className="my-8 flex w-full max-w-lg flex-col gap-3 rounded-2xl border border-line bg-card p-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <Truck size={20} className="text-primary" /> ابعت الطلب #{order.id} لدرب السبيل
          </h2>
          <button type="button" onClick={onClose} aria-label="سكّر" className="text-muted hover:text-fg">
            <X size={20} />
          </button>
        </div>

        {preview.isLoading && (
          <div className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 size={16} className="animate-spin" /> عم جيب المدن من درب السبيل…
          </div>
        )}
        <ErrorNote error={preview.error} />

        {preview.data && (
          <>
            <div className="rounded-xl bg-card-2 p-3 text-sm">
              <div className="font-semibold">{order.name}</div>
              <div className="ltr num text-start text-muted">{preview.data.phone || order.phone}</div>
              <div className="mt-1 text-xs text-muted">
                الزبون كتب: {order.city} - {order.address}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">المدينة (حسب درب السبيل)</span>
                <select
                  value={s.city}
                  onChange={(e) => {
                    const zone = preview.data.zones.find((z) => z.city === e.target.value);
                    setS({ ...s, city: e.target.value, area: zone?.areas.find((a) => a === e.target.value) ?? zone?.areas[0] ?? "" });
                  }}
                  className={inputClass}
                  required
                >
                  <option value="">اختار…</option>
                  {preview.data.zones.map((z) => (
                    <option key={z.city} value={z.city}>
                      {z.city}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">المنطقة</span>
                <select value={s.area} onChange={(e) => setS({ ...s, area: e.target.value })} className={inputClass} required disabled={!areas.length}>
                  {!s.area && <option value="">اختار…</option>}
                  {areas.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!preview.data.guess && (
              <p className="rounded-xl bg-warn/10 p-3 text-xs text-warn">ما عرفت المدينة من العنوان، اختارها من القائمة.</p>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">العنوان والملاحظات للمندوب (بتنبعت لدرب السبيل)</span>
              <textarea value={s.notes} onChange={(e) => setS({ ...s, notes: e.target.value })} rows={3} className={inputClass} />
            </label>
            {preview.data.internalNotes && (
              <div className="rounded-xl border border-dashed border-line p-3 text-xs text-muted">
                <div className="mb-1 font-semibold">ملاحظات داخلية (ما بتنبعت)</div>
                <p className="whitespace-pre-wrap">{preview.data.internalNotes}</p>
              </div>
            )}

            <div className="rounded-xl bg-card-2 p-3 text-sm">
              <div className="mb-1 text-xs text-muted">المنتجات</div>
              <ul className="flex flex-col gap-0.5">
                {preview.data.lines.map((l, n) => (
                  <li key={n}>
                    <span className="num">{l.quantity}</span> × {l.title}
                  </li>
                ))}
              </ul>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">المبلغ يلي بيقبضو المندوب (دينار)</span>
                <input
                  type="number"
                  min={1}
                  value={s.total || ""}
                  onChange={(e) => setS({ ...s, total: Number(e.target.value) })}
                  className={`${inputClass} num`}
                  required
                />
              </label>
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted">سعر التوصيل عند درب السبيل</span>
                <div className="rounded-xl border border-line px-3 py-2 text-sm">
                  {quote.isFetching ? (
                    <Loader2 size={16} className="animate-spin text-muted" />
                  ) : quote.data ? (
                    <span className="num">
                      {num(quote.data.shipping)} د{quote.data.charges ? ` + ${quote.data.charges} رسوم` : ""}
                      <span className="text-xs text-muted"> · من المبيعات</span>
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </div>
              </div>
            </div>
            <ErrorNote error={quote.error} />
            <ErrorNote error={send.error} />

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                إلغاء
              </Button>
              <Button type="submit" disabled={send.isPending || !s.city || !s.area || !(s.total > 0)}>
                {send.isPending ? <Loader2 size={16} className="animate-spin" /> : <Truck size={16} />} ابعت لدرب السبيل
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
