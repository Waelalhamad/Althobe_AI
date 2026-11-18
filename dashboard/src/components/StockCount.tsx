// The Libya warehouse count on the keeper's phone: every product and color we keep, with its catalog photo, and an
// empty box per size. He never sees the system's numbers and can't add or change a product: he types counts, writes
// what isn't on the list as a free line or in the note, and sends it. The team approves or rejects it.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Camera, CheckCircle2, ClipboardCheck, Clock, Minus, Plus, Send, Trash2, X, XCircle } from "lucide-react";
import { api, type CountExtra, type CountSheetColor, type CountSheetProduct } from "../api";
import { Button, ErrorNote } from "./ui";
import { time } from "../format";

const DRAFT = "stock-count-draft";
type Draft = { counts: Record<string, string>; extras: (Omit<CountExtra, "quantity"> & { quantity: string })[]; note: string };
const EMPTY: Draft = { counts: {}, extras: [], note: "" };
const key = (product: string, color: string, size: string) => `${product}|${color}|${size}`;
const digits = (t: string) => t.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\D/g, "").slice(0, 6);
const inputClass = "rounded-xl border border-line bg-card-2 px-3 py-2.5 outline-none focus:border-primary";

// Catalog photos are public (/catalog/<file>), so they load for him without the team's routes.
const photoUrl = (file: string) => `/${file}`;

