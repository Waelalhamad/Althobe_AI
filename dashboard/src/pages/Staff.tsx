// The Libya employee's phone page: his cash and his stock, nothing else (the server allows him nothing else).
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Boxes, LogOut, Wallet } from "lucide-react";
import { api } from "../api";
import { ErrorNote } from "../components/ui";
import { amount, CashButtons, CashList, lyd } from "../components/StaffCash";
import { StaffStock } from "../components/StaffStock";

export function useStaffCash(limit = 100) {
  return useQuery({ queryKey: ["staff-cash", limit], queryFn: () => api.staffCash(limit), refetchInterval: 30_000 });
}

export function StaffHome() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"cash" | "stock">("cash");
  const cash = useStaffCash(50);
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const todays = (cash.data?.rows ?? []).filter((r) => r.at >= dayStart && r.undoes === null && r.undoneBy === null);
  const today = {
    in: todays.filter((r) => r.direction === "in").reduce((n, r) => n + r.amount, 0),
    out: todays.filter((r) => r.direction === "out").reduce((n, r) => n + r.amount, 0),
  };
  const logout = async () => {
    await api.logout();
    queryClient.clear();
    window.location.reload();
  };

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col">
      <header className="flex items-center gap-3 px-4 pt-4">
        <div className="grid size-9 place-items-center rounded-xl bg-primary font-bold text-white">ث</div>
        <span className="font-bold">الثوب العربي · ليبيا</span>
        <button onClick={logout} className="ms-auto text-muted" aria-label="تسجيل الخروج">
          <LogOut size={20} />
        </button>
      </header>

      <main className="flex flex-1 flex-col gap-4 p-4 pb-28">
        {tab === "cash" ? (
          <>
            <ErrorNote error={cash.error} />
            <div className="glass rounded-3xl p-6 text-center">
              <div className="text-sm text-muted">المصاري يلي معك هلق</div>
              <div className={clsx("num mt-1 text-4xl font-bold", (cash.data?.balance ?? 0) < 0 && "text-bad")}>
                {cash.data ? lyd(cash.data.balance) : "…"}
              </div>
              {(today.in > 0 || today.out > 0) && (
                <div className="mt-2 text-sm text-muted">
                  اليوم: <span className="num ltr text-ok">+{amount(today.in)}</span> · <span className="num ltr text-bad">−{amount(today.out)}</span>
                </div>
              )}
            </div>
            {cash.data && <CashButtons kinds={cash.data.kinds} />}
            <div className="glass rounded-2xl px-4">
              <h2 className="pt-4 font-semibold">آخر الحركات</h2>
              <CashList rows={cash.data?.rows ?? []} mineOnly />
            </div>
          </>
        ) : (
          <StaffStock />
        )}
      </main>

      <nav className="fixed inset-x-0 bottom-0 border-t border-line bg-card pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto grid max-w-md grid-cols-2">
          {(
            [
              ["cash", "الصندوق", Wallet],
              ["stock", "المخزون", Boxes],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={clsx("flex flex-col items-center gap-1 py-3 text-sm", tab === id ? "font-semibold text-primary" : "text-muted")}
            >
              <Icon size={22} />
              {label}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
