import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, Link2, MapPin, MessageCircle, Pencil, Phone, Plus, Search, ShoppingBag, Truck, X } from "lucide-react";
import { api, CHANNEL_LABEL, PAYMENT_LABEL, type DarbFilter, type Order, type OrderFilters, type OrderStatus, type Payment } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { emptyOrder, OrderForm } from "../components/OrderForm";
import { OrdersExport } from "../components/OrdersExport";
import { DARB_STATUS, DarbSend } from "../components/DarbSend";
import { DarbLink, DarbTrackView } from "../components/DarbTrack";
import { ago, time } from "../format";

const STATUSES: { id: OrderStatus; label: string; tone: "warn" | "info" | "ok" | "muted" }[] = [
  { id: "new", label: "جديد، بدو تأكيد", tone: "warn" },
  { id: "confirmed", label: "متأكد", tone: "info" },
  { id: "delivered", label: "انسلّم", tone: "ok" },
  { id: "cancelled", label: "ملغي", tone: "muted" },
];

// Where the shipment is at Darb (filter chips), with the tone of its badge.
const DARB_FILTERS: { id: DarbFilter; label: string; tone: Tone }[] = [
  { id: "unsent", label: "ما انبعتت لدرب", tone: "warn" },
  { id: "waiting", label: "بانتظار المندوب", tone: "warn" },
  { id: "on_way", label: "عالطريق", tone: "info" },
  { id: "delayed", label: "متأخرة", tone: "bad" },
  { id: "delivered", label: "انسلمت، المبلغ عند درب", tone: "ok" },
  { id: "paid", label: "وصلنا المبلغ", tone: "ok" },
  { id: "returned", label: "راجعة / ملغية", tone: "bad" },
];
type Tone = "warn" | "info" | "ok" | "muted" | "bad";

const chip = (on: boolean, tone: Tone = "muted") =>
  clsx(
    "rounded-xl px-3 py-1.5 text-sm",
    on
      ? { warn: "bg-warn text-white", bad: "bg-bad text-white", ok: "bg-ok text-white", info: "bg-info text-white", muted: "bg-primary text-white" }[tone]
      : "bg-card-2 text-muted hover:text-fg",
  );

