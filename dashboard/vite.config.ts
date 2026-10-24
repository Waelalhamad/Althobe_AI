import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Served by the agent server at /dashboard. `npm run dev` proxies the API to a local agent on :3000.
export default defineConfig({
  base: "/dashboard/",
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/dashboard/api": "http://localhost:3000" } },
});
