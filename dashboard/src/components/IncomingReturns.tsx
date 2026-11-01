import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { PackageX, Shuffle, Undo2 } from "lucide-react";
import { api, type IncomingReturn, type Order } from "../api";
import { Badge, Card, ErrorNote } from "./ui";
import { DARB_STATUS } from "./DarbSend";
import { DarbRedirect } from "./DarbRedirect";
import { ago, phone } from "../format";

const piece = (i: IncomingReturn["items"][number]) => `${i.quantity > 1 ? `${i.quantity} × ` : ""}${i.color} ${i.size}`.trim();

// Why the goods come back, in a word.
function why(r: IncomingReturn): { label: string; tone: "warn" | "bad" | "info" | "ok" } {
  if (r.back) return { label: "رجعت", tone: "ok" };
  if (r.darbStatus === "returning") return { label: "الزبون رفضها، راجعة", tone: "bad" };
  if (r.darbStatus === "cancelled") return { label: "انلغت عند درب", tone: "bad" };
  return { label: "انلغى الطلب، الشحنة لسا طالعة", tone: "warn" };
}

// Everything on its way back to us (cancelled, refused, cancelled at Darb), so the team decides where each piece goes:
// to another customer in the same city, or back to the store. The ones back in the last 14 days are below.
export function IncomingReturns() {
  const q = useQuery({ queryKey: ["incoming-returns"], queryFn: api.incomingReturns, refetchInterval: 60_000 });
  const [redirecting, setRedirecting] = useState<Order>();
  const [opening, setOpening] = useState<number>();
  const coming = (q.data ?? []).filter((r) => !r.back);
  const back = (q.data ?? []).filter((r) => r.back);

  // The pieces coming back, added up by color and size.
  const totals = new Map<string, number>();
  for (const r of coming) for (const i of r.items) totals.set(`${i.color} ${i.size}`.trim(), (totals.get(`${i.color} ${i.size}`.trim()) ?? 0) + i.quantity);

  const open = async (orderId: number) => {
    setOpening(orderId);
    try {
      const found = (await api.orders({ q: `#${orderId}` })).orders[0];
      if (found) setRedirecting(found);
    } finally {
      setOpening(undefined);
    }
  };

  if (q.isLoading) return null;
  return (
    <Card className={coming.length ? "flex flex-col gap-4 border border-warn/40" : "flex flex-col gap-4"}>
      <ErrorNote error={q.error} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <Undo2 size={18} className={coming.length ? "text-warn" : "text-muted"} />
          بضاعة راجعة لعنا
          {coming.length > 0 && <Badge tone="warn">{coming.length} شحنة</Badge>}
        </h2>
        {coming.length > 0 && <span className="text-xs text-muted">قرّروا لكل وحدة: تتحول لزبون تاني بنفس المدينة، ولا ترجع للمخزن</span>}
      </div>

      {coming.length === 0 ? (
        <p className="text-sm text-muted">ما في شي راجع هلق 👌</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {[...totals].map(([k, n]) => (
              <span key={k} className="rounded-xl bg-card-2 px-3 py-1 text-sm">
                {k} <span className="num font-semibold">× {n}</span>
              </span>
            ))}
          </div>
          <div className="flex flex-col divide-y divide-line">
            {coming.map((r) => (
              <Row key={r.orderId} r={r}>
                {r.matches > 0 ? (
                  <button
                    disabled={opening === r.orderId}
                    onClick={() => void open(r.orderId)}
                    className="flex items-center gap-1 rounded-xl bg-primary-soft px-3 py-1.5 text-sm text-primary hover:bg-primary hover:text-white"
                  >
                    <Shuffle size={15} /> حوّلها ({r.matches} {r.matches === 1 ? "طلب متلو" : "طلبات متلو"})
                  </button>
                ) : (
                  <span className="text-xs text-muted">ما في طلب متلو بنفس المدينة</span>
                )}
              </Row>
            ))}
          </div>
        </>
      )}

      {back.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">رجعت آخر 14 يوم ({back.length})</summary>
          <div className="mt-2 flex flex-col divide-y divide-line">
            {back.map((r) => (
              <Row key={r.orderId} r={r} />
            ))}
          </div>
        </details>
      )}
      {redirecting && <DarbRedirect order={redirecting} onClose={() => setRedirecting(undefined)} />}
    </Card>
  );
}

function Row({ r, children }: { r: IncomingReturn; children?: React.ReactNode }) {
  const w = why(r);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <PackageX size={16} className="text-muted" />
          <span className="font-medium">{r.items.map(piece).join("، ")}</span>
          <Badge tone={w.tone}>{w.label}</Badge>
          <Badge>{DARB_STATUS[r.darbStatus] ?? r.darbStatus}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span>
            طلب <span className="num">#{r.orderId}</span>
          </span>
          <Link href={`/inbox/${encodeURIComponent(r.customer)}`} className="hover:text-primary">
            المحادثة
          </Link>
          <span>{r.name}</span>
          <span className="ltr num">{phone(r.phone || r.customer)}</span>
          <span>{r.city}</span>
          <span className="ltr num">{r.reference}</span>
          <span>{ago(r.since)}</span>
        </div>
        {r.lastEvent && <div className="text-xs text-muted">{r.lastEvent}</div>}
      </div>
      {children}
    </div>
  );
}
