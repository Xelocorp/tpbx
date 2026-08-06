import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Build config for the browser-extension softphone. Emits the popup, options,
// offscreen (Chrome) and background (Firefox) pages plus the service worker
// into dist-ext with stable, unhashed entry names so the manifests can
// reference them. base "./" keeps asset URLs relative to the extension root.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist-ext",
    emptyOutDir: true,
    target: "esnext",
    rollupOptions: {
      input: {
        popup: resolve(__dirname, "popup.html"),
        options: resolve(__dirname, "options.html"),
        offscreen: resolve(__dirname, "offscreen.html"),
        background: resolve(__dirname, "background.html"),
        sw: resolve(__dirname, "src/ext/sw.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