// A phone photo is several MB: shrunk to 1280px JPEG before it's sent.
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function StockCount() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["count-sheet"], queryFn: api.countSheet });
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      return { ...EMPTY, ...(JSON.parse(localStorage.getItem(DRAFT) ?? "null") as Draft | null) };
    } catch {
      return EMPTY;
    }
  });
  useEffect(() => localStorage.setItem(DRAFT, JSON.stringify(draft)), [draft]);
  const [photos, setPhotos] = useState<string[]>([]);
  const [viewer, setViewer] = useState<string>();

  const sheet = q.data?.sheet ?? [];
  const cells = useMemo(() => sheet.flatMap((p) => p.colors.flatMap((c) => c.sizes.map((size) => key(p.product, c.color, size)))), [sheet]);
  const done = cells.filter((k) => (draft.counts[k] ?? "") !== "").length;
  const setCount = (k: string, v: string) => setDraft((d) => ({ ...d, counts: { ...d.counts, [k]: v } }));

  const send = useMutation({
    mutationFn: () =>
      api.sendCount({
        counts: cells.flatMap((k) => {
          const v = draft.counts[k] ?? "";
          if (v === "") return [];
          const [product, color, size] = k.split("|") as [string, string, string];
          return [{ product, color, size, counted: Number(v) }];
        }),
        extras: draft.extras.map((e) => ({ ...e, quantity: e.quantity === "" ? null : Number(e.quantity) })),
        note: draft.note,
        photos,
      }),
    onSuccess: () => {
      localStorage.removeItem(DRAFT);
      setDraft(EMPTY);
      setPhotos([]);
      void queryClient.invalidateQueries({ queryKey: ["count-sheet"] });
      window.scrollTo({ top: 0 });
    },
  });

  if (q.error) return <ErrorNote error={q.error} />;
  if (!q.data) return <p className="py-10 text-center text-muted">…</p>;
  const last = q.data.last;

  if (last?.status === "pending") {
    return (
      <div className="glass flex flex-col items-center gap-3 rounded-3xl p-8 text-center">
        <Clock size={40} className="text-primary" />
        <h2 className="text-lg font-bold">الجرد وصل للإدارة</h2>
        <p className="text-sm text-muted">
          بعتّو <span className="ltr num">{time(last.at)}</span>. لما الإدارة تراجعو وتردّ، فيك تبعت جرد جديد من هون.
        </p>
      </div>
    );
  }

  const left = cells.length - done;
  return (
    <div className="flex flex-col gap-4">
      {last?.status === "rejected" && (
        <div className="flex gap-3 rounded-2xl border border-bad/40 bg-bad/10 p-4 text-sm">
          <XCircle className="shrink-0 text-bad" size={20} />
          <div>
            <b>الإدارة رجّعت آخر جرد</b>
            {last.reason && <div className="mt-1">«{last.reason}»</div>}
            <div className="mt-1 text-muted">عدّ من جديد وابعتو.</div>
          </div>
        </div>
      )}
      {last?.status === "approved" && (
        <div className="flex items-center gap-2 rounded-2xl bg-ok/10 p-3 text-sm">
          <CheckCircle2 className="shrink-0 text-ok" size={18} /> آخر جرد انعتمد <span className="ltr num">{time(last.decidedAt ?? last.at)}</span>
        </div>
      )}

      <div className="sticky top-0 z-10 -mx-4 flex flex-col gap-2 bg-bg/95 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <ClipboardCheck size={20} className="text-primary" />
          <b>جرد المستودع</b>
          <span className="num ms-auto text-sm text-muted">
            عدّيت {done} من {cells.length}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-card-2">
          <div className="h-full bg-primary transition-all" style={{ width: `${cells.length ? (done / cells.length) * 100 : 0}%` }} />
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {sheet.map((p) => (
            <a key={p.product} href={`#count-${sheet.indexOf(p)}`} className="shrink-0 rounded-xl bg-card-2 px-3 py-1.5 text-xs">
              {p.product}
            </a>
          ))}
        </div>
      </div>

      <p className="text-sm text-muted">
        عدّ كل لون ومقاس واكتب العدد يلي قدامك. الخانة الفاضية يعني ما عدّيتها، وإذا ما في ولا قطعة اكتب 0. الشغل بينحفظ عالتلفون لحتى تبعت.
      </p>

      {sheet.map((p, i) => (
        <ProductCount key={p.product} id={`count-${i}`} product={p} draft={draft} setCount={setCount} setDraft={setDraft} onPhoto={setViewer} />
      ))}

      <div className="glass flex flex-col gap-3 rounded-2xl p-4">
        <h3 className="font-bold">ملاحظات</h3>
        <textarea
          value={draft.note}
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          rows={3}
          placeholder="أي شي لازم تعرفو الإدارة: قطعة مش بالقائمة، قطعة معيوبة، كرتونة ما فتحتها…"
          className={inputClass}
        />
        <div className="flex flex-wrap gap-2">
          {photos.map((src, n) => (
            <div key={n} className="relative">
              <img src={src} alt="" className="size-20 rounded-xl object-cover" />
              <button
                type="button"
                onClick={() => setPhotos(photos.filter((_, m) => m !== n))}
                className="absolute -top-2 -left-2 grid size-6 place-items-center rounded-full bg-bad text-white"
                aria-label="شيل الصورة"
              >
                <X size={14} />
              </button>
            </div>
          ))}
          {photos.length < 4 && (
            <label className="grid size-20 cursor-pointer place-items-center rounded-xl border border-dashed border-line text-muted">
              <Camera size={22} />
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) setPhotos([...photos, await shrink(file)]);
                }}
              />
            </label>
          )}
        </div>
        {photos.length > 0 && <p className="text-xs text-muted">الصور ما بتنحفظ عالتلفون: ابعت الجرد قبل ما تسكّر الصفحة.</p>}
      </div>

      <ErrorNote error={send.error} />
      <Button
        disabled={send.isPending || (!done && !draft.extras.length && !draft.note.trim())}
        onClick={() =>
          window.confirm(
            left
              ? `في ${left} خانة فاضية، بتوصل للإدارة «ما انعدّت». تبعت الجرد هيك؟`
              : "تبعت الجرد للإدارة؟ بعد ما تبعتو ما فيك تعدّل عليه.",
          ) && send.mutate()
        }
        className="py-4 text-lg"
      >
        <Send size={18} /> {send.isPending ? "جاري الإرسال…" : "إرسال الجرد"}
      </Button>

      {viewer && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/90 p-2" onClick={() => setViewer(undefined)}>
          <img src={viewer} alt="" className="max-h-full max-w-full rounded-xl object-contain" />
          <button className="absolute top-4 left-4 text-white" aria-label="إغلاق">
            <X size={28} />
          </button>
        </div>
      )}
    </div>
  );
}

