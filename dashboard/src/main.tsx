import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Route, Router, Switch } from "wouter";
import { api, ApiError } from "./api";
import { Layout } from "./components/Layout";
import { Login } from "./pages/Login";
import { Overview } from "./pages/Overview";
import { Inbox } from "./pages/Inbox";
import { Handoffs } from "./pages/Handoffs";
import { Knowledge } from "./pages/Knowledge";
import { Catalog } from "./pages/Catalog";
import { Orders } from "./pages/Orders";
import { Supervisor } from "./pages/Supervisor";
import { Playground } from "./pages/Playground";
import { SettingsPage } from "./pages/Settings";
import { Activity } from "./pages/Activity";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

function App() {
  // The settings call doubles as the "am I logged in?" check.
  const session = useQuery({ queryKey: ["settings"], queryFn: api.settings, refetchInterval: 15_000 });
  const err = session.error;
  if (err instanceof ApiError && (err.status === 401 || err.status === 503)) {
    return <Login notConfigured={err.status === 503} />;
  }
  if (session.isPending) {
    return <div className="grid h-full place-items-center text-muted">جاري التحميل…</div>;
  }
  return (
    <Router base="/dashboard">
      <Layout>
        <Switch>
          <Route path="/" component={Overview} />
          <Route path="/inbox/:customer?" component={Inbox} />
          <Route path="/orders" component={Orders} />
          <Route path="/supervisor" component={Supervisor} />
          <Route path="/handoffs" component={Handoffs} />
          <Route path="/knowledge" component={Knowledge} />
          <Route path="/catalog" component={Catalog} />
          <Route path="/playground" component={Playground} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/activity" component={Activity} />
          <Route>
            <div className="p-8 text-muted">الصفحة مو موجودة.</div>
          </Route>
        </Switch>
      </Layout>
    </Router>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
