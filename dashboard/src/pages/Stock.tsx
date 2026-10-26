import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Boxes, Plus, Save, Trash2, X } from "lucide-react";
import { api, type StockProduct } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { ago, num } from "../format";

const inputClass = "rounded-xl border border-line bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary";

// A product's table while the team edits it: quantities as typed, by "color|size".
type Draft = { product: string; colors: string[]; sizes: string[]; q: Record<string, string> };

const key = (color: string, size: string) => `${color}|${size}`;

function toDraft(p: StockProduct): Draft {
  return { product: p.product, colors: p.colors, sizes: p.sizes, q: Object.fromEntries(p.cells.map((c) => [key(c.color, c.size), String(c.quantity)])) };
}

export function Stock() {
  const q = useQuery({ queryKey: ["stock"], queryFn: api.stock });
  const [adding, setAdding] = useState<Draft>();

  const tracked = q.data?.products ?? [];
  const untracked = (q.data?.suggestions ?? []).filter((s) => !tracked.some((p) => p.product === s.product));

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <PageHeader
        title="المخزون"
        subtitle="شو باقي من كل لون ومقاس. كل طلب بينقّص من هون لحالو، والطلب الملغي بيرجّع. المساعد ما بيبيع شي خلص، وبيقول للزبون إنو خلص وبيعرض الموجود."
      />
      <ErrorNote error={q.error} />

      {tracked.map((p) => (
        <ProductTable key={p.product} initial={toDraft(p)} saved={p} />
      ))}

      {adding && <ProductTable initial={adding} onCancel={() => setAdding(undefined)} onSaved={() => setAdding(undefined)} />}

      {!adding && (
        <Card className="flex flex-col gap-3">
          <h2 className="font-semibold">{tracked.length ? "منتج تاني" : "ابدأ بالمخزون"}</h2>
          <div className="flex flex-wrap gap-2">
            {untracked.map((s) => (
              <Button key={s.product} variant="ghost" onClick={() => setAdding({ product: s.product, colors: s.colors, sizes: [], q: {} })}>
                <Plus size={16} /> {s.product} ({s.colors.length} لون)
              </Button>
            ))}
            <Button variant="ghost" onClick={() => setAdding({ product: "", colors: [], sizes: [], q: {} })}>
              <Plus size={16} /> منتج باسم جديد
            </Button>
          </div>
          {!tracked.length && !q.isLoading && <Empty icon={Boxes} text="لسا ما في مخزون: المساعد بيبيع كل الألوان والمقاسات." />}
        </Card>
      )}
    </div>
  );
}

