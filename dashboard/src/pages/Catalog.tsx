import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Images, Save, Trash2, Upload } from "lucide-react";
import { api, mediaUrl, type CatalogItem } from "../api";
import { Button, Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { prepareImage } from "../image";

const inputClass = "rounded-xl border border-line bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary";

export function Catalog() {
  const queryClient = useQueryClient();
  const photos = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["catalog"] });

  // Photos grouped by product, in upload order.
  const groups = new Map<string, CatalogItem[]>();
  for (const p of photos.data ?? []) {
    const product = p.product?.trim() ?? "";
    groups.set(product, [...(groups.get(product) ?? []), p]);
  }
  const products = [...groups.keys()].filter(Boolean);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="صور المنتجات"
        subtitle="الصور يلي المساعد بيقدر يبعتها للزباين، متل ما بيبعت الفريق صور الألوان. لكل صورة اكتب المنتج، واسم الصورة (اللون أو الموديل)، ووصف واضح، لأنو المساعد بيختار الصورة من الوصف. منتج جديد؟ ارفع صورو واكتب اسمو، وضيف معلوماتو بصفحة «معلومات المساعد»."
      />
      <Uploader products={products} onDone={refresh} />
      <ErrorNote error={photos.error} />
      {photos.data?.length === 0 && (
        <Card>
          <Empty icon={Images} text="ما في صور لسا. ارفع صور الألوان يلي بيبعتها الفريق." />
        </Card>
      )}
      <div className="flex flex-col gap-8">
        {[...groups].map(([product, items]) => (
          <section key={product}>
            <h2 className="mb-3 font-semibold">
              {product || "بدون منتج"} <span className="text-sm font-normal text-muted">({items.length} صورة)</span>
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((p) => (
                <PhotoCard key={p.id} item={p} products={products} onChange={refresh} />
              ))}
            </div>
          </section>
        ))}
      </div>
      <datalist id="catalog-products">
        {products.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>
  );
}

function Uploader({ products, onDone }: { products: string[]; onDone: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  // Several photos of one color or model at once: they all get the same product, name and description.
  const [previews, setPreviews] = useState<{ mime: string; data: string; dataUrl: string }[]>([]);
  const preview = previews[0];
  const [product, setProduct] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<unknown>();

  const upload = useMutation({
    mutationFn: async () => {
      for (const p of previews) await api.addPhoto({ product, name, description, mime: p.mime, data: p.data });
    },
    onSuccess: () => {
      // Keep the product: several colors of the same product are usually uploaded one after another.
      setPreviews([]);
      setName("");
      setDescription("");
      onDone();
    },
  });

  return (
    <Card className="mb-6 flex flex-col gap-4 sm:flex-row">
      <button
        type="button"
        onClick={() => input.current?.click()}
        className="grid aspect-square w-full shrink-0 place-items-center overflow-hidden rounded-xl border border-dashed border-line bg-card-2 text-muted hover:border-primary sm:w-48"
      >
        {preview ? (
          <span className="relative size-full">
            <img src={preview.dataUrl} alt="" className="size-full object-cover" />
            {previews.length > 1 && <span className="absolute bottom-2 start-2 rounded-lg bg-black/70 px-2 py-0.5 text-xs text-white">{previews.length} صور</span>}
          </span>
        ) : (
          <span className="flex flex-col items-center gap-2 text-sm">
            <ImagePlus /> اختار صورة
          </span>
        )}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (!files.length) return;
          setError(undefined);
          try {
            setPreviews(await Promise.all(files.map((f) => prepareImage(f))));
            if (!name) setName(files[0]!.name.replace(/\.[^.]+$/, ""));
          } catch (err) {
            setError(err);
          }
        }}
      />
      <form
        className="flex flex-1 flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          upload.mutate();
        }}
      >
        <input
          value={product}
          onChange={(e) => setProduct(e.target.value)}
          list="catalog-products"
          placeholder={products.length ? `المنتج، مثلاً: ${products[0]}` : "المنتج، مثلاً: الثوب العربي"}
          className={inputClass}
        />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="اسم الصورة، مثلاً: رصاصي" className={inputClass} />
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          placeholder="الوصف: اللون، المقاسات المتوفرة، أي ملاحظة (مثلاً: متوفر 56 لـ 62، الأكثر طلباً)"
          className={inputClass}
        />
        <ErrorNote error={error ?? upload.error} />
        <Button disabled={!preview || !name.trim() || upload.isPending} className="self-start">
          <Upload size={16} /> {upload.isPending ? "جاري الرفع…" : previews.length > 1 ? `رفع ${previews.length} صور` : "رفع الصورة"}
        </Button>
      </form>
    </Card>
  );
}

function PhotoCard({ item, onChange }: { item: CatalogItem; products: string[]; onChange: () => void }) {
  const [product, setProduct] = useState(item.product ?? "");
  const [name, setName] = useState(item.name);
  const [description, setDescription] = useState(item.description);
  const dirty = product !== (item.product ?? "") || name !== item.name || description !== item.description;
  const save = useMutation({ mutationFn: () => api.updatePhoto(item.id, { product, name, description }), onSuccess: onChange });
  const remove = useMutation({ mutationFn: () => api.deletePhoto(item.id), onSuccess: onChange });

  return (
    <Card className="flex flex-col gap-3 p-3">
      <div className="relative">
        <img src={mediaUrl(item.file)} alt={item.name} loading="lazy" className="aspect-square w-full rounded-xl object-cover" />
        <span className="ltr absolute start-2 top-2 rounded-lg bg-black/60 px-2 py-0.5 font-mono text-xs text-white">{item.id}</span>
      </div>
      <input value={product} onChange={(e) => setProduct(e.target.value)} list="catalog-products" placeholder="المنتج" className={inputClass} />
      <input value={name} onChange={(e) => setName(e.target.value)} className={`${inputClass} font-semibold`} />
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="الوصف" className={inputClass} />
      <ErrorNote error={save.error ?? remove.error} />
      <div className="flex gap-2">
        <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending} className="flex-1">
          <Save size={16} /> {dirty ? "حفظ" : "محفوظ"}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            if (window.confirm(`حذف «${item.name}»؟`)) remove.mutate();
          }}
          disabled={remove.isPending}
          aria-label="حذف"
        >
          <Trash2 size={16} />
        </Button>
      </div>
    </Card>
  );
}
