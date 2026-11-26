// Offer photos by size: a template's button («ابعتولي الصور») answered with the offer's models in the customer's size,
// each photo with its final price (src/sizeOffers.ts).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api, mediaUrl, type AdPost, type CampaignTemplate, type OfferModel, type SizeOffer, type SizeOfferInput } from "../api";
import { prepareImage } from "../image";
import { Badge, Button, Card, ErrorNote, Toggle } from "./ui";

const field = "mt-1 block rounded-xl border border-line bg-card-2 px-3 py-2";

export function SizeOffers({ templates }: { templates: CampaignTemplate[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["size-offers"], queryFn: api.sizeOffers });
  const refresh = () => qc.invalidateQueries({ queryKey: ["size-offers"] });
  const [template, setTemplate] = useState("");
  const [adOffer, setAdOffer] = useState("");
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
        <label className="text-sm">
          أو عرض للإعلانات بس (اسم بالإنكليزي)
          <input value={adOffer} onChange={(e) => setAdOffer(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))} placeholder="clearance_general" className={`${field} ltr`} />
        </label>
        <Button
          variant="ghost"
          disabled={!adOffer || offers.some((o) => o.template === adOffer) || save.isPending}
          onClick={() => save.mutate({ template: adOffer, label: "25٪", button: 0, active: false }, { onSuccess: () => setAdOffer("") })}
        >
          زيد
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
            hasTemplate={templates.some((t) => t.name === o.template)}
            onDelete={() => confirm(`تحذف عرض «${o.template}» وصوره؟`) && remove.mutate(o.template)}
            refresh={refresh}
          />
        ))}
      </div>

      <AdPosts offers={offers.map((o) => o.template)} />
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
  hasTemplate,
}: {
  hasTemplate: boolean;
  offer: SizeOffer;
  buttons: { type: string; text?: string }[];
  stock: { product: string; color: string; size: string }[];
  onSave: (patch: Partial<SizeOfferInput>) => void;
  onDelete: () => void;
  refresh: () => void;
}) {
  const [label, setLabel] = useState(offer.label);
  const [intro, setIntro] = useState(offer.intro ?? `يا أستاذ، هادي الموديلات اللي متوفّرة على قياسك. عاملين عليها خصم ${offer.label}، وسعر كل موديل تلقاه مع صورته 👇`);
  const [outro, setOutro] = useState(offer.outro ?? "");
  const [oldPrices, setOldPrices] = useState<Record<string, string>>(
    Object.fromEntries(Object.entries(offer.oldPrices).map(([k, v]) => [k, String(v)])),
  );
  const products = [...new Set(offer.photos.flatMap((p) => p.models.map((m) => m.product)))];
  const saveOld = () =>
    onSave({ oldPrices: Object.fromEntries(Object.entries(oldPrices).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)])) });
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
          <Badge tone="ok">وصلتهم الصور {n("sent") + n("more")}</Badge>
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
        {hasTemplate && (
          <label className="text-sm">
            زر طلب الصور
            <select value={offer.button} onChange={(e) => onSave({ button: Number(e.target.value) })} className={field}>
              {(buttons.length ? buttons : [{ type: "QUICK_REPLY", text: "الزر الأول" }]).map((b, i) => (
                <option key={i} value={i}>{b.text ?? `زر ${i + 1}`}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">
          النص مع أول صورة (فاضي: ما في نص)
          <textarea value={intro} rows={2} onChange={(e) => setIntro(e.target.value)} onBlur={() => intro !== offer.intro && onSave({ intro })} className={`${field} w-full`} />
        </label>
        <label className="text-sm">
          النص بعد الصور (فاضي: ما في نص)
          <textarea value={outro} rows={2} onChange={(e) => setOutro(e.target.value)} onBlur={() => outro !== (offer.outro ?? "") && onSave({ outro })} className={`${field} w-full`} />
        </label>
      </div>
      {products.length > 0 && (
        <div className="text-sm">
          <p>السعر القديم لكل موديل (بيطلع على الصورة: «كان X دينار، توا Y دينار»)</p>
          <div className="mt-1 flex flex-wrap gap-3">
            {products.map((p) => (
              <label key={p} className="text-xs">
                {p}
                <input
                  inputMode="numeric"
                  value={oldPrices[p] ?? ""}
                  onChange={(e) => setOldPrices((v) => ({ ...v, [p]: e.target.value }))}
                  onBlur={saveOld}
                  className={`${field} num w-24`}
                />
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {offer.photos.map((p) => (
          <div key={p.id} className="rounded-xl border border-line p-2 text-sm">
            <img src={mediaUrl(p.file)} alt="" loading="lazy" className="aspect-square w-full rounded-lg object-cover" />
            <ul className="mt-2 space-y-0.5">
              {p.models.map((m) => (
                <li key={`${m.product}|${m.color}`}>
                  {m.product} - {m.color}: {(m.oldPrice ?? offer.oldPrices[m.product] ?? 0) > m.price && <span className="num text-muted line-through">{m.oldPrice ?? offer.oldPrices[m.product]}</span>} <b className="num">{m.price}</b> دينار
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

// Click-to-WhatsApp ads: which ad id is which post, its greeting, its ready-made message and its offer.
const EMPTY_AD: AdPost = { adId: "", name: "", sizes: "", greeting: "", prefill: "", offer: "" };

function AdPosts({ offers }: { offers: string[] }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ad-posts"], queryFn: api.adPosts });
  const refresh = () => qc.invalidateQueries({ queryKey: ["ad-posts"] });
  const [edit, setEdit] = useState<(AdPost & { was?: string }) | null>(null);
  const save = useMutation({
    mutationFn: api.saveAdPost,
    onSuccess: () => {
      setEdit(null);
      return refresh();
    },
  });
  const remove = useMutation({ mutationFn: api.deleteAdPost, onSuccess: refresh });
  const set = (patch: Partial<AdPost>) => setEdit((e) => e && { ...e, ...patch });

  return (
    <div className="mt-6 space-y-3 border-t border-line pt-4">
      <h3 className="font-semibold">إعلانات الواتساب (فيسبوك)</h3>
      <p className="text-xs text-muted">
        الزبون اللي بيكبس الإعلان بيوصل مع رقم الإعلان. المساعد بيرحّب فيه بالترحيب المكتوب ويسأل عن مقاسه أو وزنه، وأول ما يعطيه، بتنبعتله صور العرض المتوفّرة بمقاسه (8 بالأكتر، الأكتر كمية أول). إذا رقم الإعلان ما وصل، منعرف المنشور من الرسالة الجاهزة.
      </p>
      <ErrorNote error={q.error ?? save.error ?? remove.error} />
      <ul className="divide-y divide-line rounded-xl border border-line">
        {(q.data ?? []).map((a) => (
          <li key={a.adId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <b>{a.name}</b>
            <span className="num ltr text-muted">{a.adId}</span>
            {a.sizes && <Badge>{a.sizes}</Badge>}
            <Badge tone={offers.includes(a.offer) ? "info" : "bad"}>{a.offer || "بدون عرض"}</Badge>
            <span className="ms-auto flex gap-2">
              <Button variant="ghost" className="px-3 py-1" onClick={() => setEdit({ ...a, was: a.adId })}>عدّل</Button>
              <Button variant="danger" className="px-3 py-1" onClick={() => confirm(`تحذف «${a.name}»؟`) && remove.mutate(a.adId)}>احذف</Button>
            </span>
          </li>
        ))}
        {!q.data?.length && <li className="px-3 py-2 text-sm text-muted">ما في إعلانات لسا.</li>}
      </ul>
      {!edit ? (
        <Button variant="ghost" onClick={() => setEdit({ ...EMPTY_AD, offer: offers.includes("clearance_general") ? "clearance_general" : "" })}>زيد إعلان</Button>
      ) : (
        <div className="space-y-2 rounded-xl bg-card-2 p-3 text-sm">
          <div className="flex flex-wrap gap-3">
            <label>
              رقم الإعلان (Ad ID)
              <input value={edit.adId} onChange={(e) => set({ adId: e.target.value.trim() })} className={`${field} num ltr w-56`} />
            </label>
            <label>
              اسم المنشور
              <input value={edit.name} onChange={(e) => set({ name: e.target.value })} placeholder="المقاسات الكبيرة" className={field} />
            </label>
            <label>
              مقاساته
              <input value={edit.sizes} onChange={(e) => set({ sizes: e.target.value })} placeholder="62 و64 (وزن فوق 100 كغ)" className={field} />
            </label>
            <label>
              العرض
              <select value={edit.offer} onChange={(e) => set({ offer: e.target.value })} className={field}>
                <option value="">بدون</option>
                {offers.map((o) => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
            </label>
          </div>
          <label className="block">
            الترحيب (أول رد)
            <textarea rows={2} value={edit.greeting} onChange={(e) => set({ greeting: e.target.value })} className={`${field} w-full`} />
          </label>
          <label className="block">
            الرسالة الجاهزة بالإعلان
            <input value={edit.prefill} onChange={(e) => set({ prefill: e.target.value })} className={`${field} w-full`} />
          </label>
          <div className="flex gap-2">
            <Button disabled={!edit.adId || !edit.name || save.isPending} onClick={() => save.mutate(edit)}>احفظ</Button>
            <Button variant="ghost" onClick={() => setEdit(null)}>إلغاء</Button>
          </div>
        </div>
      )}
    </div>
  );
}
