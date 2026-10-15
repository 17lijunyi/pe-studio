import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, protocol, safeStorage, screen, session, systemPreferences, Tray } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import type { DesktopAppearance, DesktopCredentials, DesktopResultVisibility, DesktopShortcut, DesktopWorkspaceSection } from "./bridge";
import type { PublicStudioState, WorkspaceCommand } from "./workspace-contract";
import { APP_ORIGIN, createDesktopHandler, DESKTOP_TOKEN_HEADER, isAppUrl } from "./server";
import { validateBrief } from "../lib/request-validation";
import { listLocalAgents, generateLocalCandidate } from "./local-agents";
import { createSettingsLeaveGuard, type SettingsDraftAction } from "./settings-leave";
import { runDesktopSmoke } from "./smoke";
import { nativeGlassStatus, setNativeGlass, shortcutKeyDown } from "./native-glass";

const DEFAULT_SHORTCUT = "Control+Q";
const FALLBACK_SHORTCUT = "CommandOrControl+Shift+P";
const PARTITION = "persist:pe-studio";
const apiToken = randomBytes(32).toString("hex");
let mainWindow: BrowserWindow | null = null;
let workspaceWindow: BrowserWindow | null = null;
let workspaceReady: Promise<void> | undefined;
let workspaceSection: DesktopWorkspaceSection = "library";
const resultWindows = new Map<string, BrowserWindow>();
const resultReady = new Map<string, Promise<void>>();
const openedResults = new Set<string>();
let lastResultVisibility = "";
let resultVisibilityQueued = false;
let selectedResultId: string | undefined;
let resultSelectionVersion = 0;
let groupState: "hidden" | "visible" | "hiding" = "hidden";
let presentationEpoch = 0;
let panelAnchor: { x: number; y: number } | undefined;
let movingGroup = false;
let focusTimer: ReturnType<typeof setTimeout> | undefined;
let positionTimer: ReturnType<typeof setTimeout> | undefined;
const knownBounds = new Map<number, Electron.Rectangle>();
const nativeInteractions = new Map<number, number>();
let hideTimer: ReturnType<typeof setTimeout> | undefined;
let materialTimer: ReturnType<typeof setTimeout> | undefined;
let panelAnimating = false;
let publicState: PublicStudioState | null = null;
let workspaceTransitionVersion = 0;
const settingsActionRequests = new Map<string, { windowId: number; resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
const settingsLeaveGuard = createSettingsLeaveGuard({
  choose: async () => {
    if (!workspaceWindow || workspaceWindow.isDestroyed()) return "continue";
    const response = await dialog.showMessageBox(workspaceWindow, {
      type: "question", message: "模型已修改，尚未保存", detail: "请选择保存修改、放弃修改，或留在设置中继续编辑。",
      buttons: ["保存", "放弃修改", "继续编辑"], defaultId: 0, cancelId: 2, noLink: true,
    });
    return response.response === 0 ? "save" : response.response === 1 ? "discard" : "continue";
  },
  apply: requestSettingsAction,
});

function needsSettingsLeaveGuard(): boolean {
  return Boolean(workspaceWindow && !workspaceWindow.isDestroyed() && workspaceSection === "settings" && settingsLeaveGuard.isDirty());
}

function requestSettingsAction(action: SettingsDraftAction): Promise<boolean> {
  const window = workspaceWindow;
  if (!window || window.isDestroyed()) return Promise.resolve(false);
  return new Promise(resolve => {
    const requestId = randomUUID();
    const timer = setTimeout(() => { settingsActionRequests.delete(requestId); resolve(false); }, 60_000);
    settingsActionRequests.set(requestId, { windowId: window.id, resolve, timer });
    window.webContents.send("pe:settings-action", { requestId, action });
  });
}

function cancelSettingsActions(): void {
  for (const request of settingsActionRequests.values()) { clearTimeout(request.timer); request.resolve(false); }
  settingsActionRequests.clear();
}

function requestWorkspaceClose(): void {
  const ticket = ++workspaceTransitionVersion;
  const finish = () => {
    if (ticket !== workspaceTransitionVersion || !workspaceWindow || workspaceWindow.isDestroyed() || quitting) return;
    workspaceWindow.hide();
    if (process.platform === "darwin") app.dock?.hide();
  };
  if (needsSettingsLeaveGuard()) void settingsLeaveGuard.confirm().then(allowed => { if (allowed) finish(); });
  else finish();
}

const localRequests = new Map<string, AbortController>();
let volatileCredentials: DesktopCredentials | undefined;
let credentialReadFailed = false;
let accessibilitySubscription: number | undefined;
let tray: Tray | null = null;
let quitting = false;
let shortcut = DEFAULT_SHORTCUT;
let credentialQueue: Promise<unknown> = Promise.resolve();
let shortcutQueue: Promise<unknown> = Promise.resolve();
let shortcutReady: Promise<void> = Promise.resolve();
let shortcutPressLatched = false;
let shortcutReleaseTimer: ReturnType<typeof setTimeout> | undefined;

app.setName("PE Studio");
const smokeDirectory = !app.isPackaged ? process.env.PE_STUDIO_SMOKE_DIR : undefined;
if (smokeDirectory) {
  const isolatedData = join(smokeDirectory, "user-data");
  mkdirSync(isolatedData, { recursive: true, mode: 0o700 });
  app.setPath("userData", isolatedData);
}
protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

function credentialsPath(): string { return join(app.getPath("userData"), "credentials.enc"); }
function preferencesPath(): string { return join(app.getPath("userData"), "desktop-preferences.json"); }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

// Public synchronization has an explicit schema. In particular, apiKey and other
// undeclared fields cannot travel through the workspace snapshot or commands.
const shortText = z.string().max(500);
const briefSchema = z.object({
  direction: z.enum(["general", "image", "video", "product"]), input: z.string().max(30_000),
  targetModel: shortText, context: z.string().max(30_000), constraints: z.string().max(30_000),
  intensity: z.enum(["faithful", "balanced", "creative"]), outputLanguage: z.enum(["zh", "en"]),
}).strict();
const configSchema = z.object({
  writers: z.array(z.object({
    id: z.string().max(100), label: shortText,
    protocol: z.enum(["openai-responses", "openai-compatible", "anthropic", "gemini", "aihubmix", "deepseek", "local-agent"]),
    model: shortText, baseUrl: z.string().max(2048),
  }).strict()).max(3),
  judge: z.object({ model: shortText, baseUrl: z.string().max(2048) }).strict(),
}).strict();
const candidateSchema = z.object({
  id: z.string().max(100), provider: shortText, model: shortText, prompt: z.string().max(100_000),
  changes: z.array(z.string().max(5000)).max(50), assumptions: z.array(z.string().max(5000)).max(50),
  status: z.enum(["success", "error"]), error: z.string().max(5000).optional(), latencyMs: z.number().finite().nonnegative(),
}).strict();
const judgeSchema = z.object({
  status: z.enum(["complete", "unavailable"]),
  candidates: z.array(z.object({
    candidateId: z.string().max(100), score: z.number().finite().min(0).max(100),
    dimensions: z.array(z.object({ id: shortText, label: shortText, score: z.number().finite(), confidence: z.number().finite() }).strict()).max(10),
    eligible: z.boolean(), violations: z.array(z.string().max(5000)).max(20),
  }).strict()).max(3),
  recommendedId: z.string().max(100).nullable(), tiedIds: z.array(z.string().max(100)).max(3),
  summary: z.string().max(10_000), model: shortText.optional(), evaluatedAt: z.string().max(100),
}).strict();
const sessionSchema = z.object({
  id: z.string().max(100), createdAt: z.string().max(100), brief: briefSchema,
  connectionSnapshot: configSchema.shape.writers.optional(),
  candidateOrder: z.array(z.string().regex(/^(?:writer-[123]|demo-[abc])$/)).min(1).max(3).refine(ids => new Set(ids).size === ids.length).optional(),
  candidates: z.array(candidateSchema).max(3), judge: judgeSchema.nullable(), demo: z.boolean(), favorite: z.boolean(),
}).strict();
const publicStateSchema = z.object({
  brief: briefSchema, config: configSchema, history: z.array(sessionSchema).max(20), session: sessionSchema.nullable(),
  runConnections: configSchema.shape.writers,
  pending: z.array(z.string().max(100)).max(3), judging: z.boolean(), running: z.boolean(),
  modelsRevealed: z.boolean(),
  credentialsStatus: z.enum(["loading", "ready", "failed"]),
}).strict();
const commandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("update-brief"),
    patch: briefSchema.pick({ targetModel: true, context: true, constraints: true, intensity: true, outputLanguage: true }).strict(),
  }).strict(),
  ...(["new-session", "open-demo", "retry-judge", "credentials-changed", "reveal-models"] as const).map(type => z.object({ type: z.literal(type) }).strict()),
  ...(["restore-session", "delete-session", "toggle-favorite", "retry-candidate"] as const).map(type => z.object({ type: z.literal(type), id: z.string().min(1).max(100) }).strict()),
  z.object({ type: z.literal("config-updated"), config: configSchema }).strict(),
]);

