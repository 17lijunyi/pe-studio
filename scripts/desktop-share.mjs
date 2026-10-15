import { packager } from "@electron/packager";
import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const localOnly = process.argv.includes("--local-only");
const staging = path.join(root, localOnly ? ".sites-runtime/local-stage" : ".sites-runtime/share-stage");
const builds = path.join(root, localOnly ? ".sites-runtime/local-builds" : ".sites-runtime/share-builds");
const output = path.join(root, "release/微信分享包");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const electronVersion = JSON.parse(await readFile(path.join(root, "node_modules/electron/package.json"), "utf8")).version;
const checksums = JSON.parse(await readFile(path.join(root, "node_modules/electron/checksums.json"), "utf8"));
const localDownloads = path.join(root, ".sites-runtime/electron-downloads");

// This staging tree is deliberately independent from the running app and its
// userData. Never copy the workspace, credentials, browser profile or history.
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
if (!localOnly) await mkdir(output, { recursive: true });
// Sign the two narrow native modules before ASAR hashes are computed.
for (const arch of ["arm64", "x64"]) {
  execFileSync("codesign", ["--force", "--sign", "-", path.join(root, "dist-desktop/native", `glass-${arch}.node`)], { stdio: "inherit" });
}
await cp(path.join(root, "dist-desktop"), path.join(staging, "dist-desktop"), { recursive: true });
await writeFile(path.join(staging, "package.json"), JSON.stringify({
  name: "pe-studio", productName: "PE Studio", version: pkg.version,
  main: "dist-desktop/main.cjs", description: "三模型提示词专家", author: "PE Studio", license: pkg.license ?? "MIT",
}, null, 2));

for (const arch of localOnly ? [process.arch] : ["arm64", "x64"]) {
  const archiveName = `electron-v${electronVersion}-darwin-${arch}.zip`;
  const runtimeZip = path.join(localDownloads, archiveName);
  let runtimeOptions = { download: { cacheRoot: path.join(root, ".sites-runtime/electron-cache") } };
  try {
    await access(runtimeZip);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(runtimeZip)) hash.update(chunk);
    if (!checksums[archiveName] || hash.digest("hex") !== checksums[archiveName]) throw new Error(`Electron checksum mismatch: ${arch}`);
    runtimeOptions = { electronZipDir: localDownloads };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const apps = await packager({
    dir: staging, out: builds, name: "PE Studio", platform: "darwin", arch,
    electronVersion, ...runtimeOptions,
    appBundleId: "com.pestudio.mac", appVersion: pkg.version, buildVersion: pkg.version,
    icon: path.join(root, "desktop/assets/icon.icns"), asar: { unpack: "{**/native/*.node,**/assets/hermes-runner.py}" }, overwrite: true, prune: false,
    extendInfo: { LSUIElement: true, NSHighResolutionCapable: true, NSHumanReadableCopyright: "PE Studio", LSMinimumSystemVersion: "13.0" },
  });
  const app = path.join(apps[0], "PE Studio.app");
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  if (localOnly) { console.log(JSON.stringify({ arch, app, localOnly: true, archiveCreated: false, userDataIncluded: false })); continue; }

  const folderName = `PE-Studio-${pkg.version}-mac-${arch}`;
  const folder = path.join(root, ".sites-runtime/share-contents", folderName);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const sharedApp = path.join(folder, "PE Studio.app");
  execFileSync("ditto", [app, sharedApp]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", sharedApp], { stdio: "inherit" });
  for (const name of ["安装与使用说明.txt", "微信转发文案.txt"]) {
    await cp(path.join(root, "docs/分享包", name), path.join(folder, name));
    await cp(path.join(root, "docs/分享包", name), path.join(output, name));
  }
  const archive = path.join(output, `${folderName}-微信分享.zip`);
  await rm(archive, { force: true });
  execFileSync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", folder, archive]);
  console.log(JSON.stringify({ arch, app, archive, signature: "ad-hoc", notarized: false, userDataIncluded: false }));
}
