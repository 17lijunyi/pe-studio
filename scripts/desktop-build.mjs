import { build as bundle } from "esbuild";
import { build as viteBuild } from "vite";
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildNativeGlass } from "./desktop-native.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(path.join(root, "dist-desktop"), { recursive: true });
await buildNativeGlass();
await viteBuild({ configFile: path.join(root, "desktop/vite.config.ts") });
for (const entry of ["main", "preload"]) {
  await bundle({
    entryPoints: [path.join(root, `desktop/${entry}.ts`)],
    outfile: path.join(root, `dist-desktop/${entry}.cjs`),
    bundle: true, platform: "node", format: "cjs", target: "node22",
    external: ["electron"], sourcemap: false,
    define: { "process.env.NODE_ENV": '"production"' },
  });
}
await cp(path.join(root, "desktop/assets"), path.join(root, "dist-desktop/assets"), { recursive: true });
console.log("Desktop build ready: dist-desktop/");
