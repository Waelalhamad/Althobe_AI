import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { api, PAYMENT_LABEL, type OrderInput, type OrderItem, type OrderStatus, type Payment } from "../api";
import { Button, ErrorNote } from "./ui";

const inputClass = "w-full rounded-xl border border-line bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary";

// The confirmation the customer gets when the team records the order (they can edit it in the form).
function confirmation(o: OrderInput): string {
  const items = o.items
    .filter((i) => i.color || i.size || i.product)
    .map((i) => `${i.quantity} × ${[i.product || "الثوب العربي", i.color, i.size && `مقاس ${i.size}`].filter(Boolean).join(" ")}`);
  const place = [o.city, o.address].filter((s) => s.trim()).join(" - ");
  return [
    "تم تثبيت طلبك استاذ 🙏",
    ...items,
    place && `التوصيل: ${place}`,
    o.total.trim() && `الإجمالي: ${o.total.trim()}`,
    o.payment && `الدفع: ${PAYMENT_LABEL[o.payment]}`,
    "تقدر تقيسو وقت يجيك المندوب قبل ما تستلم 👌",
  ]
    .filter(Boolean)
    .join("\n");
}

const NEW_STATUSES: { id: OrderStatus; label: string }[] = [
  { id: "confirmed", label: "متأكد" },
  { id: "new", label: "جديد، بدو تأكيد" },
  { id: "delivered", label: "انسلّم" },
];

export const emptyOrder = (): OrderInput => ({
  name: "",
  phone: "",
  city: "",
  address: "",
  items: [{ product: "", color: "", size: "", quantity: 1 }],
  total: "",
  notes: "",
  payment: "cash",
});

