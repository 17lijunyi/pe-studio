import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * Resolve locally installed N-API headers without downloading or scanning user directories.
 * @param {{ environment?: Record<string, string | undefined>, executablePath?: string,
 * accessImpl?: (path: string, mode: number) => Promise<void>,
 * realpathImpl?: (path: string) => Promise<string> }} [options]
 */
export async function resolveNodeHeaders({ environment = process.env, executablePath = process.execPath,
  accessImpl = access, realpathImpl = realpath } = {}) {
  if (Object.hasOwn(environment, "NODE_INCLUDE_DIR")) {
    const configured = environment.NODE_INCLUDE_DIR;
    if (typeof configured === "string" && configured.trim()) {
      const headers = resolve(configured);
      try {
        await accessImpl(join(headers, "node_api.h"), constants.R_OK);
        return headers;
      } catch { /* An explicit override must never fall back to another installation. */ }
    }
    throw new Error("NODE_INCLUDE_DIR must point to a local Node.js include/node directory containing a readable node_api.h; automatic fallback is disabled for this override.");
  }

  const executables = [executablePath];
  try { executables.push(await realpathImpl(executablePath)); } catch { /* The original executable path remains usable. */ }
  const candidates = [...new Set([
    ...executables.map(executable => resolve(dirname(executable), "../include/node")),
    "/opt/homebrew/include/node",
    "/usr/local/include/node",
  ])];
  for (const headers of candidates) {
    try {
      await accessImpl(join(headers, "node_api.h"), constants.R_OK);
      return headers;
    } catch { /* Try the next fixed local installation path. */ }
  }
  throw new Error("Local Node.js N-API headers were not found. Install Node.js development headers locally or set NODE_INCLUDE_DIR to an include/node directory containing node_api.h. No headers are downloaded automatically.");
}

/** Uses installed SDK/Node headers only; this step never downloads a toolchain. */
export async function buildNativeGlass() {
  if (process.platform !== "darwin") throw new Error("Native glass requires the macOS SDK.");
  const headers = await resolveNodeHeaders();
  let sdk;
  try {
    const { stdout } = await execute("xcrun", ["--show-sdk-path"]);
    sdk = stdout.trim();
    if (!sdk) throw new Error("No SDK selected.");
    await access(join(sdk, "System/Library/Frameworks/AppKit.framework/Headers/NSGlassEffectView.h"), constants.R_OK);
  } catch {
    throw new Error("Building native Liquid Glass requires a local macOS 26 or newer SDK containing NSGlassEffectView.h. Install/select a compatible Xcode SDK with xcode-select, then retry; this build never downloads an SDK. The app deployment target remains macOS 13.");
  }
  const source = join(root, "desktop/native/glass.mm");
  const directory = join(root, "dist-desktop/native");
  await mkdir(directory, { recursive: true });
  for (const [name, architecture] of [["arm64", "arm64"], ["x64", "x86_64"]]) {
    const output = join(directory, `glass-${name}.node`);
    const temporary = output + ".building";
    try {
      await execute("xcrun", ["clang++", "-x", "objective-c++", "-std=c++17", "-arch", architecture,
        "-isysroot", sdk, "-mmacosx-version-min=13.0", "-fobjc-arc", "-fvisibility=hidden",
        "-Wall", "-Wextra", "-Werror=unguarded-availability-new", "-framework", "Cocoa", "-framework", "ApplicationServices",
        "-bundle", "-undefined", "dynamic_lookup", "-I", headers, source, "-o", temporary], { maxBuffer: 1024 * 1024 });
      await rename(temporary, output);
      console.log(`Native glass compiled: ${name} (macOS 13 deployment target; glass guarded at macOS 26).`);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === join(dirname(fileURLToPath(import.meta.url)), "desktop-native.mjs")) await buildNativeGlass();
