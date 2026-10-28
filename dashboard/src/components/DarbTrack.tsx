import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Link2, Loader2, MapPin, RotateCcw, Truck, X } from "lucide-react";
import { api, ApiError, type DarbTracked, type MoneyStage, type Order } from "../api";
import { Badge, Button, ErrorNote } from "./ui";
import { DARB_STATUS, DarbSend } from "./DarbSend";
import { ago, num, time } from "../format";

const inputClass = "w-full rounded-xl border border-line bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary";

export const STAGE: Record<MoneyStage, { label: string; tone: "ok" | "warn" | "info" | "bad" | "muted" }> = {
  paid: { label: "وصلتنا", tone: "ok" },
  at_darb: { label: "انسلمت، المبلغ عند درب", tone: "warn" },
  on_way: { label: "عالطريق", tone: "info" },
  returned: { label: "راجعة", tone: "bad" },
  cancelled: { label: "ملغية", tone: "muted" },
};

export function Modal({ title, onClose, children }: { title: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="my-8 flex w-full max-w-lg flex-col gap-3 rounded-2xl border border-line bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="سكّر" className="text-muted hover:text-fg">
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ShipmentLine({ s }: { s: DarbTracked }) {
  return (
    <div className="text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="num font-semibold">#{s.reference}</span>
        {s.sh && s.sh !== s.reference && <span className="num text-xs text-muted">({s.sh})</span>}
        <Badge tone={STAGE[s.stage].tone}>{DARB_STATUS[s.status] ?? s.status}</Badge>
      </div>
      <div className="mt-1 text-xs text-muted">
        {s.name} · <span className="ltr num">{s.phone.replace(/^\+218/, "0")}</span> · {s.city}/{s.area} · <span className="num">{num(s.amount)}</span> د ·{" "}
        {time(s.createdAt)}
      </div>
    </div>
  );
}

// An order the team sent to Darb by hand (before the integration): its shipment's number links them, then it's tracked.
export function DarbLink({ order, onClose }: { order: Order; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [number, setNumber] = useState("");
  const [mismatch, setMismatch] = useState<string>();
  const matches = useQuery({ queryKey: ["darb-matches", order.id], queryFn: () => api.darbMatches(order.id) });
  const link = useMutation({
    mutationFn: ({ n, force }: { n: string; force?: boolean }) => api.linkDarb(order.id, n, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      onClose();
    },
    onError: (error) => setMismatch(error instanceof ApiError && error.status === 409 ? error.message : undefined),
  });

  return (
    <Modal
      title={
        <>
          <Link2 size={20} className="text-primary" /> اربط الطلب #{order.id} بشحنة درب السبيل
        </>
      }
      onClose={onClose}
    >
      <p className="text-sm text-muted">إذا بعتّو الطلب لدرب السبيل من تطبيقهم، حط رقم الشحنة (الرقم الجديد أو رقم SH) ليصير يتتبع هون.</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setMismatch(undefined);
          link.mutate({ n: number });
        }}
      >
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="مثلاً 2719364 أو SH2457769"
          className={clsx(inputClass, "ltr num")}
          autoFocus
          required
        />
        <Button type="submit" disabled={link.isPending || !number.trim()}>
          {link.isPending ? <Loader2 size={16} className="animate-spin" /> : <Link2 size={16} />} اربط
        </Button>
      </form>
      {mismatch ? (
        <div className="flex flex-col gap-2 rounded-xl bg-warn/10 p-3 text-sm text-warn">
          {mismatch}
          <div>
            <Button variant="ghost" onClick={() => link.mutate({ n: number, force: true })} disabled={link.isPending}>
              اي، اربطها
            </Button>
          </div>
        </div>
      ) : (
        <ErrorNote error={link.error} />
      )}

      {matches.data && matches.data.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-line pt-3">
          <div className="text-xs text-muted">شحنات بدرب لنفس رقم الزبون، ما إلها طلب هون:</div>
          {matches.data.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-2 rounded-xl bg-card-2 p-3">
              <ShipmentLine s={s} />
              <Button variant="ghost" onClick={() => link.mutate({ n: s.reference })} disabled={link.isPending}>
                هي
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// Where the shipment is: Darb's timeline, fresh, and its money.
export function DarbTrackView({ order, onClose }: { order: Order; onClose: () => void }) {
  const queryClient = useQueryClient();
  const track = useQuery({
    queryKey: ["darb-track", order.id],
    queryFn: () => api.trackDarb(order.id),
    retry: (n, error) => !(error instanceof ApiError && error.status === 410) && n < 2,
  });
  const unlink = useMutation({
    mutationFn: () => api.unlinkDarb(order.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orders"] });
      onClose();
    },
  });
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  // Darb doesn't have the shipment any more (deleted by mistake): sent again with the same data, a new number.
  const gone = track.error instanceof ApiError && track.error.status === 410;
  const [resending, setResending] = useState(false);
  const s = track.data;

  return (
    <Modal
      title={
        <>
          <Truck size={20} className="text-primary" /> تتبع الطلب #{order.id}
        </>
      }
      onClose={onClose}
    >
      {track.isLoading && (
        <div className="flex items-center gap-2 py-6 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> عم جيب الشحنة من درب السبيل…
        </div>
      )}
      <ErrorNote error={track.error} />
      {gone && (
        <div className="flex flex-col gap-2 rounded-xl bg-card-2 p-3 text-sm">
          <p>إذا انحذفت بالغلط: ابعتها من جديد لدرب. بتفتح بنفس البيانات (المدينة والمنطقة والعنوان والمبلغ والدفع)، شيك عليهن وابعت، ودرب بيعطيها رقم جديد.</p>
          <Button onClick={() => setResending(true)} className="self-start">
            <RotateCcw size={16} /> ابعتها من جديد لدرب
          </Button>
        </div>
      )}
      {resending && <DarbSend order={order} resend onClose={() => setResending(false)} />}
      {s && (
        <>
          <div className="rounded-xl bg-card-2 p-3">
            <ShipmentLine s={s} />
          </div>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl bg-card-2 p-3">
              <div className="text-xs text-muted">لإلنا (بعد التوصيل)</div>
              <div className="num mt-1 font-semibold">{num(s.amount)} د</div>
            </div>
            <div className="rounded-xl bg-card-2 p-3">
              <div className="text-xs text-muted">المبلغ</div>
              <div className="mt-1">
                <Badge tone={STAGE[s.stage].tone}>{STAGE[s.stage].label}</Badge>
                {s.paidAt && <div className="mt-1 text-xs text-muted">{time(s.paidAt)}{s.payoutRef && ` · ${s.payoutRef}`}</div>}
              </div>
            </div>
          </div>
          <ol className="flex flex-col gap-0 border-s-2 border-line ps-4">
            {[...s.timeline].reverse().map((t, n) => (
              <li key={n} className="relative pb-3">
                <span className={clsx("absolute -start-[1.4rem] top-1.5 size-2.5 rounded-full", n === 0 ? "bg-primary" : "bg-line")} />
                <div className={clsx("text-sm", n === 0 && "font-semibold")}>{t.text}</div>
                <div className="text-xs text-muted">
                  {time(t.at)} · {ago(t.at)}
                </div>
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-between border-t border-line pt-3 text-xs text-muted">
            <span className="flex items-center gap-1">
              <MapPin size={14} /> {s.city} / {s.area}
            </span>
            {confirmUnlink ? (
              <span className="flex items-center gap-2">
                فك الربط بس (الشحنة بتضل بدرب)؟
                <Button variant="ghost" onClick={() => unlink.mutate()} disabled={unlink.isPending}>
                  اي
                </Button>
              </span>
            ) : (
              <button onClick={() => setConfirmUnlink(true)} className="hover:text-bad">
                مش هي الشحنة؟ فك الربط
              </button>
            )}
          </div>
          <ErrorNote error={unlink.error} />
        </>
      )}
    </Modal>
  );
}