function ProductCount({
  id,
  product,
  draft,
  setCount,
  setDraft,
  onPhoto,
}: {
  id: string;
  product: CountSheetProduct;
  draft: Draft;
  setCount: (k: string, v: string) => void;
  setDraft: (f: (d: Draft) => Draft) => void;
  onPhoto: (src: string) => void;
}) {
  const extras = draft.extras.map((e, n) => ({ e, n })).filter(({ e }) => e.product === product.product);
  const setExtra = (n: number, patch: Partial<Draft["extras"][number]>) =>
    setDraft((d) => ({ ...d, extras: d.extras.map((e, m) => (m === n ? { ...e, ...patch } : e)) }));
  return (
    <section id={id} className="flex scroll-mt-36 flex-col gap-3">
      <div className="px-1">
        <h2 className="text-lg font-bold">{product.product}</h2>
        {product.about && <p className="text-sm text-muted">{product.about}</p>}
      </div>
      {product.colors.map((c) => (
        <ColorCount key={c.color} product={product.product} color={c} draft={draft} setCount={setCount} onPhoto={onPhoto} />
      ))}
      {extras.map(({ e, n }) => (
        <div key={n} className="flex flex-col gap-2 rounded-2xl border border-dashed border-warn/50 p-3">
          <div className="flex items-center text-sm font-semibold text-warn">
            قطعة مش بالقائمة
            <button
              type="button"
              onClick={() => setDraft((d) => ({ ...d, extras: d.extras.filter((_, m) => m !== n) }))}
              className="ms-auto text-muted"
              aria-label="شيل"
            >
              <Trash2 size={16} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input value={e.color} onChange={(ev) => setExtra(n, { color: ev.target.value })} placeholder="اللون" className={clsx(inputClass, "col-span-3")} />
            <input value={e.size} onChange={(ev) => setExtra(n, { size: ev.target.value.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)) })} placeholder="المقاس" className={clsx(inputClass, "col-span-2")} />
            <input inputMode="numeric" value={e.quantity} onChange={(ev) => setExtra(n, { quantity: digits(ev.target.value) })} placeholder="العدد" className={clsx(inputClass, "num text-center")} />
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={() => setDraft((d) => ({ ...d, extras: [...d.extras, { product: product.product, color: "", size: "", quantity: "" }] }))}
        className="flex items-center justify-center gap-1 rounded-xl py-2 text-sm text-muted"
      >
        <Plus size={16} /> لقيت لون أو مقاس من {product.product} مش بالقائمة؟
      </button>
    </section>
  );
}

function ColorCount({
  product,
  color,
  draft,
  setCount,
  onPhoto,
}: {
  product: string;
  color: CountSheetColor;
  draft: Draft;
  setCount: (k: string, v: string) => void;
  onPhoto: (src: string) => void;
}) {
  const [shown, setShown] = useState(0);
  const photo = color.photos[shown];
  const filled = color.sizes.filter((s) => (draft.counts[key(product, color.color, s)] ?? "") !== "").length;
  return (
    <div className="glass overflow-hidden rounded-2xl">
      {photo ? (
        <button type="button" onClick={() => onPhoto(photoUrl(photo))} className="block w-full">
          <img src={photoUrl(photo)} alt={`${product} ${color.color}`} loading="lazy" className="aspect-[4/3] w-full bg-card-2 object-cover" />
        </button>
      ) : (
        <div className="grid aspect-[4/3] place-items-center bg-card-2 text-sm text-muted">ما في صورة</div>
      )}
      {color.photos.length > 1 && (
        <div className="flex gap-2 overflow-x-auto px-3 pt-2">
          {color.photos.map((f, n) => (
            <button key={f} type="button" onClick={() => setShown(n)} className={clsx("shrink-0 rounded-lg ring-2", n === shown ? "ring-primary" : "ring-transparent")}>
              <img src={photoUrl(f)} alt="" loading="lazy" className="size-14 rounded-lg object-cover" />
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-lg font-bold">{color.color}</h3>
          <span className={clsx("num ms-auto text-xs", filled === color.sizes.length ? "text-ok" : "text-muted")}>
            {filled}/{color.sizes.length}
          </span>
        </div>
        {color.sizes.map((size) => {
          const k = key(product, color.color, size);
          const v = draft.counts[k] ?? "";
          return (
            <div key={size} className="flex items-center gap-3">
              <span className="num w-20 font-semibold">{size}</span>
              <button
                type="button"
                onClick={() => setCount(k, String(Math.max(0, (Number(v) || 0) - 1)))}
                className="grid size-11 place-items-center rounded-xl bg-card-2 active:scale-90"
                aria-label="ناقص"
              >
                <Minus size={18} />
              </button>
              <input
                inputMode="numeric"
                value={v}
                onChange={(e) => setCount(k, digits(e.target.value))}
                onFocus={(e) => e.target.select()}
                placeholder="—"
                className={clsx(
                  "num w-16 rounded-xl border bg-card-2 py-2 text-center text-xl font-bold outline-none focus:border-primary",
                  v === "" ? "border-dashed border-line" : "border-primary/60",
                )}
                aria-label={`${product} ${color.color} ${size}`}
              />
              <button
                type="button"
                onClick={() => setCount(k, String((Number(v) || 0) + 1))}
                className="grid size-11 place-items-center rounded-xl bg-card-2 active:scale-90"
                aria-label="زايد"
              >
                <Plus size={18} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
