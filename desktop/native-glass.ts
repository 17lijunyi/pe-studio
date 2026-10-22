import { app, type BrowserWindow } from "electron";
import { createRequire } from "node:module";
import { join } from "node:path";

export interface NativeGlassStatus {
  ok: boolean;
  supported: boolean;
  enabled: boolean;
  mainThread?: boolean;
  responderPreserved?: boolean;
  style?: "clear" | "regular";
  cornerRadius?: number;
  reason?: string;
}
interface NativeGlassModule {
  setGlass(handle: Buffer, enabled: boolean): NativeGlassStatus;
  status(handle?: Buffer): NativeGlassStatus;
  shortcutKeyDown(accelerator: string): boolean | null;
}

let native: NativeGlassModule | null | undefined;
let loadReason = "native-module-unavailable";

function loadNative(): NativeGlassModule | null {
  if (native !== undefined) return native;
  native = null;
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch)) { loadReason = "unsupported-platform"; return null; }
  try {
    const appPath = app.getAppPath();
    const packageRoot = appPath.endsWith(".asar") ? appPath + ".unpacked" : appPath;
    const requireNative = createRequire(join(appPath, "package.json"));
    const addon = requireNative(join(packageRoot, "dist-desktop", "native", `glass-${process.arch}.node`)) as NativeGlassModule;
    if (typeof addon.setGlass !== "function" || typeof addon.status !== "function") { loadReason = "invalid-native-module"; return null; }
    native = addon;
  } catch { loadReason = "native-module-unavailable"; }
  return native;
}

/** Main-process only. Native handles never cross IPC or outlive their window. */
export function setNativeGlass(window: BrowserWindow, enabled: boolean): NativeGlassStatus {
  if (window.isDestroyed()) return { ok: false, supported: false, enabled: false, reason: "window-destroyed" };
  const addon = loadNative();
  if (!addon) return { ok: !enabled, supported: false, enabled: false, reason: loadReason };
  try {
    const before = addon.status(window.getNativeWindowHandle());
    const result = addon.setGlass(window.getNativeWindowHandle(), enabled);
    if (result.ok && result.enabled !== before.enabled) {
      // Reparenting keeps NSView frames intact, but Chromium can retain its old
      // viewport after detaching. A synchronous public-API resize round trip
      // invalidates that cache; no intermediate frame is awaited or presented.
      const [width, height] = window.getSize();
      window.setSize(width + 1, height);
      window.setSize(width, height);
    }
    return result;
  }
  catch { return { ok: false, supported: false, enabled: false, reason: "native-call-failed" }; }
}

export function nativeGlassStatus(window?: BrowserWindow): NativeGlassStatus {
  if (window?.isDestroyed()) return { ok: false, supported: false, enabled: false, reason: "window-destroyed" };
  const addon = loadNative();
  if (!addon) return { ok: false, supported: false, enabled: false, reason: loadReason };
  try { return window ? addon.status(window.getNativeWindowHandle()) : addon.status(); }
  catch { return { ok: false, supported: false, enabled: false, reason: "native-call-failed" }; }
}

/** Query only the registered shortcut while its main-process latch is active. */
export function shortcutKeyDown(accelerator: string): boolean | null {
  const addon = loadNative();
  if (!addon || typeof addon.shortcutKeyDown !== "function") return null;
  try { const value = addon.shortcutKeyDown(accelerator); return typeof value === "boolean" ? value : null; }
  catch { return null; }
}
