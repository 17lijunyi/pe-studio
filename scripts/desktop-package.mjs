import { packager } from "@electron/packager";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const staging = path.join(root, ".sites-runtime/desktop-stage");
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const arch of ["arm64", "x64"]) {
  execFileSync("codesign", ["--force", "--sign", "-", path.join(root, "dist-desktop/native", `glass-${arch}.node`)], { stdio: "inherit" });
}
await cp(path.join(root, "dist-desktop"), path.join(staging, "dist-desktop"), { recursive: true });
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(path.join(staging, "package.json"), JSON.stringify({
  name: "pe-studio", productName: "PE Studio", version: pkg.version,
  main: "dist-desktop/main.cjs", description: "三模型提示词专家", author: "PE Studio", license: pkg.license ?? "MIT",
}, null, 2));
const electronVersion = JSON.parse(await readFile(path.join(root, "node_modules/electron/package.json"), "utf8")).version;
const apps = await packager({
  dir: staging, out: path.join(root, "release"), name: "PE Studio",
  platform: "darwin", arch: "arm64", electronVersion,
  download: { cacheRoot: path.join(root, ".sites-runtime/electron-cache") },
  appBundleId: "com.pestudio.mac", appVersion: pkg.version, buildVersion: pkg.version,
  icon: path.join(root, "desktop/assets/icon.icns"),
  asar: { unpack: "{**/native/*.node,**/assets/hermes-runner.py}" }, overwrite: true, prune: false,
  extendInfo: { LSUIElement: true, NSHighResolutionCapable: true, NSHumanReadableCopyright: "PE Studio", LSMinimumSystemVersion: "13.0" },
});
for (const output of apps) {
  const app = path.join(output, "PE Studio.app");
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const archive = path.join(root, "release/PE-Studio-mac-arm64.zip");
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, archive]);
  console.log(JSON.stringify({ app, archive, signature: "ad-hoc", notarized: false }));
}
