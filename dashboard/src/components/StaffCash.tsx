// The Libya employee's cash: big "received" / "paid" buttons and the log. Used on his phone page and on the team's page.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDownCircle, ArrowUpCircle, Undo2, Wallet, X } from "lucide-react";
import { api, type CashRow, type StaffCash } from "../api";
import { Badge, Button, Empty, ErrorNote } from "./ui";
import { time } from "../format";

// Dinars with up to 3 decimals (Libyan dirhams), Western digits.
const nf = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });
export const amount = (n: number) => nf.format(n);
export const lyd = (n: number) => `${amount(n)} د.ل`;

// Phones often type Arabic digits and the Arabic decimal mark.
const latin = (t: string) =>
  t
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[٫,]/g, ".")
    .replace(/[^\d.]/g, "");

export function CashButtons({ kinds }: { kinds: StaffCash["kinds"] }) {
  const [open, setOpen] = useState<"in" | "out">();
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={() => setOpen("in")}
          className="flex flex-col items-center gap-1 rounded-2xl bg-ok/15 py-5 text-lg font-bold text-ok active:scale-95"
        >
          <ArrowDownCircle size={30} />
          استلمت
        </button>
        <button
          onClick={() => setOpen("out")}
          className="flex flex-col items-center gap-1 rounded-2xl bg-bad/15 py-5 text-lg font-bold text-bad active:scale-95"
        >
          <ArrowUpCircle size={30} />
          دفعت / سلّمت
        </button>
      </div>
      {open && <CashForm direction={open} kinds={kinds[open].filter((k) => k !== "تصحيح")} onClose={() => setOpen(undefined)} />}
    </>
  );
}

function CashForm({ direction, kinds, onClose }: { direction: "in" | "out"; kinds: string[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [kind, setKind] = useState("");
  const [note, setNote] = useState("");
  const value = Number(typed);
  const save = useMutation({
    mutationFn: () => api.addStaffCash({ direction, amount: value, kind, note }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["staff-cash"] });
      onClose();
    },
  });
  const isIn = direction === "in";
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center overflow-y-auto bg-black/60 sm:items-center" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (value > 0 && kind) save.mutate();
        }}
        className="flex w-full max-w-md flex-col gap-4 rounded-t-3xl bg-card p-5 pb-[max(2rem,env(safe-area-inset-bottom))] sm:rounded-3xl"
      >
        <div className="flex items-center justify-between">
          <h2 className={clsx("text-xl font-bold", isIn ? "text-ok" : "text-bad")}>{isIn ? "استلمت مصاري" : "دفعت / سلّمت مصاري"}</h2>
          <button type="button" onClick={onClose} className="text-muted" aria-label="إغلاق">
            <X />
          </button>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-sm text-muted">المبلغ بالدينار</span>
          <input
            autoFocus
            inputMode="decimal"
            value={typed}
            onChange={(e) => setTyped(latin(e.target.value))}
            placeholder="0"
            className="ltr num rounded-2xl border border-line bg-card-2 px-4 py-4 text-center text-3xl font-bold outline-none focus:border-primary"
          />
        </label>
        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted">{isIn ? "من وين؟" : "لشو؟"}</span>
          <div className="flex flex-wrap gap-2">
            {kinds.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={clsx(
                  "rounded-xl px-4 py-3 text-base",
                  kind === k ? (isIn ? "bg-ok text-white" : "bg-bad text-white") : "bg-card-2 text-fg",
                )}
              >
                {k}
              </button>
            ))}
          </div>
        </div>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={isIn ? "ملاحظة: رقم التحويل، اسم الزبون… (اختياري)" : "ملاحظة: لمين، لشو… (اختياري)"}
          className="rounded-xl border border-line bg-card-2 px-4 py-3 outline-none focus:border-primary"
        />
        <ErrorNote error={save.error} />
        <Button disabled={!(value > 0) || !kind || save.isPending} className="py-4 text-lg">
          {save.isPending ? "جاري الحفظ…" : `احفظ ${value > 0 ? lyd(value) : ""}`}
        </Button>
        <p className="text-center text-xs text-muted">الحركة ما بتنمسح. إذا غلطت، كبسة «اعكسها» جنبها بالسجل بتلغيها.</p>
      </form>
    </div>
  );
}

// The log, newest first. «اعكسها» cancels a line with a correction (the line stays, crossed out).
// mineOnly: the employee undoes only the lines he wrote (the team undoes any).
export function CashList({ rows, showWho, mineOnly }: { rows: CashRow[]; showWho?: boolean; mineOnly?: boolean }) {
  const queryClient = useQueryClient();
  const undo = useMutation({
    mutationFn: (id: number) => api.undoStaffCash(id),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["staff-cash"] }),
  });
  if (!rows.length) return <Empty icon={Wallet} text="لسا ما في حركات." />;
  return (
    <>
      <ErrorNote error={undo.error} />
      <ul className="flex flex-col divide-y divide-line">
        {rows.map((r) => {
          const undone = r.undoneBy !== null;
          const correction = r.undoes !== null;
          return (
            <li key={r.id} className={clsx("flex items-center gap-3 py-3", undone && "opacity-50")}>
              <span
                className={clsx(
                  "grid size-9 shrink-0 place-items-center rounded-full",
                  correction ? "bg-card-2 text-muted" : r.direction === "in" ? "bg-ok/15 text-ok" : "bg-bad/15 text-bad",
                )}
              >
                {correction ? <Undo2 size={18} /> : r.direction === "in" ? <ArrowDownCircle size={18} /> : <ArrowUpCircle size={18} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 font-semibold">
                  <span className={clsx(undone && "line-through")}>{r.kind}</span>
                  {undone && <Badge>انعكست</Badge>}
                  {showWho && r.byRole === "admin" && <Badge tone="info">الإدارة</Badge>}
                </div>
                {r.note && <div className="break-words text-sm text-muted">{r.note}</div>}
                <div className="num text-xs text-muted">
                  <span className="ltr">{time(r.at)}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1">
                <span className={clsx("num ltr text-lg font-bold", r.direction === "in" ? "text-ok" : "text-bad", undone && "line-through")}>
                  {r.direction === "in" ? "+" : "−"}
                  {amount(r.amount)}
                </span>
                {!correction && !undone && (!mineOnly || r.byRole === "staff") && (
                  <button
                    onClick={() =>
                      window.confirm(`نعكس «${r.kind}» ${lyd(r.amount)}؟ بتنسجل حركة تصحيح بعكسها والرصيد بيرجع متل قبلها.`) && undo.mutate(r.id)
                    }
                    disabled={undo.isPending}
                    className="flex items-center gap-1 py-1 text-xs text-muted hover:text-bad"
                  >
                    <Undo2 size={12} /> اعكسها
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
