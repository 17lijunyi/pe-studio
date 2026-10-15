import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
export default defineConfig({
  root: fileURLToPath(new URL("./renderer", import.meta.url)),
  base: "/",
  plugins: [react()],
  publicDir: `${project}/public`,
  resolve: { alias: { "@": project } },
  build: { outDir: `${project}/dist-desktop/renderer`, emptyOutDir: true, sourcemap: false, target: "chrome140" },
});
