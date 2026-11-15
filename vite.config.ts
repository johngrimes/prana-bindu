import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiTarget = process.env.PRANA_DEV_API ?? "http://localhost:3000";

export default defineConfig({
  root: "src/web",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": apiTarget,
      "/mcp": apiTarget,
      "/oauth": apiTarget,
      "/.well-known/oauth-": apiTarget,
    },
  },
  test: {
    root: ".",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scriptable/**/*.test.ts"],
    environment: "node",
  },
});
