import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app reuses the desktop softphone's renderer sources (../desktop/src), so
// allow Vite to read outside the mobile/ root.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: { fs: { allow: [".."] } },
});