export function Orders() {
  const [f, setF] = useState<OrderFilters>({ status: "new" });
  const [search, setSearch] = useState("");
  const q = useQuery({
    queryKey: ["orders", f, search.trim()],
    queryFn: () => api.orders({ ...f, q: search.trim() }),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
  const [adding, setAdding] = useState(false);
  const set = (patch: Partial<OrderFilters>) => setF((cur) => ({ ...cur, ...patch }));
  const filtered = Boolean(f.status || f.darb || f.payment || f.source || search.trim());

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="الطلبات"
        subtitle="الطلبات يلي جمعها المساعد بعد ما أكّد الزبون الملخص، والطلبات يلي سجّلها الفريق. المساعد بيوقف على المحادثة، والفريق بيتواصل مع الزبون ليأكد الحجز."
        actions={
          <>
            <Button onClick={() => setAdding(true)}>
              <Plus size={16} /> طلب جديد
            </Button>
            <OrdersExport status={f.status} statusLabel={STATUSES.find((s) => s.id === f.status)?.label} />
          </>
        }
      />
      <ErrorNote error={q.error} />
      {q.data?.darb && q.data.unsent > 0 && f.darb !== "unsent" && (
        <button
          onClick={() => setF({ darb: "unsent" })}
          className="mb-4 flex w-full items-center gap-3 rounded-2xl border-2 border-warn bg-warn/10 p-4 text-start hover:bg-warn/15"
        >
          <AlertTriangle size={24} className="shrink-0 text-warn" />
          <span className="flex-1">
            <span className="block font-bold text-warn">
              <span className="num">{q.data.unsent}</span> {q.data.unsent === 1 ? "طلب متأكد لسا ما انبعت" : "طلبات لسا ما انبعتت"} لدرب السبيل
            </span>
            <span className="text-sm text-muted">ابعتها، أو إذا انبعتت من تطبيق درب اربطها برقم الشحنة.</span>
          </span>
          <span className="text-sm font-semibold text-warn">وريني ياهن ←</span>
        </button>
      )}

      <Card className="mb-4 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search size={16} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="دوّر: اسم، رقم، مدينة، رقم طلب أو شحنة"
              className="w-full rounded-xl border border-line bg-card-2 py-2 pe-3 ps-9 text-sm outline-none focus:border-primary"
            />
          </div>
          <select
            value={f.payment ?? ""}
            onChange={(e) => set({ payment: (e.target.value || undefined) as Payment | undefined })}
            className="rounded-xl border border-line bg-card-2 px-3 py-2 text-sm"
          >
            <option value="">كل طرق الدفع</option>
            <option value="cash">{PAYMENT_LABEL.cash}</option>
            <option value="transfer">{PAYMENT_LABEL.transfer}</option>
          </select>
          <select
            value={f.source ?? ""}
            onChange={(e) => set({ source: (e.target.value || undefined) as OrderFilters["source"] })}
            className="rounded-xl border border-line bg-card-2 px-3 py-2 text-sm"
          >
            <option value="">المساعد والفريق</option>
            <option value="ai">جمعه المساعد</option>
            <option value="team">سجّلو الفريق</option>
          </select>
          {filtered && (
            <button
              onClick={() => {
                setF({});
                setSearch("");
              }}
              className="flex items-center gap-1 text-sm text-muted hover:text-bad"
            >
              <X size={14} /> شيل الفلاتر
            </button>
          )}
          {q.data && <span className="ms-auto text-xs text-muted">{q.data.orders.length} طلب</span>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className="w-16 text-xs text-muted">الحالة</span>
          <button onClick={() => set({ status: undefined })} className={chip(!f.status)}>
            الكل
          </button>
          {STATUSES.map((s) => (
            <button key={s.id} onClick={() => set({ status: f.status === s.id ? undefined : s.id })} className={chip(f.status === s.id)}>
              {s.label} {q.data?.counts[s.id] ? <span className="num">({q.data.counts[s.id]})</span> : ""}
            </button>
          ))}
        </div>

        {q.data?.darb && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex w-16 items-center gap-1 text-xs text-muted">
              <Truck size={14} /> درب
            </span>
            <button onClick={() => set({ darb: undefined })} className={chip(!f.darb)}>
              الكل
            </button>
            {DARB_FILTERS.map((d) => (
              <button
                key={d.id}
                // Darb's filter looks at every status, unless the team picks one too.
                onClick={() => setF((cur) => ({ ...cur, darb: cur.darb === d.id ? undefined : d.id, status: cur.darb === d.id ? cur.status : undefined }))}
                className={chip(f.darb === d.id, d.tone)}
              >
                {d.label} <span className="num">({q.data?.darbCounts[d.id] ?? 0})</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {adding && <OrderForm initial={emptyOrder()} onClose={() => setAdding(false)} />}
      {q.data?.orders.length === 0 && (
        <Card>
          <Empty icon={ShoppingBag} text={filtered ? "ما في طلبات بهالفلاتر." : "ما في طلبات هون."} />
        </Card>
      )}
      <div className="flex flex-col gap-4">
        {q.data?.orders.map((o) => <OrderCard key={o.id} o={o} darb={q.data.darb} />)}
      </div>
    </div>
  );
}

// The shipment's state at Darb, in one line: its status, the latest event and the money.
const DARB_TONE: Record<string, Tone> = {
  pending: "warn",
  booked: "warn",
  processing: "info",
  "on-branch": "info",
  resent: "info",
  released: "info",
  delayed: "bad",
  completed: "ok",
  returning: "bad",
  returned: "bad",
  cancelled: "muted",
};

function DarbLine({ o, onTrack }: { o: Order; onTrack: () => void }) {
  const tone = DARB_TONE[o.darbStatus ?? ""] ?? "info";
  const tones: Record<Tone, string> = {
    warn: "border-warn/40 bg-warn/10",
    info: "border-info/40 bg-info/10",
    ok: "border-ok/40 bg-ok/10",
    bad: "border-bad/40 bg-bad/10",
    muted: "border-line bg-card-2",
  };
  return (
    <button onClick={onTrack} className={clsx("flex w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 text-start text-sm", tones[tone])}>
      <span className="flex items-center gap-1 font-semibold">
        <Truck size={16} /> درب السبيل
      </span>
      <Badge tone={tone}>{DARB_STATUS[o.darbStatus ?? ""] ?? o.darbStatus ?? "—"}</Badge>
      <span className="num text-xs text-muted" title="SH: رقم الشحنة لما انبعتت · الرقم بلا SH: رقم فرع درب بعد ما استلمها">
        {o.darbSh && o.darbSh !== o.darbRef ? `${o.darbSh} · فرع #${o.darbRef}` : `#${o.darbRef}`}
      </span>
      {o.darbEvent && (
        <span className="min-w-0 flex-1 truncate text-xs">
          {o.darbEvent}
          {o.darbEventAt && <span className="text-muted"> · {ago(o.darbEventAt)}</span>}
        </span>
      )}
      {o.darbPaidAt ? (
        <Badge tone="ok">وصلنا المبلغ</Badge>
      ) : o.darbStatus === "completed" ? (
        <Badge tone="warn">المبلغ عند درب</Badge>
      ) : null}
      <span className="text-xs text-primary">تتبع ←</span>
    </button>
  );
}

function OrderCard({ o, darb }: { o: Order; darb: boolean }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (status: OrderStatus) => api.setOrderStatus(o.id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["orders"] }),
  });
  const current = STATUSES.find((s) => s.id === o.status);
  const [editing, setEditing] = useState(false);
  const [shipping, setShipping] = useState(false);
  const [linking, setLinking] = useState(false);
  const [tracking, setTracking] = useState(false);
  const unsent = darb && !o.darbRef && (o.status === "new" || o.status === "confirmed");

  return (
    <Card className={clsx("flex flex-col gap-4", unsent && "ring-2 ring-warn")}>
      {unsent && (
        <div className="-mx-1 -mt-1 flex items-center gap-2 rounded-xl bg-warn/15 px-3 py-2 text-sm font-semibold text-warn">
          <AlertTriangle size={16} /> لسا ما انبعت لدرب السبيل
        </div>
      )}
      {editing && (
        <OrderForm
          orderId={o.id}
          initial={{ name: o.name, phone: o.phone, city: o.city, address: o.address, items: o.items, total: o.total, notes: o.notes, payment: o.payment }}
          onClose={() => setEditing(false)}
        />
      )}
      {shipping && <DarbSend order={o} onClose={() => setShipping(false)} />}
      {linking && <DarbLink order={o} onClose={() => setLinking(false)} />}
      {tracking && <DarbTrackView order={o} onClose={() => setTracking(false)} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="num text-lg font-bold">#{o.id}</span>
            <span className="text-lg font-semibold">{o.name}</span>
            {current && <Badge tone={current.tone}>{current.label}</Badge>}
            <Badge tone={o.source === "team" ? "primary" : "muted"}>{o.source === "team" ? "سجّلو الفريق" : "جمعه المساعد"}</Badge>
          </div>
          <div className="mt-1 text-xs text-muted">
            {time(o.createdAt)} · {ago(o.createdAt)} · {CHANNEL_LABEL[o.channel]}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {darb && !o.darbRef && o.status !== "cancelled" && o.status !== "delivered" && (
            <button onClick={() => setShipping(true)} className="flex items-center gap-1 rounded-xl bg-primary px-3 py-1.5 text-sm font-semibold text-white hover:brightness-110">
              <Truck size={16} /> ابعت لدرب السبيل
            </button>
          )}
          {darb && !o.darbRef && o.status !== "cancelled" && (
            <button onClick={() => setLinking(true)} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-sm hover:text-primary">
              <Link2 size={16} /> مبعوت من قبل؟ اربط برقم الشحنة
            </button>
          )}
          {darb && o.darbRef && (
            <button onClick={() => setTracking(true)} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-sm hover:text-primary">
              <MapPin size={16} /> تتبع
            </button>
          )}
          {darb && o.darbRef && o.status !== "delivered" && o.status !== "cancelled" && (
            <button onClick={() => setShipping(true)} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-sm hover:text-primary">
              <Truck size={16} /> عدّل شحنة درب السبيل
            </button>
          )}
          <button onClick={() => setEditing(true)} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-sm hover:text-primary">
            <Pencil size={16} /> تعديل
          </button>
          {o.channel !== "chatwoot" && (
            <Link href={`/inbox/${o.customer}`} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-sm hover:text-primary">
              <MessageCircle size={16} /> المحادثة
            </Link>
          )}
          <a href={`tel:${o.phone}`} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-sm hover:text-primary">
            <Phone size={16} /> اتصال
          </a>
        </div>
      </div>

      {o.darbRef && <DarbLine o={o} onTrack={() => setTracking(true)} />}

      <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <Field k="الرقم" v={<span className="ltr num">{o.phone}</span>} />
        <Field k="العنوان" v={`${o.city} - ${o.address}`} />
        <Field
          k="الطلب"
          v={
            <ul>
              {o.items.map((i, n) => (
                <li key={n}>
                  {i.quantity} × {[i.product, i.color].filter(Boolean).join(" · ")}
                  {i.size && (
                    <>
                      {" "}
                      · مقاس <span className="num">{i.size}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          }
        />
        <Field k="الاجمالي" v={<span className="font-semibold">{o.total}</span>} />
        {o.payment && (
          <Field k="الدفع" v={o.payment === "transfer" ? <span className="font-semibold text-info">{PAYMENT_LABEL.transfer}</span> : PAYMENT_LABEL.cash} />
        )}
        {o.notes && <Field k="ملاحظات" v={o.notes} wide />}
      </dl>

      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <span className="text-xs text-muted">غيّر الحالة:</span>
        {STATUSES.filter((s) => s.id !== o.status).map((s) => (
          <button
            key={s.id}
            onClick={() => update.mutate(s.id)}
            disabled={update.isPending}
            className="rounded-lg border border-line bg-card-2 px-3 py-1 text-xs hover:border-primary disabled:opacity-50"
          >
            {s.label}
          </button>
        ))}
        <ErrorNote error={update.error} />
      </div>
    </Card>
  );
}

function Field({ k, v, wide }: { k: string; v: React.ReactNode; wide?: boolean }) {
  return (
    <div className={clsx("rounded-xl bg-card-2 p-3", wide && "sm:col-span-2")}>
      <dt className="text-xs text-muted">{k}</dt>
      <dd className="mt-1">{v}</dd>
    </div>
  );
}
