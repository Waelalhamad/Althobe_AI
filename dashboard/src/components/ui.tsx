// Small shared building blocks.
import type { ReactNode } from "react";
import clsx from "clsx";
import type { LucideIcon } from "lucide-react";

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx("glass rounded-2xl p-5", className)}>{children}</div>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({
  icon: Icon,
  label,
  value,
  hint,
  tone = "primary",
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: "primary" | "ok" | "warn" | "bad" | "info";
}) {
  const tones = {
    primary: "text-primary bg-primary-soft",
    ok: "text-ok bg-ok/12",
    warn: "text-warn bg-warn/12",
    bad: "text-bad bg-bad/12",
    info: "text-info bg-info/12",
  };
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted">{label}</span>
        <span className={clsx("grid size-9 place-items-center rounded-xl", tones[tone])}>
          <Icon size={18} />
        </span>
      </div>
      <div className="num text-3xl font-bold">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </Card>
  );
}

export function Badge({ tone = "muted", children }: { tone?: "muted" | "primary" | "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  const tones = {
    muted: "bg-card-2 text-muted",
    primary: "bg-primary-soft text-primary",
    ok: "bg-ok/12 text-ok",
    warn: "bg-warn/12 text-warn",
    bad: "bg-bad/12 text-bad",
    info: "bg-info/12 text-info",
  };
  return <span className={clsx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone])}>{children}</span>;
}

export function Button({
  variant = "primary",
  className,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-primary text-white hover:brightness-110",
        variant === "ghost" && "border border-line bg-card-2 text-fg hover:border-primary/60",
        variant === "danger" && "border border-bad/40 bg-bad/10 text-bad hover:bg-bad/20",
        className,
      )}
    />
  );
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50",
        checked ? "bg-primary" : "bg-line",
      )}
    >
      <span className={clsx("absolute top-1 size-5 rounded-full bg-white transition-all", checked ? "start-6" : "start-1")} />
    </button>
  );
}

export function Empty({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-center text-muted">
      <Icon size={32} className="opacity-60" />
      <p className="text-sm">{text}</p>
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <p className="rounded-xl border border-bad/30 bg-bad/10 px-3 py-2 text-sm text-bad">{error instanceof Error ? error.message : String(error)}</p>;
}
