// The Libya employee's phone: the shipments Darb says came back to us. He presses «استلمت الراجع» once the goods are in
// his hands, and their pieces are sold again (until then they stay held, so the assistant never sells them).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageCheck } from "lucide-react";
import { api } from "../api";
import { Card, ErrorNote } from "./ui";
import { pieceWithProduct } from "./IncomingReturns";
import { ago } from "../format";

export function StaffReturns() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["staff-returns"], queryFn: api.staffReturns, refetchInterval: 60_000 });
  const receive = useMutation({
    mutationFn: (orderId: number) => api.staffReceiveReturn(orderId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["staff-returns"] }),
  });
  const rows = q.data ?? [];
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-lg font-bold">الراجع</h1>
      <p className="text-sm text-muted">
        هدول درب بتقول إنهن رجعولنا. لما توصلك الشحنة وتتأكد إنو القطع كاملة ومنيحة، اكبس «استلمت الراجع». إذا ناقصة أو مضروبة لا تكبس، واكتب للإدارة.
      </p>
      <ErrorNote error={q.error ?? receive.error} />
      {q.isLoading ? null : rows.length === 0 ? (
        <Card>
          <p className="py-4 text-center text-sm text-muted">ما في شي راجع ناطر تأكيد 👌</p>
        </Card>
      ) : (
        rows.map((r) => (
          <Card key={r.orderId} className="flex flex-col gap-2">
            <div className="font-semibold">{r.items.map(pieceWithProduct).join("، ")}</div>
            <div className="flex flex-wrap gap-x-3 text-xs text-muted">
              <span>
                طلب <span className="num">#{r.orderId}</span>
              </span>
              <span>{r.name}</span>
              <span>{r.city}</span>
              <span className="ltr num">{r.reference}</span>
              <span>{ago(r.since)}</span>
            </div>
            <button
              disabled={receive.isPending}
              onClick={() => {
                if (window.confirm(`استلمت ${r.items.map(pieceWithProduct).join("، ")} بإيدك؟`)) receive.mutate(r.orderId);
              }}
              className="mt-1 flex items-center justify-center gap-2 rounded-xl bg-primary py-2.5 font-semibold text-white disabled:opacity-50"
            >
              <PackageCheck size={18} /> استلمت الراجع
            </button>
          </Card>
        ))
      )}
    </div>
  );
}
