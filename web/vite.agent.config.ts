import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Build config for the standalone agent softphone. It is served by the Go
// backend under /phone (hence base: "/phone/"), from its own output directory
// so it never collides with the admin console build in ./dist.
//
// The HTML entry is agent.html; the build:agent npm script renames the emitted
// dist-agent/agent.html to index.html so the backend's /phone handler can serve
// it as the SPA fallback.
export default defineConfig({
  base: "/phone/",
  plugins: [react()],
  build: {
    outDir: "dist-agent",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(__dirname, "agent.html"),
    },
  },
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:8080",
    },
  },
});
