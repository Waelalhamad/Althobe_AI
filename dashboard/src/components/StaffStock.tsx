// The Libya employee's own stock: per product and color, each size with − / + buttons. His count alone: the AI,
// the orders and the team's stock page never read or change it. Used on his phone page and on the team's page.
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Boxes, Minus, Plus, Trash2, X } from "lucide-react";
import { api, type StaffStockRow } from "../api";
import { Button, Empty, ErrorNote } from "./ui";
import { ago, num } from "../format";

const inputClass = "rounded-xl border border-line bg-card-2 px-4 py-3 outline-none focus:border-primary";

export function useStaffStock(log = 50) {
  return useQuery({ queryKey: ["staff-stock", log], queryFn: () => api.staffStock(log), refetchInterval: 60_000 });
}

export function StaffStock() {
  const q = useStaffStock();
  const rows = q.data?.rows ?? [];
  const products = [...new Set(rows.map((r) => r.product))];
  const [picked, setPicked] = useState<string>();
  const [adding, setAdding] = useState(false);
  const product = picked && products.includes(picked) ? picked : products[0];
  const mine = rows.filter((r) => r.product === product);
  const colors = [...new Set(mine.map((r) => r.color))];
  const total = mine.reduce((n, r) => n + r.quantity, 0);

  return (
    <div className="flex flex-col gap-4">
      <ErrorNote error={q.error} />
      {products.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {products.map((p) => (
            <button
              key={p}
              onClick={() => setPicked(p)}
              className={clsx("shrink-0 rounded-xl px-4 py-2.5 text-sm font-semibold", p === product ? "bg-primary text-white" : "bg-card-2 text-muted")}
            >
              {p}
            </button>
          ))}
        </div>
      )}
      {product && (
        <div className="flex items-baseline justify-between px-1">
          <h2 className="text-lg font-bold">{product}</h2>
          <span className="text-sm text-muted">
            المجموع <b className="num text-fg">{num(total)}</b> قطعة
          </span>
        </div>
      )}
      {colors.map((color) => (
        <ColorCard key={`${product}|${color}`} product={product!} color={color} rows={mine.filter((r) => r.color === color)} />
      ))}
      {!rows.length && !q.isLoading && <Empty icon={Boxes} text="لسا ما في بضاعة. ضيف أول صنف." />}
      {adding ? (
        <AddForm products={products} defaultProduct={product} onDone={() => setAdding(false)} />
      ) : (
        <Button variant="ghost" onClick={() => setAdding(true)} className="py-3">
          <Plus size={18} /> ضيف صنف أو لون أو مقاس
        </Button>
      )}
    </div>
  );
}

function ColorCard({ product, color, rows }: { product: string; color: string; rows: StaffStockRow[] }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeStaffStock({ product, color }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["staff-stock"] }),
  });
  const updated = Math.max(...rows.map((r) => r.updatedAt));
  return (
    <div className="glass flex flex-col gap-2 rounded-2xl p-4">
      <div className="flex items-center gap-2">
        <h3 className="font-bold">{color}</h3>
        <span className="num text-sm text-muted">{num(rows.reduce((n, r) => n + r.quantity, 0))} قطعة</span>
        <span className="ms-auto text-xs text-muted">{ago(updated)}</span>
        <button
          onClick={() => window.confirm(`نشيل ${color} من ${product}؟`) && remove.mutate()}
          className="text-muted hover:text-bad"
          aria-label={`شيل ${color}`}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <ErrorNote error={remove.error} />
      {rows.map((r) => (
        <Cell key={r.size} row={r} />
      ))}
    </div>
  );
}

// One size: − / + change the number on screen at once and it's saved a moment after the last tap (one line in the log).
function Cell({ row }: { row: StaffStockRow }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(row.quantity);
  const [typing, setTyping] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = useMutation({
    mutationFn: (quantity: number) => api.setStaffStock({ product: row.product, color: row.color, size: row.size, quantity }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["staff-stock"] }),
  });
  // Follow the server unless a change is waiting to be saved.
  useEffect(() => {
    if (!timer.current && !save.isPending) setValue(row.quantity);
  }, [row.quantity]); // eslint-disable-line react-hooks/exhaustive-deps
  // Leaving the screen (another product, another tab) still saves the last tap.
  const pending = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (pending.current !== undefined) void api.setStaffStock({ product: row.product, color: row.color, size: row.size, quantity: pending.current });
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const change = (next: number) => {
    const v = Math.max(0, next);
    setValue(v);
    clearTimeout(timer.current);
    pending.current = v;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      pending.current = undefined;
      if (v !== row.quantity) save.mutate(v);
    }, 900);
  };

  return (
    <div className="flex items-center gap-3">
      <span className="num w-20 font-semibold">{row.size}</span>
      <button onClick={() => change(value - 1)} className="grid size-11 place-items-center rounded-xl bg-card-2 active:scale-90" aria-label="ناقص">
        <Minus size={18} />
      </button>
      <input
        inputMode="numeric"
        value={typing ?? String(value)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setTyping(e.target.value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, ""))}
        onBlur={() => {
          if (typing !== undefined && typing !== "") change(Number(typing));
          setTyping(undefined);
        }}
        className={clsx(
          "num w-16 rounded-xl border bg-card-2 py-2 text-center text-xl font-bold outline-none focus:border-primary",
          value === 0 ? "border-bad/50 text-bad" : "border-line",
        )}
        aria-label={`${row.color} ${row.size}`}
      />
      <button onClick={() => change(value + 1)} className="grid size-11 place-items-center rounded-xl bg-card-2 active:scale-90" aria-label="زايد">
        <Plus size={18} />
      </button>
      {save.isError && <span className="text-xs text-bad">ما انحفظ</span>}
    </div>
  );
}

function AddForm({ products, defaultProduct, onDone }: { products: string[]; defaultProduct?: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const [product, setProduct] = useState(defaultProduct ?? "");
  const [color, setColor] = useState("");
  const [sizes, setSizes] = useState("");
  const [quantity, setQuantity] = useState("");
  const list = sizes
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .split(/[\s,،]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const save = useMutation({
    mutationFn: async () => {
      for (const size of list.length ? list : ["ستاندرد"]) {
        await api.setStaffStock({ product: product.trim(), color: color.trim(), size, quantity: Number(quantity) || 0 });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["staff-stock"] });
      onDone();
    },
  });
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (product.trim() && color.trim()) save.mutate();
      }}
      className="glass flex flex-col gap-3 rounded-2xl p-4"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-bold">صنف جديد</h3>
        <button type="button" onClick={onDone} className="text-muted" aria-label="إلغاء">
          <X size={18} />
        </button>
      </div>
      <input list="staff-products" value={product} onChange={(e) => setProduct(e.target.value)} placeholder="المنتج (مثلاً الفرو)" className={inputClass} />
      <datalist id="staff-products">
        {products.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
      <input value={color} onChange={(e) => setColor(e.target.value)} placeholder="اللون" className={inputClass} />
      <input value={sizes} onChange={(e) => setSizes(e.target.value)} placeholder="المقاسات: 56 58 60 (فاضي = مقاس واحد)" className={inputClass} />
      <input
        inputMode="numeric"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, ""))}
        placeholder="العدد لكل مقاس (فيك تعدّلو بعدين)"
        className={clsx(inputClass, "num")}
      />
      <ErrorNote error={save.error} />
      <Button disabled={!product.trim() || !color.trim() || save.isPending} className="py-3">
        {save.isPending ? "جاري الحفظ…" : "ضيف"}
      </Button>
    </form>
  );
}
