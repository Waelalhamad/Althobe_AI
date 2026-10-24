import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { FilePlus, FileText, Save, Trash2 } from "lucide-react";
import { api } from "../api";
import { Button, Card, ErrorNote, PageHeader } from "../components/ui";
import { ago, num } from "../format";

export function Knowledge() {
  const queryClient = useQueryClient();
  const files = useQuery({ queryKey: ["knowledge"], queryFn: api.knowledge });
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState("");
  const [newName, setNewName] = useState("");

  const current = selected ?? files.data?.[0]?.name;
  const file = useQuery({ queryKey: ["knowledge", current], queryFn: () => api.knowledgeFile(current!), enabled: Boolean(current) });
  useEffect(() => {
    if (file.data) setDraft(file.data.body);
  }, [file.data]);

  const dirty = file.data !== undefined && draft !== file.data.body;
  const save = useMutation({
    mutationFn: () => api.saveKnowledge(current!, draft),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["knowledge"] }),
  });
  const create = useMutation({
    mutationFn: (name: string) => api.saveKnowledge(name, `# ${name.replace(/\.(md|txt)$/, "")}\n\n`),
    onSuccess: (_d, name) => {
      setNewName("");
      setSelected(name);
      void queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteKnowledge(current!),
    onSuccess: () => {
      setSelected(undefined);
      void queryClient.invalidateQueries({ queryKey: ["knowledge"] });
    },
  });

  const totalChars = files.data?.reduce((a, f) => a + f.size, 0) ?? 0;

  return (
    <div className="mx-auto max-w-7xl">
      <PageHeader
        title="معلومات المساعد"
        subtitle="المساعد بيجاوب بس من هالملفات: المنتجات، الأسعار، المقاسات، الشحن والدفع والإرجاع. أي تعديل بيشتغل من أول رسالة جاية."
      />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <Card className="flex flex-col gap-3 p-3 lg:col-span-1">
          <ul className="flex flex-col gap-1">
            {files.data?.map((f) => (
              <li key={f.name}>
                <button
                  onClick={() => {
                    if (!dirty || confirmDiscard()) setSelected(f.name);
                  }}
                  className={clsx(
                    "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-start text-sm",
                    f.name === current ? "bg-primary-soft text-primary" : "hover:bg-card-2",
                  )}
                >
                  <FileText size={16} className="shrink-0" />
                  <span className="ltr flex-1 truncate text-start">{f.name}</span>
                  <span className="text-[11px] text-muted">{ago(f.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim().replace(/\s+/g, "-");
              if (name) create.mutate(/\.(md|txt)$/.test(name) ? name : `${name}.md`);
            }}
            className="flex gap-2 border-t border-line pt-3"
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="06-offers"
              className="ltr min-w-0 flex-1 rounded-xl border border-line bg-card-2 px-3 py-2 text-sm outline-none focus:border-primary"
            />
            <Button variant="ghost" disabled={!newName.trim() || create.isPending} aria-label="ملف جديد">
              <FilePlus size={16} />
            </Button>
          </form>
          <ErrorNote error={create.error} />
          <p className="px-1 text-xs text-muted">
            المجموع {num(totalChars)} حرف. كل ما زادت المعلومات، زادت تكلفة كل رد شوي.
          </p>
        </Card>

        <Card className="flex flex-col gap-3 lg:col-span-3">
          {current ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="ltr font-semibold">{current}</h2>
                <div className="flex gap-2">
                  <Button
                    variant="danger"
                    onClick={() => {
                      if (window.confirm(`حذف ${current}؟`)) remove.mutate();
                    }}
                    disabled={remove.isPending}
                  >
                    <Trash2 size={16} />
                  </Button>
                  <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
                    <Save size={16} /> {save.isPending ? "جاري الحفظ…" : dirty ? "حفظ" : "محفوظ"}
                  </Button>
                </div>
              </div>
              <ErrorNote error={save.error ?? file.error ?? remove.error} />
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                dir="auto"
                spellCheck={false}
                className="min-h-[60vh] w-full resize-y rounded-xl border border-line bg-card-2 p-4 font-mono text-sm leading-7 outline-none focus:border-primary"
              />
              <p className="text-xs text-muted">
                نصيحة: اكتب كل منتج بسطر واحد مع السعر والمقاسات والألوان. شيل الأقواس [ ] من الأمثلة، والمساعد ما بيخترع شي مو مكتوب هون.
              </p>
            </>
          ) : (
            <p className="text-muted">ما في ملفات. اعمل ملف جديد.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

function confirmDiscard() {
  return window.confirm("في تعديلات ما انحفظت. تتركها؟");
}
