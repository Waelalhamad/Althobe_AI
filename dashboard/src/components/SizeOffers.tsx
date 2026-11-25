// Offer photos by size: a template's button («ابعتولي الصور») answered with the offer's models in the customer's size,
// each photo with its final price (src/sizeOffers.ts).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api, mediaUrl, type CampaignTemplate, type OfferModel, type SizeOffer } from "../api";
import { prepareImage } from "../image";
import { Badge, Button, Card, ErrorNote, Toggle } from "./ui";

const field = "mt-1 block rounded-xl border border-line bg-card-2 px-3 py-2";

export function SizeOffers({ templates }: { templates: CampaignTemplate[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["size-offers"], queryFn: api.sizeOffers });
  const refresh = () => qc.invalidateQueries({ queryKey: ["size-offers"] });
  const [template, setTemplate] = useState("");
  const save = useMutation({ mutationFn: api.saveSizeOffer, onSuccess: refresh });
  const remove = useMutation({ mutationFn: api.deleteSizeOffer, onSuccess: refresh });

  const offers = q.data?.offers ?? [];
  const names = [...new Set(templates.filter((t) => t.status === "APPROVED" || t.status === "PENDING").map((t) => t.name))].filter(
    (n) => !offers.some((o) => o.template === n),
  );

  return (
    <Card>
      <h2 className="font-semibold">صور العرض حسب المقاس</h2>
      <p className="mt-1 text-xs text-muted">
        لما الزبون يضغط زر طلب الصور بالقالب، المساعد بيبعتله بس موديلات العرض المتوفّرة بقياسه هلق، وعلى كل صورة اسم الموديل وسعره النهائي. إذا ما منعرف قياسه بيسأله أول، وبيحفظ القياس.
        العرض ما بيشتغل إلا لما تشغّلوه.
      </p>
      <ErrorNote error={q.error ?? save.error ?? remove.error} />

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          قالب جديد للعرض
          <select value={template} onChange={(e) => setTemplate(e.target.value)} className={field}>
            <option value="">اختار…</option>
            {names.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
        <Button
          variant="ghost"
          disabled={!template || save.isPending}
          onClick={() => save.mutate({ template, label: "30٪", button: 0, active: false }, { onSuccess: () => setTemplate("") })}
        >
          زيد عرض
        </Button>
      </div>

      <div className="mt-4 space-y-4">
        {offers.map((o) => (
          <OfferCard
            key={o.template}
            offer={o}
            buttons={templates.find((t) => t.name === o.template)?.components.find((c) => c.type === "BUTTONS")?.buttons ?? []}
            stock={q.data?.stock ?? []}
            onSave={(patch) => save.mutate({ template: o.template, label: o.label, button: o.button, active: o.active, ...patch })}
            onDelete={() => confirm(`تحذف عرض «${o.template}» وصوره؟`) && remove.mutate(o.template)}
            refresh={refresh}
          />
        ))}
      </div>
    </Card>
  );
}

function OfferCard({
  offer,
  buttons,
  stock,
  onSave,
  onDelete,
  refresh,
}: {
  offer: SizeOffer;
  buttons: { type: string; text?: string }[];
  stock: { product: string; color: string; size: string }[];
  onSave: (patch: Partial<Pick<SizeOffer, "label" | "button" | "active">>) => void;
  onDelete: () => void;
  refresh: () => void;
}) {
  const [label, setLabel] = useState(offer.label);
  const n = (k: string) => offer.requests[k] ?? 0;
  const removePhoto = useMutation({ mutationFn: api.deleteOfferPhoto, onSuccess: refresh });

  return (
    <div className="space-y-3 rounded-2xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="ltr font-semibold">{offer.template}</span>
        <Toggle checked={offer.active} onChange={(active) => onSave({ active })} />
        <Badge tone={offer.active ? "ok" : "muted"}>{offer.active ? "شغّال" : "واقف"}</Badge>
        <span className="num flex flex-wrap gap-2 text-xs">
          <Badge>عم ننتظر قياسهم {n("asking")}</Badge>
          <Badge tone="ok">وصلتهم الصور {n("sent")}</Badge>
          <Badge>ما في على قياسهم {n("none")}</Badge>
          <Badge tone={n("failed") ? "bad" : "muted"}>للفريق {n("failed")}</Badge>
        </span>
        <Button variant="danger" className="ms-auto px-3 py-1" onClick={onDelete}>احذف</Button>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          الخصم مثل ما بيقراه الزبون
          <input value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => label !== offer.label && onSave({ label })} className={`${field} w-28`} />
        </label>
        <label className="text-sm">
          زر طلب الصور
          <select value={offer.button} onChange={(e) => onSave({ button: Number(e.target.value) })} className={field}>
            {(buttons.length ? buttons : [{ type: "QUICK_REPLY", text: "الزر الأول" }]).map((b, i) => (
              <option key={i} value={i}>{b.text ?? `زر ${i + 1}`}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {offer.photos.map((p) => (
          <div key={p.id} className="rounded-xl border border-line p-2 text-sm">
            <img src={mediaUrl(p.file)} alt="" loading="lazy" className="aspect-square w-full rounded-lg object-cover" />
            <ul className="mt-2 space-y-0.5">
              {p.models.map((m) => (
                <li key={`${m.product}|${m.color}`}>
                  {m.product} - {m.color}: <b className="num">{m.price}</b> دينار
                </li>
              ))}
            </ul>
            <div className="mt-1 flex items-center justify-between text-xs text-muted">
              <span>{p.sizes.length ? `مقاس ${p.sizes.join("، ")}` : "كل المقاسات"}</span>
              <button className="text-bad" title="احذف" onClick={() => confirm("تحذف الصورة؟") && removePhoto.mutate(p.id)}>
                <Trash2 className="size-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
      <NewPhoto template={offer.template} stock={stock} refresh={refresh} />
    </div>
  );
}

function NewPhoto({ template, stock, refresh }: { template: string; stock: { product: string; color: string; size: string }[]; refresh: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [models, setModels] = useState<(OfferModel & { priceText: string })[]>([{ product: "", color: "", price: 0, priceText: "" }]);
  const [sizes, setSizes] = useState<string[]>([]);
  const products = [...new Set(stock.map((r) => r.product))];
  const allSizes = [...new Set(stock.map((r) => r.size).filter((s) => /^\d+$/.test(s)))].sort();
  const add = useMutation({
    mutationFn: async () => {
      const img = await prepareImage(file!);
      return api.addOfferPhoto(template, {
        mime: img.mime,
        data: img.data,
        sizes,
        models: models.map((m) => ({ product: m.product, color: m.color, price: Number(m.priceText) })),
      });
    },
    onSuccess: () => {
      setFile(null);
      setModels([{ product: "", color: "", price: 0, priceText: "" }]);
      setSizes([]);
      refresh();
    },
  });
  const set = (i: number, patch: Partial<OfferModel & { priceText: string }>) => setModels((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));

  return (
    <div className="space-y-2 rounded-xl bg-card-2 p-3 text-sm">
      <p className="font-semibold">زيد صورة للعرض</p>
      <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {models.map((m, i) => (
        <div key={i} className="flex flex-wrap items-end gap-2">
          <label>
            الموديل
            <select value={m.product} onChange={(e) => set(i, { product: e.target.value, color: "" })} className={field}>
              <option value="">اختار…</option>
              {products.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            اللون
            <select value={m.color} onChange={(e) => set(i, { color: e.target.value })} className={field}>
              <option value="">اختار…</option>
              {[...new Set(stock.filter((r) => r.product === m.product).map((r) => r.color))].map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            السعر النهائي (دينار)
            <input inputMode="numeric" value={m.priceText} onChange={(e) => set(i, { priceText: e.target.value })} className={`${field} num w-28`} />
          </label>
          {models.length > 1 && (
            <button className="pb-2 text-bad" onClick={() => setModels((ms) => ms.filter((_, j) => j !== i))}>شيل</button>
          )}
        </div>
      ))}
      <button className="text-primary" onClick={() => setModels((ms) => [...ms, { product: "", color: "", price: 0, priceText: "" }])}>
        + موديل تاني بنفس الصورة
      </button>
      <div>
        <p>الصورة معمولة لمقاس (إذا ما اخترت شي: لكل المقاسات)</p>
        <div className="mt-1 flex flex-wrap gap-2">
          {allSizes.map((s) => (
            <label key={s} className="num inline-flex items-center gap-1">
              <input type="checkbox" checked={sizes.includes(s)} onChange={(e) => setSizes((v) => (e.target.checked ? [...v, s] : v.filter((x) => x !== s)))} />
              {s}
            </label>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted">السعر بينكتب تحت الصورة زي ما هو، بدون أي خصم زيادة. الصورة بتنبعت بس إذا كل الموديلات اللي فيها متوفّرة بقياس الزبون.</p>
      <ErrorNote error={add.error} />
      <Button disabled={!file || models.some((m) => !m.product || !m.color || !m.priceText) || add.isPending} onClick={() => add.mutate()}>
        {add.isPending ? "عم ترفع…" : "زيد الصورة"}
      </Button>
    </div>
  );
}
