import { useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import {
  Activity,
  BookOpen,
  FlaskConical,
  Hand,
  LayoutDashboard,
  LogOut,
  Menu,
  MessagesSquare,
  Settings,
  X,
} from "lucide-react";
import { api } from "../api";

const NAV = [
  { href: "/", label: "نظرة عامة", icon: LayoutDashboard },
  { href: "/inbox", label: "المحادثات", icon: MessagesSquare },
  { href: "/handoffs", label: "التحويلات للفريق", icon: Hand },
  { href: "/knowledge", label: "معلومات المساعد", icon: BookOpen },
  { href: "/playground", label: "جرّب المساعد", icon: FlaskConical },
  { href: "/activity", label: "سجل النشاط", icon: Activity },
  { href: "/settings", label: "الإعدادات", icon: Settings },
];

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const s = settings.data;
  const mode = !s ? null : !s.aiReplies ? "off" : s.testNumbers.length ? "test" : "on";

  const logout = async () => {
    await api.logout();
    queryClient.clear();
    window.location.reload();
  };

  const nav = (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? location === "/" : location.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            className={clsx(
              "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition",
              active ? "bg-primary-soft font-semibold text-primary" : "text-muted hover:bg-card-2 hover:text-fg",
            )}
          >
            <Icon size={18} />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="flex items-center gap-3 px-2 pt-2">
        <div className="grid size-10 place-items-center rounded-xl bg-primary text-lg font-bold text-white">ث</div>
        <div>
          <div className="font-bold">الثوب العربي</div>
          <div className="text-xs text-muted">لوحة المساعد الذكي</div>
        </div>
      </div>
      {mode && (
        <Link href="/settings" className="glass flex items-center gap-2 rounded-xl px-3 py-2 text-xs">
          <span
            className={clsx(
              "size-2 rounded-full",
              mode === "on" && "bg-ok shadow-[0_0_8px] shadow-ok",
              mode === "test" && "bg-warn",
              mode === "off" && "bg-muted",
            )}
          />
          {mode === "on" && "المساعد شغّال ويرد"}
          {mode === "test" && `وضع التجربة (${s!.testNumbers.length} رقم)`}
          {mode === "off" && "استماع فقط، المساعد ما بيرد"}
        </Link>
      )}
      {nav}
      <button onClick={logout} className="mt-auto flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-muted hover:text-bad">
        <LogOut size={18} />
        تسجيل الخروج
      </button>
    </div>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 border-e border-line bg-card/60 lg:block">{sidebar}</aside>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 start-0 w-72 bg-card">{sidebar}</aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 lg:hidden">
          <button onClick={() => setOpen(!open)} aria-label="القائمة" className="text-muted">
            {open ? <X /> : <Menu />}
          </button>
          <span className="font-bold">الثوب العربي</span>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
