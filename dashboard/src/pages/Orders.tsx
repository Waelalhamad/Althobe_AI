import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { MessageCircle, Pencil, Phone, Plus, ShoppingBag } from "lucide-react";
import { api, type Order, type OrderStatus } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { emptyOrder, OrderForm } from "../components/OrderForm";
import { OrdersExport } from "../components/OrdersExport";
import { ago, time } from "../format";

const STATUSES: { id: OrderStatus; label: string; tone: "warn" | "info" | "ok" | "muted" }[] = [
  { id: "new", label: "جديد، بدو تأكيد", tone: "warn" },
  { id: "confirmed", label: "متأكد", tone: "info" },
  { id: "delivered", label: "انسلّم", tone: "ok" },
  { id: "cancelled", label: "ملغي", tone: "muted" },
];

export function Orders() {
  const [status, setStatus] = useState<OrderStatus | undefined>("new");
  const q = useQuery({ queryKey: ["orders", status], queryFn: () => api.orders(status), refetchInterval: 10_000 });
  const [adding, setAdding] = useState(false);

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
            <OrdersExport status={status} statusLabel={STATUSES.find((s) => s.id === status)?.label} />
            {STATUSES.map((s) => (
              <button
                key={s.id}
                onClick={() => setStatus(s.id)}
                className={clsx("rounded-xl px-3 py-1.5 text-sm", status === s.id ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
              >
                {s.label} {q.data?.counts[s.id] ? `(${q.data.counts[s.id]})` : ""}
              </button>
            ))}
            <button
              onClick={() => setStatus(undefined)}
              className={clsx("rounded-xl px-3 py-1.5 text-sm", !status ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg")}
            >
              الكل
            </button>
          </>
        }
      />
      <ErrorNote error={q.error} />
      {adding && <OrderForm initial={emptyOrder()} onClose={() => setAdding(false)} />}
      {q.data?.orders.length === 0 && (
        <Card>
          <Empty icon={ShoppingBag} text="ما في طلبات هون." />
        </Card>
      )}
      <div className="flex flex-col gap-4">
        {q.data?.orders.map((o) => <OrderCard key={o.id} o={o} />)}
      </div>
    </div>
  );
}

function OrderCard({ o }: { o: Order }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (status: OrderStatus) => api.setOrderStatus(o.id, status),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["orders"] }),
  });
  const current = STATUSES.find((s) => s.id === o.status);
  const [editing, setEditing] = useState(false);

  return (
    <Card className="flex flex-col gap-4">
      {editing && (
        <OrderForm
          orderId={o.id}
          initial={{ name: o.name, phone: o.phone, city: o.city, address: o.address, items: o.items, total: o.total, notes: o.notes }}
          onClose={() => setEditing(false)}
        />
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="num text-lg font-bold">#{o.id}</span>
            <span className="text-lg font-semibold">{o.name}</span>
            {current && <Badge tone={current.tone}>{current.label}</Badge>}
            <Badge tone={o.source === "team" ? "primary" : "muted"}>{o.source === "team" ? "سجّلو الفريق" : "جمعه المساعد"}</Badge>
          </div>
          <div className="mt-1 text-xs text-muted">
            {time(o.createdAt)} · {ago(o.createdAt)} · {o.channel === "whatsapp" ? "واتساب" : "Instagram / Messenger"}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => setEditing(true)} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-sm hover:text-primary">
            <Pencil size={16} /> تعديل
          </button>
          {o.channel === "whatsapp" && (
            <Link href={`/inbox/${o.customer}`} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-sm hover:text-primary">
              <MessageCircle size={16} /> المحادثة
            </Link>
          )}
          <a href={`tel:${o.phone}`} className="flex items-center gap-1 rounded-xl bg-card-2 px-3 py-1.5 text-sm hover:text-primary">
            <Phone size={16} /> اتصال
          </a>
        </div>
      </div>

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
