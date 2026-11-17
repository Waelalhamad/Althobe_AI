// The opening count (جرد افتتاحي) of the Libya employee: the cash he holds and the stock he has when the log starts.
// Each is made once (the server refuses a second). A wrong cash count is undone with «اعكسها» and made again;
// a wrong stock number is fixed with − / + afterwards (the count itself stays as it was made).
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Minus, Plus, Trash2 } from "lucide-react";
import { api, type OpeningItem, type StaffStockRow } from "../api";
import { Badge, Button, Card, ErrorNote } from "./ui";
import { latin, lyd } from "./StaffCash";
import { num, time } from "../format";

const inputClass = "rounded-xl border border-line bg-card-2 px-4 py-3 outline-none focus:border-primary";
const western = (t: string) => t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

export function useOpening() {
  return useQuery({ queryKey: ["staff-opening"], queryFn: api.staffOpening });
}

const refresh = (queryClient: ReturnType<typeof useQueryClient>) => {
  void queryClient.invalidateQueries({ queryKey: ["staff-opening"] });
  void queryClient.invalidateQueries({ queryKey: ["staff-cash"] });
  void queryClient.invalidateQueries({ queryKey: ["staff-stock"] });
};

// "How much money do you hold right now?" — shown until the opening cash is made.
export function OpeningCash() {
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const value = Number(typed);
  const save = useMutation({
    mutationFn: () => api.setOpeningCash(value),
    onSuccess: () => refresh(queryClient),
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (typed !== "" && window.confirm(`نعتمد الجرد الافتتاحي: معك هلق ${lyd(value)}؟`)) save.mutate();
      }}
      className="glass flex flex-col gap-3 rounded-2xl border border-primary/40 p-4"
    >
      <h2 className="flex items-center gap-2 font-bold">
        <ClipboardList size={20} className="text-primary" /> الجرد الافتتاحي للمصاري
      </h2>
      <p className="text-sm text-muted">عدّ المصاري يلي معك هلق واكتب المجموع. هاد بيكون أول رصيد، وكل حركة بعدها بتنحسب منو. إذا ما معك شي اكتب 0.</p>
      <input
        inputMode="decimal"
        value={typed}
        onChange={(e) => setTyped(latin(e.target.value))}
        placeholder="المبلغ بالدينار"
        className="ltr num rounded-2xl border border-line bg-card-2 px-4 py-3 text-center text-2xl font-bold outline-none focus:border-primary"
      />
      <ErrorNote error={save.error} />
      <Button disabled={typed === "" || !Number.isFinite(value) || save.isPending} className="py-3">
        {save.isPending ? "جاري الحفظ…" : typed === "" ? "اعتمد" : `اعتمد ${lyd(value)}`}
      </Button>
    </form>
  );
}

const DRAFT = "staff-opening-draft";
const key = (c: OpeningItem) => `${c.product}|${c.color}|${c.size}`;
const same = (a: string, b: string) => a.trim().replace(/\s+/g, " ") === b.trim().replace(/\s+/g, " ");