// Adds an order the team closed (orderId missing), or corrects an existing one.
// customer: the chat it belongs to, when opened from the inbox.
export function OrderForm({
  initial,
  orderId,
  customer,
  note,
  onClose,
}: {
  initial: OrderInput;
  orderId?: number;
  customer?: string;
  note?: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [o, setO] = useState<OrderInput>(initial.items.length ? initial : { ...initial, items: emptyOrder().items });
  const [status, setStatus] = useState<OrderStatus>("confirmed");
  // From a chat, the customer gets a confirmation by default; the text follows the form until the team edits it.
  const [notify, setNotify] = useState(Boolean(customer));
  const [message, setMessage] = useState<string>();
  const [messageError, setMessageError] = useState<string>();
  // Suggestions from the product photos (product names and colors).
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, staleTime: 60_000 });
  const products = [...new Set(catalog.data?.map((c) => c.product).filter((p): p is string => Boolean(p)))];
  const colors = [...new Set(catalog.data?.map((c) => c.name.replace(/^اللون:\s*/, "")).filter(Boolean))];

  const save = useMutation({
    mutationFn: () =>
      orderId
        ? api.updateOrder(orderId, o)
        : api.createOrder({ ...o, customer, status, message: notify ? (message ?? confirmation(o)) : undefined }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      const error = result && typeof result === "object" && "messageError" in result ? (result.messageError as string | undefined) : undefined;
      if (error) setMessageError(error);
      else onClose();
    },
  });

  const set = (patch: Partial<OrderInput>) => setO((prev) => ({ ...prev, ...patch }));
  const setItem = (n: number, patch: Partial<OrderItem>) =>
    set({ items: o.items.map((item, i) => (i === n ? { ...item, ...patch } : item)) });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
        className="my-8 flex w-full max-w-xl flex-col gap-3 rounded-2xl border border-line bg-card p-5"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">{orderId ? `تعديل الطلب #${orderId}` : "طلب جديد من الفريق"}</h2>
          <button type="button" onClick={onClose} aria-label="سكّر" className="text-muted hover:text-fg">
            <X size={20} />
          </button>
        </div>
        {note && <p className="rounded-xl bg-info/10 p-3 text-xs text-info">{note}</p>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Label text="الاسم">
            <input value={o.name} onChange={(e) => set({ name: e.target.value })} className={inputClass} />
          </Label>
          <Label text="الرقم">
            <input value={o.phone} onChange={(e) => set({ phone: e.target.value })} dir="ltr" placeholder="09XXXXXXXX" className={inputClass} required />
          </Label>
          <Label text="المدينة">
            <input value={o.city} onChange={(e) => set({ city: e.target.value })} className={inputClass} />
          </Label>
          <Label text="العنوان (المنطقة، الشارع، أقرب معلم)">
            <input value={o.address} onChange={(e) => set({ address: e.target.value })} className={inputClass} />
          </Label>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs text-muted">الطلب</span>
          {o.items.map((item, n) => (
            <div key={n} className="grid grid-cols-[1fr_1fr_5rem_4rem_auto] items-center gap-2">
              <input value={item.product ?? ""} onChange={(e) => setItem(n, { product: e.target.value })} placeholder="المنتج" list="order-products" className={inputClass} />
              <input value={item.color} onChange={(e) => setItem(n, { color: e.target.value })} placeholder="اللون" list="order-colors" className={inputClass} />
              <input value={item.size} onChange={(e) => setItem(n, { size: e.target.value })} placeholder="المقاس" dir="ltr" className={inputClass} />
              <input
                type="number"
                min={1}
                value={item.quantity}
                onChange={(e) => setItem(n, { quantity: Number(e.target.value) || 1 })}
                aria-label="العدد"
                dir="ltr"
                className={inputClass}
              />
              <button
                type="button"
                onClick={() => set({ items: o.items.filter((_, i) => i !== n) })}
                disabled={o.items.length === 1}
                aria-label="شيل"
                className="text-muted hover:text-bad disabled:opacity-30"
              >
                <Trash2 size={16} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() => set({ items: [...o.items, { product: o.items[0]?.product ?? "", color: "", size: "", quantity: 1 }] })}
            className="flex w-fit items-center gap-1 text-sm text-primary"
          >
            <Plus size={14} /> لون أو مقاس تاني
          </button>
          <datalist id="order-products">{products.map((p) => <option key={p} value={p} />)}</datalist>
          <datalist id="order-colors">{colors.map((c) => <option key={c} value={c} />)}</datalist>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Label text="الاجمالي">
            <input value={o.total} onChange={(e) => set({ total: e.target.value })} placeholder="مثلاً 385 دينار" className={inputClass} />
          </Label>
          <Label text="الدفع">
            <select value={o.payment || ""} onChange={(e) => set({ payment: e.target.value as Payment })} className={inputClass} required>
              {!o.payment && <option value="">اختار…</option>}
              {(Object.keys(PAYMENT_LABEL) as Payment[]).map((p) => (
                <option key={p} value={p}>
                  {PAYMENT_LABEL[p]}
                </option>
              ))}
            </select>
          </Label>
          {!orderId && (
            <Label text="الحالة">
              <select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)} className={inputClass}>
                {NEW_STATUSES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Label>
          )}
        </div>
        <Label text="ملاحظات">
          <textarea value={o.notes} onChange={(e) => set({ notes: e.target.value })} rows={2} className={inputClass} />
        </Label>

        {!orderId && (
          <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} className="accent-[var(--color-primary)]" />
              ابعت رسالة تأكيد للزبون عالواتساب
            </label>
            {notify && (
              <textarea
                value={message ?? confirmation(o)}
                onChange={(e) => setMessage(e.target.value)}
                rows={6}
                className={inputClass}
              />
            )}
          </div>
        )}

        <ErrorNote error={save.error} />
        {messageError ? (
          <div className="flex flex-col gap-2">
            <p className="rounded-xl bg-warn/10 p-3 text-sm text-warn">الطلب انسجل، بس الرسالة ما انبعتت: {messageError}</p>
            <Button type="button" variant="ghost" onClick={onClose}>
              سكّر
            </Button>
          </div>
        ) : (
        <div className="flex gap-2">
          <Button disabled={save.isPending}>{orderId ? "احفظ التعديل" : notify ? "سجّل الطلب وابعت الرسالة" : "سجّل الطلب"}</Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            إلغاء
          </Button>
        </div>
        )}
      </form>
    </div>
  );
}

function Label({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-muted">{text}</span>
      {children}
    </label>
  );
}
