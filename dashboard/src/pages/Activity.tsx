import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon, Search } from "lucide-react";
import { api } from "../api";
import { Card, Empty, ErrorNote, PageHeader } from "../components/ui";
import { phone, time } from "../format";

export function Activity() {
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setSearch(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);
  const events = useQuery({ queryKey: ["events", search], queryFn: () => api.events(search), refetchInterval: 5_000 });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="سجل النشاط"
        subtitle="كل شي عملو السيرفر: رسائل وصلت، ردود، تحويلات، أخطاء. آخر 30 يوم."
        actions={
          <label className="flex items-center gap-2 rounded-xl border border-line bg-card-2 px-3 py-2 focus-within:border-primary">
            <Search size={16} className="text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="فلترة…" className="w-48 bg-transparent text-sm outline-none" />
          </label>
        }
      />
      <ErrorNote error={events.error} />
      <Card className="p-0">
        {events.data?.length === 0 && <Empty icon={ActivityIcon} text="ما في نشاط." />}
        <ul className="ltr divide-y divide-line font-mono text-xs">
          {events.data?.map((e) => {
            const number = e.conversation.startsWith("wa:") ? e.conversation.slice(3) : undefined;
            const tone = /error|failed/i.test(e.message) ? "text-bad" : /handed off|handoff/i.test(e.message) ? "text-warn" : /replied$/.test(e.message) ? "text-ok" : "text-muted";
            return (
              <li key={e.id} className="flex flex-col gap-1 px-4 py-2 sm:flex-row sm:gap-4">
                <span className="shrink-0 text-muted">{time(e.at)}</span>
                <span className="w-44 shrink-0 truncate">
                  {number && /^\d+$/.test(number) ? (
                    <Link href={`/inbox/${number}`} className="text-primary hover:underline">
                      {phone(number)}
                    </Link>
                  ) : (
                    e.conversation
                  )}
                </span>
                <span className={tone}>{e.message}</span>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
