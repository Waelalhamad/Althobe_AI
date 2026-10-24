import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { Lock } from "lucide-react";
import { api } from "../api";
import { Button, ErrorNote } from "../components/ui";

export function Login({ notConfigured }: { notConfigured: boolean }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api.login(password);
      await queryClient.invalidateQueries();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid h-full place-items-center p-4">
      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        onSubmit={submit}
        className="glass flex w-full max-w-sm flex-col gap-5 rounded-3xl p-8"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="grid size-14 place-items-center rounded-2xl bg-primary-soft text-primary">
            <Lock />
          </div>
          <h1 className="text-xl font-bold">لوحة المساعد الذكي</h1>
          <p className="text-sm text-muted">الثوب العربي</p>
        </div>
        {notConfigured ? (
          <p className="rounded-xl border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
            اللوحة مقفولة: لازم تنضاف كلمة سر باسم <code className="ltr">DASHBOARD_PASSWORD</code> بمتغيرات Railway.
          </p>
        ) : (
          <>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="كلمة السر"
              className="rounded-xl border border-line bg-card-2 px-4 py-3 outline-none focus:border-primary"
            />
            <ErrorNote error={error} />
            <Button disabled={busy || !password}>{busy ? "جاري الدخول…" : "دخول"}</Button>
          </>
        )}
      </motion.form>
    </div>
  );
}