function isReasonablePayload(value: unknown, maxBytes: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= maxBytes; } catch { return false; }
}

function validateCredentials(value: unknown): DesktopCredentials {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "jev,writers" || !isPlainObject(value.writers)) {
    throw new Error("密钥格式无效。");
  }
  const entries = Object.entries(value.writers);
  if (entries.length > 3) throw new Error("最多保存三个生成模型的密钥。");
  const cleanKey = (key: unknown): string => {
    if (typeof key !== "string" || key.length > 2048 || /[\x00-\x1f\x7f]/.test(key)) throw new Error("API Key 格式无效。");
    return key.trim();
  };
  const writers: Record<string, string> = {};
  for (const [id, key] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("模型标识无效。");
    writers[id] = cleanKey(key);
  }
  return { writers, jev: cleanKey(value.jev) };
}

async function atomicWrite(path: string, contents: string | Buffer): Promise<void> {
  await mkdir(app.getPath("userData"), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally { await unlink(temporary).catch(() => undefined); }
}

async function asyncEncryptionAvailable(): Promise<boolean> {
  if (typeof safeStorage.isAsyncEncryptionAvailable !== "function" || typeof safeStorage.encryptStringAsync !== "function" || typeof safeStorage.decryptStringAsync !== "function") return false;
  // Never opt into a plaintext or fixed-key fallback.
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") return false;
  try { return await safeStorage.isAsyncEncryptionAvailable(); } catch { return false; }
}

async function readCredentials(): Promise<DesktopCredentials> {
  if (volatileCredentials) return validateCredentials(volatileCredentials);
  let encrypted: Buffer;
  try {
    const info = await stat(credentialsPath());
    if (info.size > 32 * 1024) throw new Error("invalid stored credentials");
    encrypted = await readFile(credentialsPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { writers: {}, jev: "" };
    throw new Error("无法读取已保存密钥，文件未被修改。");
  }
  if (!(await asyncEncryptionAvailable())) throw new Error("系统钥匙串暂不可用，已保存密钥未被修改。你仍可在本次会话中填写密钥。");
  try {
    const decrypted = await safeStorage.decryptStringAsync(encrypted);
    const credentials = validateCredentials(JSON.parse(decrypted.result));
    if (decrypted.shouldReEncrypt) {
      const rotated = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
      await atomicWrite(credentialsPath(), rotated);
    }
    volatileCredentials = credentials;
    return validateCredentials(credentials);
  } catch { throw new Error("系统无法解密已保存密钥，文件未被修改。请检查钥匙串访问权限。"); }
}

async function persistCredentials(value: unknown, sessionOnly = false): Promise<{ ok: boolean; applied: boolean; persisted: boolean; error?: string }> {
  let credentials: DesktopCredentials;
  try { credentials = validateCredentials(value); }
  catch { return { ok: false, applied: false, persisted: false, error: "密钥格式无效，请重新填写。" }; }
  // Explicit session-only updates are separate from a confirmed persistent save.
  // A failed persistent save must leave the previous in-memory keys intact.
  if (sessionOnly) { volatileCredentials = credentials; return { ok: true, applied: true, persisted: false }; }
  if (credentialReadFailed) return { ok: false, applied: false, persisted: false, error: "原有密钥读取失败，本次修改未应用；未修改已保存密钥。" };
  if (!credentials.jev && Object.values(credentials.writers).every(key => !key)) {
    try { await unlink(credentialsPath()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, applied: false, persisted: false, error: "未能清除已保存密钥，请检查本地文件权限。" }; }
    volatileCredentials = credentials;
    return { ok: true, applied: true, persisted: true };
  }
  if (!(await asyncEncryptionAvailable())) return { ok: false, applied: false, persisted: false, error: "系统钥匙串暂不可用，密钥与设置均未应用，请重试。" };
  try {
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(credentials));
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw new Error("empty encryption result");
    await atomicWrite(credentialsPath(), encrypted);
    volatileCredentials = credentials;
    return { ok: true, applied: true, persisted: true };
  } catch { return { ok: false, applied: false, persisted: false, error: "密钥加密保存失败，未保存明文；请检查钥匙串访问权限后重试。" }; }
}

function validAccelerator(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 80 || !value.length) return false;
  const parts = value.split("+");
  if (parts.length < 2 || parts.length > 5) return false;
  const key = parts.pop()!;
  const modifiers = /^(CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|Option|Shift|Super|Meta)$/i;
  return parts.every(part => modifiers.test(part)) && parts.some(part => !/^shift$/i.test(part)) &&
    /^(?:[A-Z0-9,./;\-=`\[\]\\]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|Plus)$/i.test(key);
}

function shortcutState(): DesktopShortcut {
  return { accelerator: shortcut, registered: globalShortcut.isRegistered(shortcut) };
}

function releaseShortcutPress(): void {
  shortcutPressLatched = false;
  if (shortcutReleaseTimer) clearTimeout(shortcutReleaseTimer);
  shortcutReleaseTimer = undefined;
}

function scheduleShortcutRelease(): void {
  if (shortcutReleaseTimer) clearTimeout(shortcutReleaseTimer);
  const supported = shortcutKeyDown(shortcut) !== null;
  shortcutReleaseTimer = setTimeout(() => {
    if (supported && shortcutKeyDown(shortcut) === true) scheduleShortcutRelease();
    else releaseShortcutPress();
  }, supported ? 20 : 1600);
}

function handleGlobalShortcut(): void {
  // Check only the configured key while held, so release is observed even when
  // every window is hidden. Unknown keys retain renderer key-up plus a fallback.
  scheduleShortcutRelease();
  if (shortcutPressLatched) return;
  shortcutPressLatched = true;
  toggleWindow();
}

function shortcutKeyName(value: string): string {
  const key = value.toLowerCase();
  return ({ ctrl: "control", cmd: "meta", command: "meta", super: "meta", option: "alt", commandorcontrol: process.platform === "darwin" ? "meta" : "control", cmdorctrl: process.platform === "darwin" ? "meta" : "control", up: "arrowup", down: "arrowdown", left: "arrowleft", right: "arrowright", plus: "+", space: " " } as Record<string, string>)[key] ?? key;
}

function handleShortcutInput(event: Electron.Event, input: Electron.Input): boolean {
  const keys = shortcut.split("+").map(shortcutKeyName);
  const key = shortcutKeyName(input.key);
  if (input.type === "keyUp" && keys.includes(key)) releaseShortcutPress();
  const primary = keys.at(-1);
  const modifiers = keys.slice(0, -1);
  const matches = key === primary && modifiers.every(modifier => modifier === "control" ? input.control : modifier === "meta" ? input.meta : modifier === "alt" ? input.alt : modifier === "shift" ? input.shift : false);
  if (input.type === "keyDown" && input.isAutoRepeat && matches) {
    if (shortcutPressLatched) scheduleShortcutRelease();
    event.preventDefault();
    return true;
  }
  return false;
}

async function updateShortcut(value: unknown): Promise<{ ok: boolean; accelerator: string; error?: string }> {
  if (!validAccelerator(value)) return { ok: false, accelerator: shortcut, error: "请输入带修饰键的有效快捷键，例如 Control+Q 或 CommandOrControl+Shift+P。" };
  if (value === shortcut && globalShortcut.isRegistered(shortcut)) return { ok: true, accelerator: shortcut };
  let registered = false;
  try { registered = globalShortcut.register(value, handleGlobalShortcut); } catch { /* Invalid native accelerator is reported below. */ }
  if (!registered) return { ok: false, accelerator: shortcut, error: "该快捷键被其他应用占用或无法注册，原快捷键仍保留。" };
  try { await atomicWrite(preferencesPath(), JSON.stringify({ accelerator: value, panelPosition: panelAnchor })); }
  catch {
    globalShortcut.unregister(value);
    return { ok: false, accelerator: shortcut, error: "快捷键设置保存失败，原快捷键仍保留。" };
  }
  if (shortcut !== value) globalShortcut.unregister(shortcut);
  shortcut = value;
  releaseShortcutPress();
  updateTrayTooltip();
  return { ok: true, accelerator: shortcut };
}

function currentAppearance(): DesktopAppearance {
  return {
    dark: nativeTheme.shouldUseDarkColors,
    reduceTransparency: nativeTheme.prefersReducedTransparency,
    reduceMotion: systemPreferences.getAnimationSettings().prefersReducedMotion,
    increaseContrast: nativeTheme.shouldUseHighContrastColors,
  };
}

function ownedWindows(): BrowserWindow[] {
  return [mainWindow, workspaceWindow].filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()));
}

function groupWindows(): BrowserWindow[] {
  return [mainWindow, ...resultWindows.values()].filter((window): window is BrowserWindow => Boolean(window && !window.isDestroyed()));
}
function allOwnedWindows(): BrowserWindow[] { return [...ownedWindows(), ...resultWindows.values()].filter(window => !window.isDestroyed()); }
function isGroupWindow(window: BrowserWindow): boolean { return groupWindows().includes(window); }

function resultVisibility(): DesktopResultVisibility {
  return {
    sessionId: publicState?.session?.id ?? null,
    visibleIds: [...resultWindows].filter(([, window]) => !window.isDestroyed() && window.isVisible()).map(([id]) => id),
  };
}

function publishResultVisibility(force = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const value = resultVisibility();
  const serialized = JSON.stringify(value);
  if (!force && serialized === lastResultVisibility) return;
  lastResultVisibility = serialized;
  mainWindow.webContents.send("pe:result-visibility", value);
}

function queueResultVisibility(): void {
  if (resultVisibilityQueued) return;
  resultVisibilityQueued = true;
  queueMicrotask(() => { resultVisibilityQueued = false; publishResultVisibility(); });
}

function cancelPresentationTimers(): void {
  if (hideTimer) clearTimeout(hideTimer);
  if (materialTimer) clearTimeout(materialTimer);
  if (focusTimer) clearTimeout(focusTimer);
  hideTimer = undefined; materialTimer = undefined; focusTimer = undefined;
}

function reconcileGroupFocus(): void {
  if (focusTimer) clearTimeout(focusTimer);
  const epoch = presentationEpoch;
  focusTimer = setTimeout(() => {
    focusTimer = undefined;
    if (epoch !== presentationEpoch || groupState !== "visible") return;
    const windows = groupWindows();
    if (windows.some(window => nativeInteractions.has(window.id) || (window.isVisible() && window.isFocused()))) return;
    hideWindow(true);
  }, 50);
}

function beginNativeInteraction(window: BrowserWindow): () => void {
  nativeInteractions.set(window.id, (nativeInteractions.get(window.id) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (nativeInteractions.get(window.id) ?? 1) - 1;
    if (remaining > 0) nativeInteractions.set(window.id, remaining); else nativeInteractions.delete(window.id);
    reconcileGroupFocus();
  };
}

function updateAppearance(): void {
  const appearance = currentAppearance();
  if (appearance.reduceMotion && materialTimer) {
    clearTimeout(materialTimer); materialTimer = undefined; panelAnimating = false;
  }
  for (const window of allOwnedWindows()) {
    const group = isGroupWindow(window);
    const effectVisible = !appearance.reduceTransparency && !(group && panelAnimating);
    let glass = false;
    if (process.platform === "darwin") {
      // The AppKit wrapper preserves Electron's root content view and the
      // workspace's ordinary title bar, standard buttons and window level.
      window.setVibrancy(null);
      const result = setNativeGlass(window, effectVisible);
      glass = result.ok && result.enabled;
      if (effectVisible && !glass) window.setVibrancy(group ? "popover" : "sidebar");
    }
    window.setBackgroundColor(appearance.reduceTransparency ? appearance.dark ? "#191a1c" : "#f7f7f9" : "#00000000");
    window.webContents.send("pe:appearance", { ...appearance, nativeGlass: glass });
  }
}

function hideWindow(immediately = false): void {
  if (groupState === "hidden" || (groupState === "hiding" && !immediately)) return;
  resultSelectionVersion += 1;
  const epoch = ++presentationEpoch;
  cancelPresentationTimers();
  groupState = "hiding";
  for (const window of groupWindows()) if (window.isVisible()) window.webContents.send("pe:hide");
  const finish = () => {
    if (epoch !== presentationEpoch) return;
    groupState = "hidden"; hideTimer = undefined; panelAnimating = false;
    for (const window of groupWindows()) window.hide();
    publishResultVisibility();
  };
  if (immediately || currentAppearance().reduceMotion) { finish(); return; }
  // CSS can animate the renderer surface, but cannot clip the native effect
  // underneath it. Temporarily remove that full-window effect during the exit.
  panelAnimating = true;
  updateAppearance();
  hideTimer = setTimeout(finish, 100);
}

function setTrackedBounds(window: BrowserWindow, bounds: Electron.Rectangle): void {
  knownBounds.set(window.id, bounds);
  window.setBounds(bounds);
}

function fitPanel(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const area = (panelAnchor ? screen.getDisplayMatching({ ...panelAnchor, width: 400, height: 280 }) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
  const width = Math.min(400, area.width), height = Math.min(280, area.height);
  let x = Math.max(area.x, Math.min(panelAnchor?.x ?? Math.round(area.x + (area.width - width) / 2), area.x + area.width - width));
  const y = Math.max(area.y, Math.min(panelAnchor?.y ?? Math.round(area.y + (area.height - height) / 2), area.y + area.height - height));
  const ids = [...openedResults].filter(id => resultWindows.has(id));
  const resultWidth = Math.min(360, area.width), resultHeight = Math.min(420, area.height), gap = 12;
  const right = area.x + area.width - x - width, left = x - area.x;
  let side = right >= left ? 1 : -1;
  let visibleIds = ids;
  if (right >= ids.length * (resultWidth + gap)) side = 1;
  else if (left >= ids.length * (resultWidth + gap)) side = -1;
  else visibleIds = selectedResultId && ids.includes(selectedResultId) ? [selectedResultId] : ids.slice(0, 1);
  // When one side cannot fit even one bubble, move the anchor only as far as
  // necessary; very narrow displays retain one clamped bubble with all data intact.
  if (visibleIds.length && area.width >= width + gap + resultWidth) {
    if (side === 1) x = Math.min(x, area.x + area.width - width - visibleIds.length * (resultWidth + gap));
    else x = Math.max(x, area.x + visibleIds.length * (resultWidth + gap));
  }
  movingGroup = true;
  try {
    panelAnchor = { x, y };
    setTrackedBounds(mainWindow, { x, y, width, height });
    for (const [id, window] of resultWindows) {
      const index = visibleIds.indexOf(id);
      if (index < 0) { window.hide(); continue; }
      const rawX = side === 1 ? x + width + gap + index * (resultWidth + gap) : x - (index + 1) * (resultWidth + gap);
      const resultX = Math.max(area.x, Math.min(rawX, area.x + area.width - resultWidth));
      const resultY = Math.max(area.y, Math.min(y, area.y + area.height - resultHeight));
      setTrackedBounds(window, { x: resultX, y: resultY, width: resultWidth, height: resultHeight });
      if (groupState === "visible" && mainWindow.isVisible() && !window.webContents.isLoadingMainFrame()) {
        const wasVisible = window.isVisible(); window.showInactive();
        if (!wasVisible) window.webContents.send("pe:show");
      }
    }
  } finally { movingGroup = false; }
  publishResultVisibility();
}

function collapseResultsForInputMove(): void {
  if (!mainWindow || mainWindow.isDestroyed() || movingGroup || groupState !== "visible") return;
  if (!openedResults.size && ![...resultWindows.values()].some(window => !window.isDestroyed() && window.isVisible())) return;
  resultSelectionVersion += 1;
  // A native drag can begin before the input becomes the key window. Transfer
  // focus within our active group before hiding its focused result; never raise
  // our app when another app currently owns focus.
  if (mainWindow.isVisible() && groupWindows().some(window => window.isVisible() && window.isFocused())) mainWindow.focus();
  // Clear intent as well as visibility, including windows still loading. Their
  // renderers and public result data remain available for the next explicit open.
  openedResults.clear(); selectedResultId = undefined;
  for (const window of resultWindows.values()) {
    if (window.isDestroyed()) continue;
    if (window.isVisible()) window.webContents.send("pe:hide");
    window.hide();
  }
  publishResultVisibility();
}

function followGroupMove(window: BrowserWindow): void {
  if (movingGroup || !mainWindow || groupState !== "visible") return;
  const before = knownBounds.get(window.id), now = window.getBounds();
  if (!before || (before.x === now.x && before.y === now.y)) { knownBounds.set(window.id, now); return; }
  if (window === mainWindow) collapseResultsForInputMove();
  const windows = groupWindows().filter(item => item === mainWindow || item.isVisible());
  const originals = windows.map(item => ({ window: item, bounds: item === window ? before : item.getBounds() }));
  const area = screen.getDisplayMatching(now).workArea;
  const minX = Math.min(...originals.map(item => item.bounds.x)), minY = Math.min(...originals.map(item => item.bounds.y));
  const maxX = Math.max(...originals.map(item => item.bounds.x + item.bounds.width)), maxY = Math.max(...originals.map(item => item.bounds.y + item.bounds.height));
  if (maxX - minX > area.width || maxY - minY > area.height) {
    // Crossing onto a smaller display can make the old group impossible to fit.
    // Anchor it on that display, then apply the single-selected-bubble fallback.
    const anchor = originals.find(item => item.window === mainWindow)!.bounds;
    panelAnchor = {
      x: Math.max(area.x, Math.min(anchor.x + now.x - before.x, area.x + area.width - Math.min(400, area.width))),
      y: Math.max(area.y, Math.min(anchor.y + now.y - before.y, area.y + area.height - Math.min(280, area.height))),
    };
    fitPanel();
  } else {
    const dx = Math.max(area.x - minX, Math.min(now.x - before.x, area.x + area.width - maxX));
    const dy = Math.max(area.y - minY, Math.min(now.y - before.y, area.y + area.height - maxY));
    movingGroup = true;
    try { for (const item of originals) setTrackedBounds(item.window, { ...item.bounds, x: item.bounds.x + dx, y: item.bounds.y + dy }); }
    finally { movingGroup = false; }
  }
  const anchor = mainWindow.getBounds(); panelAnchor = { x: anchor.x, y: anchor.y };
  if (positionTimer) clearTimeout(positionTimer);
  positionTimer = setTimeout(() => {
    positionTimer = undefined;
    // Position and shortcut share one preferences file, so serialize both writes.
    const operation = shortcutQueue.then(() => shortcutReady).then(() => atomicWrite(preferencesPath(), JSON.stringify({ accelerator: shortcut, panelPosition: panelAnchor })));
    shortcutQueue = operation.catch(() => undefined);
  }, 350);
}

function fitWorkspace(): void {
  if (!workspaceWindow || workspaceWindow.isDestroyed()) return;
  const old = workspaceWindow.getBounds();
  const area = screen.getDisplayMatching(old).workArea;
  const minWidth = Math.min(720, area.width);
  const minHeight = Math.min(520, area.height);
  // Reduce the native minimum first, otherwise the old display's minimum can
  // prevent setBounds from fitting a newly connected smaller display.
  workspaceWindow.setMinimumSize(minWidth, minHeight);
  const width = Math.min(Math.max(old.width, minWidth), area.width);
  const height = Math.min(Math.max(old.height, minHeight), area.height);
  const x = Math.max(area.x, Math.min(old.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(old.y, area.y + area.height - height));
  workspaceWindow.setBounds({ width, height, x, y });
}

function fitWindowsToDisplays(): void { fitPanel(); fitWorkspace(); }

function showWindow(): void {
  const ticket = ++workspaceTransitionVersion;
  if (needsSettingsLeaveGuard()) {
    void settingsLeaveGuard.confirm().then(allowed => { if (allowed && ticket === workspaceTransitionVersion && !quitting) showWindowNow(); });
    return;
  }
  showWindowNow();
}

function showWindowNow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // The workspace and quick panel are alternate presentations of one task.
  // Returning to the quick panel must not leave an interactive workspace behind.
  // Do not change macOS activation policy here by hiding the Dock icon.
  // Its asynchronous deactivation can dismiss the just-focused quick panel.
  const alreadyVisible = groupState === "visible" && mainWindow.isVisible();
  const epoch = ++presentationEpoch;
  cancelPresentationTimers();
  groupState = "visible";
  const appearance = currentAppearance();
  panelAnimating = !alreadyVisible && !appearance.reduceMotion && !appearance.reduceTransparency;
  updateAppearance();
  if (mainWindow.isMinimized()) mainWindow.restore();
  fitPanel();
  mainWindow.show();
  fitPanel();
  app.focus({ steal: true });
  mainWindow.focus();
  // Transfer focus before hiding the former key window; no empty key-window
  // interval should let the workspace activation callback reopen or dismiss us.
  if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.hide();
  if (!alreadyVisible) mainWindow.webContents.send("pe:show");
  if (panelAnimating) materialTimer = setTimeout(() => {
    if (epoch !== presentationEpoch) return;
    materialTimer = undefined;
    panelAnimating = false;
    updateAppearance();
  }, 220);
}

function toggleWindow(): void {
  if (groupState === "visible" && groupWindows().some(window => window.isFocused() || nativeInteractions.has(window.id))) hideWindow();
  else showWindow();
}

function openSettings(): void {
  void openWorkspace("settings");
}

function updateTrayTooltip(): void { tray?.setToolTip(`PE Studio · ${shortcut}`); }

function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "打开 PE Studio", click: showWindow },
    { label: "提示词库", click: () => { void openWorkspace("library"); } },
    { label: "任务", click: () => { void openWorkspace("tasks"); } },
    { label: "设置…", click: openSettings },
    { label: `快捷键：${shortcut}…`, click: openSettings },
    { type: "separator" },
    { label: "退出 PE Studio", click: () => app.quit() },
  ]);
}

function trustedWindow(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | undefined {
  return allOwnedWindows().find(window => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && isAppUrl(event.senderFrame?.url ?? ""));
}

function trustedIpc(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const window = trustedWindow(event);
  return Boolean(window && ownedWindows().includes(window));
}

function secureWindow(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  window.webContents.on("will-frame-navigate", event => { if (!isAppUrl(event.url) || !event.isMainFrame) event.preventDefault(); });
  window.webContents.on("will-attach-webview", event => event.preventDefault());
  window.webContents.on("context-menu", (_event, params) => {
    const flags = params.editFlags;
    const template: MenuItemConstructorOptions[] = params.isEditable ? [
      { role: "undo", enabled: flags.canUndo }, { role: "redo", enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", enabled: flags.canCut }, { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste }, { type: "separator" }, { role: "selectAll", enabled: flags.canSelectAll },
    ] : params.selectionText ? [{ role: "copy", enabled: flags.canCopy }] : [];
    if (!template.length) return;
    const menu = Menu.buildFromTemplate(template);
    const releaseInteraction = beginNativeInteraction(window);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      releaseInteraction();
      window.removeListener("close", dismiss);
      window.removeListener("closed", dismiss);
      window.removeListener("hide", dismiss);
      // Native menu tracking temporarily affects focus. Check after it finishes,
      // so selecting a menu item keeps the panel and an outside click hides it.
    };
    const dismiss = () => {
      try { menu.closePopup(window); } catch { /* The native window may already have closed. */ }
      finally { release(); }
    };
    if (isGroupWindow(window) && hideTimer) showWindow();
    window.once("close", dismiss);
    window.once("closed", dismiss);
    window.once("hide", dismiss);
    try { menu.popup({ window, callback: release }); }
    catch { release(); }
  });
  window.webContents.on("before-input-event", (event, input) => {
    if (handleShortcutInput(event, input)) return;
    if (ownedWindows().includes(window) && input.type === "keyDown" && input.key === "," && (process.platform === "darwin" ? input.meta : input.control)) {
      event.preventDefault(); openSettings();
    }
  });
  window.webContents.on("did-finish-load", () => {
    window.webContents.send("pe:appearance", { ...currentAppearance(), nativeGlass: nativeGlassStatus(window).enabled });
    if (isGroupWindow(window) && window.isVisible()) window.webContents.send("pe:show");
    if (window === mainWindow) publishResultVisibility(true);
    if (resultIdForWindow(window) && publicState) window.webContents.send("pe:state", publicState);
    if (window === workspaceWindow) {
      window.webContents.send("pe:workspace-section", workspaceSection);
      if (publicState) window.webContents.send("pe:state", publicState);
    }
  });
  window.webContents.on("did-stop-loading", () => {
    // loadURL can settle before isLoadingMainFrame becomes false. A result
    // skipped by fitPanel at that point still needs its one visible layout.
    // Never reopen a dismissed group or a result removed by a newer session.
    const id = resultIdForWindow(window);
    if (id && !window.isDestroyed() && openedResults.has(id) && groupState === "visible" && mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) fitPanel();
  });
  if (isGroupWindow(window)) {
    window.on("blur", reconcileGroupFocus);
    if (window === mainWindow) window.on("will-move", collapseResultsForInputMove);
    window.on("move", () => followGroupMove(window));
    window.on("moved", () => followGroupMove(window));
  }
}

async function openWorkspace(section: DesktopWorkspaceSection): Promise<void> {
  const ticket = ++workspaceTransitionVersion;
  if (section !== "settings" && needsSettingsLeaveGuard()) {
    if (!await settingsLeaveGuard.confirm() || ticket !== workspaceTransitionVersion || quitting) return;
  }
  workspaceSection = section;
  hideWindow(true);
  const epoch = ++presentationEpoch;
  if (!workspaceWindow || workspaceWindow.isDestroyed()) {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(1000, area.width);
    const height = Math.min(720, area.height);
    const window = new BrowserWindow({
      title: "PE Studio — 工作台", width, height, minWidth: Math.min(720, area.width), minHeight: Math.min(520, area.height),
      x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2),
      show: false, resizable: true, alwaysOnTop: false, titleBarStyle: "hiddenInset", transparent: true,
      backgroundColor: "#00000000", vibrancy: "sidebar", visualEffectState: "followWindow",
      webPreferences: {
        preload: join(app.getAppPath(), "dist-desktop", "preload.cjs"), session: session.fromPartition(PARTITION),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        allowRunningInsecureContent: false, backgroundThrottling: false, spellcheck: false, devTools: !app.isPackaged,
      },
    });
    workspaceWindow = window;
    secureWindow(window);
    window.on("close", event => {
      if (!quitting) { event.preventDefault(); requestWorkspaceClose(); }
    });
    window.on("closed", () => { workspaceWindow = null; workspaceReady = undefined; settingsLeaveGuard.setDirty(false); cancelSettingsActions(); });
    workspaceReady = window.loadURL(`${APP_ORIGIN}/?workspace=1&section=${section}`);
    updateAppearance();
  }
  await workspaceReady;
  if (!workspaceWindow || workspaceWindow.isDestroyed() || quitting || epoch !== presentationEpoch) return;
  if (workspaceWindow.isMinimized()) workspaceWindow.restore();
  fitWorkspace();
  workspaceWindow.show();
  if (process.platform === "darwin") void app.dock?.show();
  app.focus({ steal: true });
  workspaceWindow.focus();
  workspaceWindow.webContents.send("pe:workspace-section", workspaceSection);
  if (publicState) workspaceWindow.webContents.send("pe:state", publicState);
}

function resultIdForWindow(window: BrowserWindow): string | undefined {
  return [...resultWindows].find(([, result]) => result === window)?.[0];
}

function validResultId(value: unknown): value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value) || !publicState) return false;
  const ids = new Set([
    ...publicState.session?.candidates.map(candidate => candidate.id) ?? [], ...publicState.pending,
    ...(publicState.runConnections.length ? publicState.runConnections : publicState.config.writers).map(writer => writer.id),
  ]);
  return ids.has(value);
}

function closeResult(id: string): void {
  resultSelectionVersion += 1;
  const window = resultWindows.get(id);
  openedResults.delete(id);
  if (selectedResultId === id) selectedResultId = [...openedResults].at(-1);
  if (window && !window.isDestroyed()) { window.webContents.send("pe:hide"); window.hide(); }
  if (groupState === "visible" && mainWindow && !mainWindow.isDestroyed()) {
    fitPanel(); mainWindow.focus();
  }
  publishResultVisibility();
}

async function openResult(id: string, focus = false): Promise<{ ok: boolean; error?: string }> {
  if (!validResultId(id)) return { ok: false, error: "候选结果不存在。" };
  // Completion and review updates must never reopen an intentionally hidden group.
  if (groupState !== "visible" || !mainWindow?.isVisible()) return { ok: false };
  if (!resultWindows.has(id) && resultWindows.size >= 3) return { ok: false, error: "最多显示三个候选结果。" };
  const selectionVersion = ++resultSelectionVersion;
  // One preview at a time. Cached results retain their contents and scroll, but
  // rapid slot changes cannot stack or resurrect previously opened windows.
  const keepGroupFocus = groupWindows().some(item => item.isVisible() && item.isFocused());
  if (keepGroupFocus) mainWindow.focus();
  for (const otherId of openedResults) {
    if (otherId === id) continue;
    const other = resultWindows.get(otherId);
    if (other && !other.isDestroyed()) other.hide();
  }
  openedResults.clear();
  selectedResultId = id; openedResults.add(id);
  const sessionId = publicState?.session?.id;
  let window = resultWindows.get(id);
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      title: "PE Studio — 候选提示词", width: 360, height: 420, show: false,
      acceptFirstMouse: true,
      frame: false, transparent: true, resizable: false, maximizable: false, fullscreenable: false,
      backgroundColor: "#00000000", vibrancy: "popover", visualEffectState: "followWindow", alwaysOnTop: false, skipTaskbar: true,
      webPreferences: {
        preload: join(app.getAppPath(), "dist-desktop", "preload.cjs"), session: session.fromPartition(PARTITION),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
        allowRunningInsecureContent: false, backgroundThrottling: false, spellcheck: false, devTools: !app.isPackaged,
      },
    });
    resultWindows.set(id, window);
    secureWindow(window);
    window.on("show", queueResultVisibility);
    window.on("hide", queueResultVisibility);
    window.on("close", event => { if (!quitting) { event.preventDefault(); closeResult(id); } });
    window.on("closed", () => { resultWindows.delete(id); resultReady.delete(id); openedResults.delete(id); queueResultVisibility(); });
    resultReady.set(id, window.loadURL(`${APP_ORIGIN}/?result=${encodeURIComponent(id)}`));
  }
  updateAppearance();
  try { await resultReady.get(id); }
  catch { openedResults.delete(id); return { ok: false, error: "结果窗口加载失败，请重试。" }; }
  if (!window.isDestroyed() && window.webContents.isLoadingMainFrame()) {
    const contents = window.webContents;
    await new Promise<void>(resolve => {
      const finish = () => {
        contents.removeListener("did-stop-loading", finish);
        contents.removeListener("destroyed", finish);
        resolve();
      };
      contents.once("did-stop-loading", finish);
      contents.once("destroyed", finish);
      if (contents.isDestroyed() || !contents.isLoadingMainFrame()) finish();
    });
  }
  if (groupState !== "visible" || !mainWindow?.isVisible() || publicState?.session?.id !== sessionId || window.isDestroyed() || !openedResults.has(id)) return { ok: false };
  if (publicState) window.webContents.send("pe:state", publicState);
  fitPanel();
  // Only an explicit user activation transfers focus. A late load must never
  // pull the user back from another app or supersede a newer model choice.
  if (focus && selectionVersion === resultSelectionVersion && selectedResultId === id && window.isVisible() && groupWindows().some(item => item.isVisible() && item.isFocused())) window.focus();
  return { ok: true };
}

async function toggleResult(id: string, focus: boolean): Promise<{ ok: boolean; visible: boolean; error?: string }> {
  if (!validResultId(id)) return { ok: false, visible: false, error: "候选结果不存在。" };
  const window = resultWindows.get(id);
  // A second click can cancel the initial load. A bubble hidden only by the
  // narrow-screen layout can still be selected and reopened explicitly.
  if (window && !window.isDestroyed() && (window.isVisible() || (openedResults.has(id) && window.webContents.isLoadingMainFrame()))) {
    closeResult(id);
    return { ok: true, visible: false };
  }
  const result = await openResult(id, focus);
  const current = resultWindows.get(id);
  return { ...result, visible: Boolean(current && !current.isDestroyed() && current.isVisible()) };
}

function installIpc(): void {
  ipcMain.handle("pe:commit-settings", (event, config: unknown, value: unknown) => {
    if (!workspaceWindow || trustedWindow(event) !== workspaceWindow) return { ok: false, applied: false, persisted: false, error: "不允许的窗口请求。" };
    const parsed = configSchema.safeParse(config);
    if (!parsed.success || !isReasonablePayload(config, 32_000)) return { ok: false, applied: false, persisted: false, error: "模型设置格式无效，修改尚未保存。" };
    let credentials: DesktopCredentials;
    try { credentials = validateCredentials(value); }
    catch { return { ok: false, applied: false, persisted: false, error: "密钥格式无效，修改尚未保存。" }; }
    const owner = workspaceWindow;
    const operation = credentialQueue.then(async () => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return { ok: false, applied: false, persisted: false, error: "小窗暂不可用，修改尚未保存。" };
      const target = mainWindow;
      const previousVolatile = volatileCredentials;
      let previousEncrypted: Buffer | undefined;
      try { previousEncrypted = await readFile(credentialsPath()); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false, applied: false, persisted: false, error: "无法读取原有保存状态，修改尚未应用。" }; }
      const release = beginNativeInteraction(owner);
      try {
        const saved = await persistCredentials(credentials);
        if (!saved.ok || !saved.persisted) return saved;
        try {
          if (target.isDestroyed() || target.webContents.isDestroyed()) throw new Error("owner unavailable");
          target.webContents.send("pe:command", { type: "config-updated", config: parsed.data } satisfies WorkspaceCommand);
          settingsLeaveGuard.setDirty(false);
          return saved;
        } catch {
          // Keep the old credential/config pair when the task owner cannot accept
          // the already-validated configuration. Never send keys on the command channel.
          volatileCredentials = previousVolatile;
          try {
            if (previousEncrypted) await atomicWrite(credentialsPath(), previousEncrypted);
            else await unlink(credentialsPath()).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; });
          } catch { return { ok: false, applied: false, persisted: false, error: "配置同步失败且无法恢复原保存状态，请保留草稿并重试。" }; }
          return { ok: false, applied: false, persisted: false, error: "配置同步失败，原密钥已恢复，草稿仍保留。" };
        }
      } finally { release(); }
    });
    credentialQueue = operation.catch(() => undefined);
    return operation;
  });
  ipcMain.handle("pe:settings-model-dirty", (event, value: unknown) => {
    if (!workspaceWindow || trustedWindow(event) !== workspaceWindow || typeof value !== "boolean") return { ok: false };
    settingsLeaveGuard.setDirty(value);
    return { ok: true };
  });
  ipcMain.handle("pe:settings-action-complete", (event, requestId: unknown, ok: unknown) => {
    if (!workspaceWindow || trustedWindow(event) !== workspaceWindow || typeof requestId !== "string" || typeof ok !== "boolean") return { ok: false };
    const request = settingsActionRequests.get(requestId);
    if (!request || request.windowId !== workspaceWindow.id) return { ok: false };
    clearTimeout(request.timer); settingsActionRequests.delete(requestId); request.resolve(ok);
    return { ok: true };
  });
  ipcMain.handle("pe:list-local-agents", async event => {
    const owner = trustedWindow(event);
    if (!owner || (owner !== mainWindow && owner !== workspaceWindow)) throw new Error("不允许的窗口请求。");
    return listLocalAgents();
  });
  ipcMain.handle("pe:generate-local", async (event, requestId: unknown, brief: unknown, connection: unknown) => {
    if (!mainWindow || trustedWindow(event) !== mainWindow) throw new Error("不允许的窗口请求。");
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId) || localRequests.has(requestId) || [...localRequests.values()].filter(controller => !controller.signal.aborted).length >= 3) throw new Error("本地任务请求无效或任务数已达上限。");
    const parsed = z.object({
      id: z.enum(["writer-1", "writer-2", "writer-3"]), label: shortText,
      protocol: z.literal("local-agent"), baseUrl: z.enum(["local://codex", "local://claude", "local://pi", "local://hermes"]),
      model: z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/), apiKey: z.literal(""),
    }).strict().safeParse(connection);
    if (!parsed.success || !isReasonablePayload(brief, 150_000)) throw new Error("本地 Agent 配置无效。");
    const validBrief = validateBrief(brief);
    const controller = new AbortController();
    localRequests.set(requestId, controller);
    try { return await generateLocalCandidate(validBrief, parsed.data, controller.signal); }
    catch { throw new Error(controller.signal.aborted ? "本地生成已取消。" : "本地 Agent 未完成生成，请检查它的登录状态和模型配置后重试。"); }
    finally { localRequests.delete(requestId); }
  });
  ipcMain.handle("pe:cancel-local", (event, requestId: unknown) => {
    if (!mainWindow || trustedWindow(event) !== mainWindow || typeof requestId !== "string") return { ok: false };
    const controller = localRequests.get(requestId);
    controller?.abort();
    return { ok: Boolean(controller) };
  });
  ipcMain.on("pe:hide", event => {
    const owner = trustedWindow(event);
    if (owner && isGroupWindow(owner)) hideWindow();
    else if (owner === workspaceWindow) requestWorkspaceClose();
  });
  ipcMain.on("pe:show-panel", event => { if (trustedIpc(event)) showWindow(); });
  ipcMain.handle("pe:open-result", (event, id: unknown, focus: unknown = false) => {
    if (!mainWindow || trustedWindow(event) !== mainWindow || !validResultId(id) || typeof focus !== "boolean") return { ok: false };
    return openResult(id, focus);
  });
  ipcMain.handle("pe:toggle-result", (event, id: unknown, focus: unknown = true) => {
    if (!mainWindow || trustedWindow(event) !== mainWindow || !validResultId(id) || typeof focus !== "boolean") return { ok: false, visible: false };
    return toggleResult(id, focus);
  });
  ipcMain.handle("pe:get-result-visibility", event => {
    if (!mainWindow || trustedWindow(event) !== mainWindow) throw new Error("不允许的窗口请求。");
    return resultVisibility();
  });
  ipcMain.handle("pe:close-result", (event, id: unknown) => {
    const owner = trustedWindow(event);
    const ownId = owner && resultIdForWindow(owner);
    const target = id === undefined ? ownId : id;
    if (!owner || typeof target !== "string" || !resultWindows.has(target) || (owner !== mainWindow && ownId !== target)) return { ok: false };
    closeResult(target); return { ok: true };
  });
  ipcMain.handle("pe:appearance", event => {
    const window = trustedWindow(event);
    if (!window) throw new Error("不允许的应用请求。");
    return { ...currentAppearance(), nativeGlass: nativeGlassStatus(window).enabled };
  });
  ipcMain.handle("pe:set-panel-mode", (event, value: unknown) => {
    if (trustedWindow(event) !== mainWindow || !mainWindow || (value !== "input" && value !== "results")) return { ok: false };
    fitPanel(); return { ok: true };
  });
  ipcMain.handle("pe:open-workspace", (event, value: unknown) => {
    if (!trustedIpc(event) || (value !== "settings" && value !== "library" && value !== "tasks")) throw new Error("工作台页面无效。");
    return openWorkspace(value);
  });
  ipcMain.handle("pe:get-state", event => {
    if (!trustedWindow(event)) throw new Error("不允许的应用请求。");
    return publicState;
  });
  ipcMain.handle("pe:publish-state", (event, value: unknown) => {
    if (!mainWindow || trustedWindow(event) !== mainWindow || !isReasonablePayload(value, 12 * 1024 * 1024)) return { ok: false, error: "同步状态无效。" };
    const parsed = publicStateSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: "同步状态格式无效。" };
    if (publicState?.session?.id !== parsed.data.session?.id) {
      resultSelectionVersion += 1;
      openedResults.clear(); selectedResultId = undefined;
      for (const window of resultWindows.values()) window.destroy();
      resultWindows.clear(); resultReady.clear();
    }
    publicState = parsed.data;
    publishResultVisibility();
    if (workspaceWindow && !workspaceWindow.isDestroyed()) workspaceWindow.webContents.send("pe:state", publicState);
    for (const window of resultWindows.values()) if (!window.isDestroyed()) window.webContents.send("pe:state", publicState);
    return { ok: true };
  });
  ipcMain.handle("pe:send-command", (event, value: unknown) => {
    const owner = trustedWindow(event);
    if (!owner || !mainWindow || mainWindow.isDestroyed() || !isReasonablePayload(value, 256 * 1024)) return { ok: false, error: "工作台请求无效。" };
    const parsed = commandSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: "工作台请求格式无效。" };
    const ownResult = resultIdForWindow(owner);
    const resultCommand = ownResult && ((parsed.data.type === "retry-candidate" && parsed.data.id === ownResult) || parsed.data.type === "retry-judge" || parsed.data.type === "reveal-models");
    if (owner !== workspaceWindow && !resultCommand) return { ok: false, error: "不允许的窗口操作。" };
    mainWindow.webContents.send("pe:command", parsed.data satisfies WorkspaceCommand);
    return { ok: true };
  });
  ipcMain.handle("pe:copy-text", async (event, value: unknown) => {
    if (!trustedWindow(event) || typeof value !== "string" || value.length > 100_000) return { ok: false };
    try { await clipboard.writeText(value); return { ok: true }; }
    catch { return { ok: false }; }
  });
  ipcMain.handle("pe:export-markdown", async (event, value: unknown, fileName: unknown) => {
    const owner = trustedWindow(event);
    if (!owner || !ownedWindows().includes(owner) || typeof value !== "string" || value.length > 250_000 || (fileName !== undefined && (typeof fileName !== "string" || fileName.length > 160))) {
      return { ok: false, error: "导出内容或文件名格式无效。" };
    }
    const name = (typeof fileName === "string" ? fileName : "PE-Studio.md").replace(/[\\/\x00-\x1f:*?"<>|]/g, "-").replace(/^\.+/, "") || "PE-Studio.md";
    const releaseInteraction = beginNativeInteraction(owner);
    let selected: Electron.SaveDialogReturnValue;
    try {
      selected = await dialog.showSaveDialog(owner, {
        title: "导出提示词", defaultPath: join(app.getPath("documents"), name.endsWith(".md") ? name : `${name}.md`),
        filters: [{ name: "Markdown 文档", extensions: ["md"] }], properties: ["createDirectory", "showOverwriteConfirmation"],
      });
    } finally { releaseInteraction(); }
    if (selected.canceled || !selected.filePath) return { ok: false, canceled: true };
    try { await writeFile(selected.filePath, value, { encoding: "utf8", mode: 0o600 }); return { ok: true }; }
    catch { return { ok: false, error: "无法保存 Markdown 文件，请检查所选目录的权限。" }; }
  });
  ipcMain.handle("pe:get-shortcut", event => {
    if (!trustedIpc(event)) throw new Error("不允许的应用请求。");
    return shortcutReady.then(shortcutState);
  });
  ipcMain.handle("pe:set-shortcut", (event, value: unknown) => {
    if (!trustedIpc(event)) throw new Error("不允许的应用请求。");
    const operation = shortcutQueue.then(() => shortcutReady).then(() => updateShortcut(value));
    shortcutQueue = operation.catch(() => undefined);
    return operation;
  });
  ipcMain.handle("pe:get-credentials", event => {
    if (!trustedIpc(event)) throw new Error("不允许的应用请求。");
    const owner = trustedWindow(event)!;
    const operation = credentialQueue.then(async () => {
      const releaseInteraction = beginNativeInteraction(owner);
      try { return await readCredentials(); }
      catch (error) { credentialReadFailed = true; throw error; }
      finally { releaseInteraction(); }
    });
    credentialQueue = operation.catch(() => undefined);
    return operation;
  });
  ipcMain.handle("pe:save-credentials", (event, value: unknown, sessionOnly: unknown) => {
    if (!trustedIpc(event)) throw new Error("不允许的应用请求。");
    if (sessionOnly !== undefined && typeof sessionOnly !== "boolean") return { ok: false, applied: false, persisted: false, error: "密钥保存选项无效。" };
    const owner = trustedWindow(event)!;
    const operation = credentialQueue.then(async () => {
      const releaseInteraction = beginNativeInteraction(owner);
      try { return await persistCredentials(value, sessionOnly === true); } finally { releaseInteraction(); }
    });
    credentialQueue = operation.catch(() => undefined);
    return operation;
  });
}

function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    { label: "PE Studio", submenu: [
      { role: "about" },
      { label: "设置…", accelerator: "CommandOrControl+,", click: openSettings },
      { type: "separator" },
      { label: "隐藏 PE Studio", accelerator: "CommandOrControl+H", click: () => { hideWindow(true); workspaceWindow?.hide(); if (process.platform === "darwin") app.dock?.hide(); } },
      { role: "quit", label: "退出 PE Studio" },
    ] },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function installShortcut(): Promise<void> {
  try {
    const info = await stat(preferencesPath());
    if (info.size <= 4096) {
      const saved = JSON.parse(await readFile(preferencesPath(), "utf8"));
      if (isPlainObject(saved) && validAccelerator(saved.accelerator)) shortcut = saved.accelerator;
      if (isPlainObject(saved) && isPlainObject(saved.panelPosition) && typeof saved.panelPosition.x === "number" && typeof saved.panelPosition.y === "number" && Number.isFinite(saved.panelPosition.x) && Number.isFinite(saved.panelPosition.y) && Math.abs(saved.panelPosition.x) < 100_000 && Math.abs(saved.panelPosition.y) < 100_000) panelAnchor = { x: Math.round(saved.panelPosition.x), y: Math.round(saved.panelPosition.y) };
    }
  } catch { /* Missing or corrupt non-secret preferences use the default. */ }
  let registered = false;
  try { registered = globalShortcut.register(shortcut, handleGlobalShortcut); } catch { /* Show fallback below. */ }
  if (registered) return;
  const unavailable = shortcut;
  try { registered = globalShortcut.register(FALLBACK_SHORTCUT, handleGlobalShortcut); } catch { /* Tray remains available. */ }
  if (registered) shortcut = FALLBACK_SHORTCUT;
  await dialog.showMessageBox({
    type: "warning", title: "PE Studio 快捷键冲突", message: `无法注册 ${unavailable}`,
    detail: registered ? `该快捷键可能被其他应用占用。本次已使用 ${FALLBACK_SHORTCUT}，你也可以在设置中更换。` : "默认快捷键和备用快捷键均不可用。仍可点击菜单栏 PE Studio 图标打开窗口，并在设置中更换快捷键。",
    buttons: ["知道了"],
  });
}

async function launch(): Promise<void> {
  // Set menu-bar activation policy before the first window can become key.
  if (process.platform === "darwin") app.dock?.hide();
  const desktopSession = session.fromPartition(PARTITION);
  desktopSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  desktopSession.setPermissionCheckHandler(() => false);
  desktopSession.on("will-download", event => event.preventDefault());
  desktopSession.protocol.handle("app", createDesktopHandler(join(app.getAppPath(), "dist-desktop", "renderer"), apiToken));

  // Chromium may omit Host/Origin for custom schemes; the protocol handler also
  // validates its URL and a process-random token that only our two main frames receive.
  desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const name of Object.keys(headers)) if (name.toLowerCase() === DESKTOP_TOKEN_HEADER) delete headers[name];
    const owner = ownedWindows().find(window => details.webContentsId === window.webContents.id);
    if (isAppUrl(details.url) && new URL(details.url).pathname.startsWith("/api/")) {
      const ownFrame = owner && details.frame === owner.webContents.mainFrame;
      const origin = details.initiatorOrigin;
      if (!owner || !ownFrame || (origin && origin !== APP_ORIGIN)) return callback({ cancel: true });
      headers[DESKTOP_TOKEN_HEADER] = apiToken;
    }
    callback({ requestHeaders: headers });
  });
  desktopSession.webRequest.onBeforeRequest((details, callback) => {
    // The renderer uses bundled assets and local API routes only. Model networking
    // takes place in main-process Node fetch and never inherits this token.
    callback({ cancel: !isAppUrl(details.url) && !details.url.startsWith("data:") && !details.url.startsWith("blob:") });
  });

  mainWindow = new BrowserWindow({
    title: "PE Studio", width: 400, height: 280,
    acceptFirstMouse: true,
    show: false, resizable: false, maximizable: false, fullscreenable: false,
    frame: false, transparent: true, backgroundColor: "#00000000", vibrancy: "popover", visualEffectState: "followWindow",
    alwaysOnTop: false, skipTaskbar: true, autoHideMenuBar: true,
    webPreferences: {
      preload: join(app.getAppPath(), "dist-desktop", "preload.cjs"),
      session: desktopSession, contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false,
      spellcheck: false, devTools: !app.isPackaged,
    },
  });
  const abortLocalRequests = () => { for (const controller of localRequests.values()) controller.abort(); };
  mainWindow.webContents.on("render-process-gone", abortLocalRequests);
  mainWindow.webContents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) abortLocalRequests(); });
  mainWindow.on("close", event => { if (!quitting) { event.preventDefault(); hideWindow(); } });
  mainWindow.on("closed", () => { mainWindow = null; });
  secureWindow(mainWindow);
  mainWindow.once("ready-to-show", () => { void shortcutReady.then(() => { if (presentationEpoch === 0) showWindow(); }); });
  nativeTheme.on("updated", updateAppearance);
  if (process.platform === "darwin") accessibilitySubscription = systemPreferences.subscribeWorkspaceNotification("NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification", updateAppearance);
  screen.on("display-metrics-changed", fitWindowsToDisplays);
  screen.on("display-removed", fitWindowsToDisplays);
  powerMonitor.on("resume", () => {
    releaseShortcutPress();
    fitWindowsToDisplays(); reconcileGroupFocus();
    if (!globalShortcut.isRegistered(shortcut)) { try { globalShortcut.register(shortcut, handleGlobalShortcut); } catch { /* Tray remains available. */ } }
  });
  powerMonitor.on("lock-screen", () => hideWindow(true));
  updateAppearance();

  const icon = nativeImage.createFromPath(join(app.getAppPath(), "dist-desktop", "assets", "trayTemplate.png"));
  if (!icon.isEmpty()) icon.setTemplateImage(true);
  tray = new Tray(icon);
  if (icon.isEmpty()) tray.setTitle("PE");
  tray.setIgnoreDoubleClickEvents(true);
  tray.on("click", toggleWindow);
  tray.on("right-click", () => tray?.popUpContextMenu(trayMenu()));

  installIpc();
  installApplicationMenu();
  shortcutReady = installShortcut();
  await mainWindow.loadURL(`${APP_ORIGIN}/`);
  await shortcutReady;
  updateTrayTooltip();
  if (smokeDirectory) {
    const status = await runDesktopSmoke(mainWindow, smokeDirectory, createDesktopHandler(join(app.getAppPath(), "dist-desktop", "renderer"), apiToken), () => workspaceWindow);
    globalShortcut.unregisterAll();
    app.exit(status);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", () => {
    // Explicit group activation and native clicks settle their own focus. Do not
    // redirect them to an already-open workspace while the group is showing.
    if (groupState === "visible") return;
    if (workspaceWindow?.isVisible()) workspaceWindow.focus(); else showWindow();
  });
  app.on("before-quit", () => { quitting = true; for (const controller of localRequests.values()) controller.abort(); });
  app.on("will-quit", () => {
    cancelSettingsActions();
    cancelPresentationTimers();
    releaseShortcutPress();
    if (positionTimer) clearTimeout(positionTimer);
    if (accessibilitySubscription !== undefined) systemPreferences.unsubscribeWorkspaceNotification(accessibilitySubscription);
    globalShortcut.unregisterAll(); tray?.destroy();
  });
  app.on("window-all-closed", () => { /* A menu-bar app stays alive until explicitly quit. */ });
  void app.whenReady().then(launch).catch(() => {
    dialog.showErrorBox("PE Studio 启动失败", "无法载入应用资源。请重新安装或重新构建桌面应用。");
    app.quit();
  });
}
