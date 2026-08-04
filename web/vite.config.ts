import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// During development the Go backend runs on :8080. Vite serves the UI on :5173
// and proxies API + WebSocket traffic to the backend so the browser sees a
// single origin. `npm run build` emits static files into ./dist, which the Go
// binary serves in production (TPBX_WEB_DIR=web/dist).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/ws": {
        target: "ws://127.0.0.1:8080",
        ws: true,
      },
    },
  },
});
