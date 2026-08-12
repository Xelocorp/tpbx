// Copies the renderer's static assets (HTML + CSS) into dist/renderer so the
// packaged app can load them next to the esbuild-produced renderer.js.
import { mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outDir = join(root, "dist", "renderer");
mkdirSync(outDir, { recursive: true });

for (const f of ["index.html", "styles.css"]) {
  copyFileSync(join(root, "src", "renderer", f), join(outDir, f));
}
console.log("copied renderer static assets -> dist/renderer");