// The stock count, written on the phone first (kept on it if the page closes) and saved all at once.
// It starts from what is already in his stock, if anything.
export function OpeningStock({ current }: { current: StaffStockRow[] }) {
  const queryClient = useQueryClient();
  const [cells, setCells] = useState<OpeningItem[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT) ?? "null") as OpeningItem[] | null;
      if (Array.isArray(saved) && saved.length) return saved;
    } catch {
      // a broken draft starts over
    }
    return current.map(({ product, color, size, quantity }) => ({
      product,
      color,
      size,
      quantity,
    }));
  });
  useEffect(() => localStorage.setItem(DRAFT, JSON.stringify(cells)), [cells]);

  const [product, setProduct] = useState("");
  const [color, setColor] = useState("");
  const [sizes, setSizes] = useState("");
  const products = [...new Set(cells.map((c) => c.product))];
  const colorsOf = [...new Set(cells.filter((c) => same(c.product, product)).map((c) => c.color))];

  const add = () => {
    const list = western(sizes)
      .split(/[\s,،]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const fresh = [...new Set(list.length ? list : ["ستاندرد"])]
      .map((size) => ({
        product: product.trim().replace(/\s+/g, " "),
        color: color.trim().replace(/\s+/g, " "),
        size,
        quantity: 0,
      }))
      .filter((c) => !cells.some((d) => key(d) === key(c)));
    setCells([...cells, ...fresh]);
    setColor("");
    setSizes("");
  };
  const setQty = (k: string, quantity: number) => setCells(cells.map((c) => (key(c) === k ? { ...c, quantity: Math.max(0, quantity) } : c)));
  const dropColor = (p: string, col: string) => setCells(cells.filter((c) => !(c.product === p && c.color === col)));

  const pieces = cells.reduce((n, c) => n + c.quantity, 0);
  const save = useMutation({
    mutationFn: () => api.setOpeningStock(cells),
    onSuccess: () => {
      localStorage.removeItem(DRAFT);
      refresh(queryClient);
    },
  });
  const groups = [...new Set(cells.map((c) => `${c.product}|${c.color}`))];

  return (
    <div className="flex flex-col gap-4">
      <div className="glass flex flex-col gap-2 rounded-2xl border border-primary/40 p-4">
        <h2 className="flex items-center gap-2 font-bold">
          <ClipboardList size={20} className="text-primary" /> الجرد الافتتاحي للمخزون
        </h2>
        <p className="text-sm text-muted">
          عدّ البضاعة يلي عندك هلق: ضيف كل منتج ولون مع مقاساتو، وحط العدد لكل مقاس. الشغل بينحفظ عالتلفون لحتى تخلّص، وبس تكبس «اعتمد الجرد» بينسجل كلو
          مرة وحدة.
        </p>
      </div>

      {groups.map((g) => {
        const [p, col] = g.split("|");
        const rows = cells.filter((c) => c.product === p && c.color === col);
        return (
          <div key={g} className="glass flex flex-col gap-2 rounded-2xl p-4">
            <div className="flex items-center gap-2">
              <h3 className="font-bold">
                {p} · {col}
              </h3>
              <span className="num text-sm text-muted">{num(rows.reduce((n, c) => n + c.quantity, 0))} قطعة</span>
              <button type="button" onClick={() => dropColor(p, col)} className="ms-auto text-muted hover:text-bad" aria-label={`شيل ${col}`}>
                <Trash2 size={16} />
              </button>
            </div>
            {rows.map((c) => (
              <div key={c.size} className="flex items-center gap-3">
                <span className="num w-20 font-semibold">{c.size}</span>
                <button
                  type="button"
                  onClick={() => setQty(key(c), c.quantity - 1)}
                  className="grid size-11 place-items-center rounded-xl bg-card-2 active:scale-90"
                  aria-label="ناقص"
                >
                  <Minus size={18} />
                </button>
                <input
                  inputMode="numeric"
                  value={String(c.quantity)}
                  onFocus={(e) => e.target.select()}
                  onChange={(e) => setQty(key(c), Number(western(e.target.value).replace(/\D/g, "")) || 0)}
                  className="num w-16 rounded-xl border border-line bg-card-2 py-2 text-center text-xl font-bold outline-none focus:border-primary"
                  aria-label={`${c.color} ${c.size}`}
                />
                <button
                  type="button"
                  onClick={() => setQty(key(c), c.quantity + 1)}
                  className="grid size-11 place-items-center rounded-xl bg-card-2 active:scale-90"
                  aria-label="زايد"
                >
                  <Plus size={18} />
                </button>
              </div>
            ))}
          </div>
        );
      })}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (product.trim() && color.trim()) add();
        }}
        className="glass flex flex-col gap-3 rounded-2xl p-4"
      >
        <h3 className="font-bold">ضيف منتج / لون</h3>
        <input
          list="opening-products"
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          placeholder="المنتج (مثلاً الفرو)"
          className={inputClass}
        />
        <datalist id="opening-products">
          {products.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
        <input list="opening-colors" value={color} onChange={(e) => setColor(e.target.value)} placeholder="اللون" className={inputClass} />
        <datalist id="opening-colors">
          {colorsOf.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <input value={sizes} onChange={(e) => setSizes(e.target.value)} placeholder="المقاسات: 56 58 60 (فاضي = مقاس واحد)" className={inputClass} />
        <Button variant="ghost" disabled={!product.trim() || !color.trim()} className="py-3">
          <Plus size={18} /> ضيف
        </Button>
      </form>

      <ErrorNote error={save.error} />
      <Button
        onClick={() =>
          window.confirm(
            cells.length
              ? `نعتمد الجرد الافتتاحي: ${num(groups.length)} لون، ${num(pieces)} قطعة؟ بعدها الأعداد بتتغيّر بـ − و + بس.`
              : "ما عندك ولا قطعة هلق؟ منعتمد الجرد فاضي.",
          ) && save.mutate()
        }
        disabled={save.isPending}
        className="py-4 text-lg"
      >
        {save.isPending ? "جاري الحفظ…" : `اعتمد الجرد (${num(pieces)} قطعة)`}
      </Button>
    </div>
  );
}

// For the team: what the opening count said.
export function OpeningCashSummary() {
  const o = useOpening().data;
  if (!o?.cash) return null;
  return (
    <p className="text-sm text-muted">
      الجرد الافتتاحي للمصاري: <b className="num text-fg">{lyd(o.cash.amount)}</b> · <span className="ltr num">{time(o.cash.at)}</span>
      {o.cash.byRole === "admin" && <> · سجّلتو الإدارة</>}
    </p>
  );
}

export function OpeningStockSummary() {
  const s = useOpening().data?.stock;
  if (!s) return null;
  const groups = [...new Set(s.items.map((c) => `${c.product}|${c.color}`))];
  return (
    <Card>
      <h3 className="mb-1 flex items-center gap-2 font-semibold">
        <ClipboardList size={18} /> الجرد الافتتاحي للمخزون
      </h3>
      <p className="mb-2 text-sm text-muted">
        <span className="ltr num">{time(s.at)}</span> · <span className="num">{num(s.items.reduce((n, c) => n + c.quantity, 0))}</span> قطعة
        {s.byRole === "admin" && <> · سجّلتو الإدارة</>}
      </p>
      {!s.items.length && <p className="text-sm text-muted">انعتمد فاضي: ما كان عندو بضاعة.</p>}
      <ul className="flex flex-col divide-y divide-line text-sm">
        {groups.map((g) => {
          const [p, col] = g.split("|");
          const rows = s.items.filter((c) => c.product === p && c.color === col);
          return (
            <li key={g} className="flex flex-wrap items-center gap-2 py-2">
              <span className="font-semibold">
                {p} · {col}
              </span>
              {rows.map((c) => (
                <Badge key={c.size}>
                  <span className="num">
                    {c.size}: {c.quantity}
                  </span>
                </Badge>
              ))}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
