import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Hand } from "lucide-react";
import { api, CHANNEL_LABEL, type Channel } from "../api";
import { Badge, Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { ago, country, phone, time } from "../format";

export function Handoffs() {
  const [days, setDays] = useState(7);
  const q = useQuery({ queryKey: ["handoffs", days], queryFn: () => api.handoffs(days), refetchInterval: 15_000 });

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="التحويلات للفريق"
        subtitle="كل مرة المساعد ما عرف يجاوب أو الزبون طلب موظف. السبب مكتوب من المساعد نفسه (بالإنجليزي)."
        actions={[1, 7, 30].map((n) => (
          <button
            key={n}
            onClick={() => setDays(n)}
            className={`rounded-xl px-3 py-1.5 text-sm ${days === n ? "bg-primary text-white" : "bg-card-2 text-muted hover:text-fg"}`}
          >
            {n === 1 ? "اليوم" : `${n} يوم`}
          </button>
        ))}
      />
      <ErrorNote error={q.error} />
      <Card className="p-0">
        {q.data?.length === 0 && <Empty icon={Hand} text="ما في تحويلات بهالفترة." />}
        <ul className="divide-y divide-line">
          {q.data?.map((h) => (
            <li key={h.id}>
              <Link
                href={h.channel !== "chatwoot" ? `/inbox/${h.customer}` : "/handoffs"}
                className="flex flex-col gap-2 px-5 py-4 hover:bg-card-2 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-48 flex-col">
                  <span className="ltr num text-start font-semibold">{phone(h.customer)}</span>
                  <span className="text-xs text-muted">
                    {h.channel === "whatsapp" ? `واتساب · ${country(h.customer)}` : CHANNEL_LABEL[h.channel as Channel]} · {time(h.at)}
                  </span>
                </div>
                <p className="ltr flex-1 text-start text-sm text-muted">{h.reason ?? "—"}</p>
                <div className="flex shrink-0 gap-2">
                  {h.action === "error" ? <Badge tone="bad">خطأ</Badge> : <Badge tone="warn">تحويل</Badge>}
                  {h.channel !== "chatwoot" && (h.stillWithTeam ? <Badge tone="info">مع الفريق</Badge> : <Badge tone="primary">رجعت للمساعد</Badge>)}
                  <span className="text-xs text-muted">{ago(h.at)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