function ProductTable({ initial, saved, onCancel, onSaved }: { initial: Draft; saved?: StockProduct; onCancel?: () => void; onSaved?: () => void }) {
  const queryClient = useQueryClient();
  const [d, setD] = useState(initial);
  const [newColor, setNewColor] = useState("");
  const [newSizes, setNewSizes] = useState("");
  const [dirty, setDirty] = useState(!saved);
  useEffect(() => {
    if (saved && !dirty) setD(toDraft(saved));
  }, [saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (patch: Partial<Draft>) => {
    setD((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  };
  const held = (color: string, size: string) => saved?.cells.find((c) => c.color === color && c.size === size)?.held ?? 0;
  const value = (color: string, size: string) => Number(d.q[key(color, size)] || 0);

  const save = useMutation({
    mutationFn: () =>
      api.saveStock(
        d.product.trim(),
        d.colors.flatMap((color) => d.sizes.map((size) => ({ color, size, quantity: value(color, size) }))),
      ),
    onSuccess: () => {
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ["stock"] });
      onSaved?.();
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteStock(d.product),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["stock"] }),
  });

  const addColor = () => {
    const color = newColor.trim();
    if (color && !d.colors.includes(color)) change({ colors: [...d.colors, color] });
    setNewColor("");
  };
  const addSizes = () => {
    const sizes = newSizes.split(/[\s,،]+/).map((s) => s.trim()).filter((s) => s && !d.sizes.includes(s));
    if (sizes.length) change({ sizes: [...d.sizes, ...sizes] });
    setNewSizes("");
  };
  const total = d.colors.reduce((n, c) => n + d.sizes.reduce((m, s) => m + Math.max(0, value(c, s)), 0), 0);
  const out = d.colors.flatMap((c) => d.sizes.filter((s) => value(c, s) <= 0).map((s) => `${c} ${s}`));

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {saved ? (
          <h2 className="text-lg font-bold">{d.product}</h2>
        ) : (
          <input value={d.product} onChange={(e) => change({ product: e.target.value })} placeholder="اسم المنتج" className={clsx(inputClass, "font-semibold")} />
        )}
        <Badge tone="primary">{num(total)} قطعة</Badge>
        {out.length > 0 && <Badge tone="bad">{out.length} خلص</Badge>}
        {saved && <span className="text-xs text-muted">آخر تعديل {ago(saved.updatedAt)}</span>}
        <div className="ms-auto flex gap-2">
          {saved && (
            <Button
              variant="ghost"
              onClick={() => window.confirm(`نوقف عدّ مخزون ${d.product}؟ المساعد رح يرجع يبيع كل الألوان والمقاسات.`) && remove.mutate()}
              disabled={remove.isPending}
              title="وقف عدّ المخزون لهالمنتج"
            >
              <Trash2 size={16} />
            </Button>
          )}
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              إلغاء
            </Button>
          )}
          <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending || !d.product.trim() || !d.colors.length || !d.sizes.length}>
            <Save size={16} /> احفظ
          </Button>
        </div>
      </div>
      <ErrorNote error={save.error ?? remove.error} />

      {d.colors.length > 0 && d.sizes.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-separate border-spacing-1 text-sm">
            <thead>
              <tr>
                <th className="text-start text-xs font-normal text-muted">اللون \ المقاس</th>
                {d.sizes.map((size) => (
                  <th key={size} className="px-1">
                    <span className="inline-flex items-center gap-1 font-semibold num">
                      {size}
                      <button onClick={() => change({ sizes: d.sizes.filter((s) => s !== size) })} className="text-muted hover:text-bad" aria-label={`شيل مقاس ${size}`}>
                        <X size={12} />
                      </button>
                    </span>
                  </th>
                ))}
                <th className="text-xs font-normal text-muted">المجموع</th>
              </tr>
            </thead>
            <tbody>
              {d.colors.map((color) => (
                <tr key={color}>
                  <td className="pe-2 font-semibold whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      <button onClick={() => change({ colors: d.colors.filter((c) => c !== color) })} className="text-muted hover:text-bad" aria-label={`شيل ${color}`}>
                        <X size={12} />
                      </button>
                      {color}
                    </span>
                  </td>
                  {d.sizes.map((size) => {
                    const v = value(color, size);
                    const h = held(color, size);
                    return (
                      <td key={size} className="text-center align-top">
                        <input
                          type="number"
                          value={d.q[key(color, size)] ?? ""}
                          onChange={(e) => change({ q: { ...d.q, [key(color, size)]: e.target.value } })}
                          placeholder="0"
                          className={clsx(
                            inputClass,
                            "num w-16 text-center",
                            v <= 0 ? "border-bad/50 bg-bad/10 text-bad" : v <= 2 ? "border-warn/50 bg-warn/10" : "",
                          )}
                          aria-label={`${color} مقاس ${size}`}
                        />
                        {h > 0 && <div className="mt-0.5 text-[11px] text-muted">+{h} بطلبات</div>}
                      </td>
                    );
                  })}
                  <td className="text-center font-semibold num">{num(d.sizes.reduce((n, s) => n + Math.max(0, value(color, s)), 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addColor()}
          placeholder="لون جديد"
          className={clsx(inputClass, "w-32")}
        />
        <Button variant="ghost" onClick={addColor} disabled={!newColor.trim()}>
          <Plus size={16} /> لون
        </Button>
        <input
          value={newSizes}
          onChange={(e) => setNewSizes(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addSizes()}
          placeholder="مقاسات: 56 58 60 62"
          className={clsx(inputClass, "ltr num w-44")}
        />
        <Button variant="ghost" onClick={addSizes} disabled={!newSizes.trim()}>
          <Plus size={16} /> مقاس
        </Button>
      </div>
      <p className="text-xs text-muted">
        الرقم هو الباقي للبيع: الطلبات يلي انسجلت انقصت منو. "+N بطلبات" يعني في N قطعة بطلبات لسا ما انبعتت (موجودة عندكن بس محجوزة)، فلما تعدّو
        البضاعة اطرحوها. فاضي أو 0 يعني خلص.
      </p>
    </Card>
  );
}
