import { contextBridge, ipcRenderer } from "electron";
import type { DesktopAppearance, DesktopCredentials, DesktopResultVisibility, DesktopWorkspaceSection, SettingsActionRequest, PEDesktopBridge } from "./bridge";
import type { PublicStudioState, WorkspaceCommand } from "./workspace-contract";

const showListeners = new Set<() => void>();
const hideListeners = new Set<() => void>();
const settingsListeners = new Set<() => void>();
const appearanceListeners = new Set<(value: DesktopAppearance) => void>();
const sectionListeners = new Set<(value: DesktopWorkspaceSection) => void>();
const stateListeners = new Set<(value: PublicStudioState) => void>();
const commandListeners = new Set<(value: WorkspaceCommand) => void>();
const resultVisibilityListeners = new Set<(value: DesktopResultVisibility) => void>();
let pendingVisibility: "show" | "hide" | undefined;
let pendingSettings = false;
let lastAppearance: DesktopAppearance | undefined;
let lastSection: DesktopWorkspaceSection | undefined;
let lastState: PublicStudioState | undefined;
let lastResultVisibility: DesktopResultVisibility | undefined;
const pendingCommands: WorkspaceCommand[] = [];
const settingsActionListeners = new Set<(value: SettingsActionRequest) => void>();
const pendingSettingsActions: SettingsActionRequest[] = [];
ipcRenderer.on("pe:settings-action", (_event, value: SettingsActionRequest) => {
  if (!settingsActionListeners.size) { if (pendingSettingsActions.length < 1) pendingSettingsActions.push(value); return; }
  for (const callback of settingsActionListeners) callback(value);
});

ipcRenderer.on("pe:show", () => {
  pendingVisibility = showListeners.size === 0 ? "show" : undefined;
  for (const callback of showListeners) callback();
});
ipcRenderer.on("pe:hide", () => {
  pendingVisibility = hideListeners.size === 0 ? "hide" : undefined;
  for (const callback of hideListeners) callback();
});
ipcRenderer.on("pe:open-settings", () => {
  pendingSettings = settingsListeners.size === 0;
  for (const callback of settingsListeners) callback();
});
ipcRenderer.on("pe:appearance", (_event, value: DesktopAppearance) => {
  lastAppearance = value;
  for (const callback of appearanceListeners) callback(value);
});
ipcRenderer.on("pe:workspace-section", (_event, value: DesktopWorkspaceSection) => {
  lastSection = value;
  for (const callback of sectionListeners) callback(value);
});
ipcRenderer.on("pe:state", (_event, value: PublicStudioState) => {
  lastState = value;
  for (const callback of stateListeners) callback(value);
});
ipcRenderer.on("pe:result-visibility", (_event, value: DesktopResultVisibility) => {
  lastResultVisibility = value;
  for (const callback of resultVisibilityListeners) callback(value);
});
ipcRenderer.on("pe:command", (_event, value: WorkspaceCommand) => {
  if (!commandListeners.size) {
    if (pendingCommands.length < 20) pendingCommands.push(value);
    return;
  }
  for (const callback of commandListeners) callback(value);
});

function subscribe<T>(listeners: Set<(value: T) => void>, callback: (value: T) => void, initial?: T): () => void {
  if (typeof callback !== "function") throw new TypeError("A callback is required");
  listeners.add(callback);
  if (initial !== undefined) queueMicrotask(() => { if (listeners.has(callback)) callback(initial); });
  return () => { listeners.delete(callback); };
}

const bridge: PEDesktopBridge = {
  isDesktop: true,
  hide: () => ipcRenderer.send("pe:hide"),
  showPanel: () => ipcRenderer.send("pe:show-panel"),
  openResult: (id, focus = false) => ipcRenderer.invoke("pe:open-result", id, focus),
  toggleResult: (id, focus = true) => ipcRenderer.invoke("pe:toggle-result", id, focus),
  closeResult: id => ipcRenderer.invoke("pe:close-result", id),
  getResultVisibility: () => ipcRenderer.invoke("pe:get-result-visibility"),
  setPanelMode: mode => ipcRenderer.invoke("pe:set-panel-mode", mode),
  openWorkspace: section => ipcRenderer.invoke("pe:open-workspace", section),
  commitSettings: (config, credentials) => ipcRenderer.invoke("pe:commit-settings", config, credentials),
  setSettingsModelDirty: dirty => ipcRenderer.invoke("pe:settings-model-dirty", dirty),
  completeSettingsAction: (requestId, ok) => ipcRenderer.invoke("pe:settings-action-complete", requestId, ok),
  onSettingsAction: callback => {
    const remove = subscribe(settingsActionListeners, callback);
    const queued = pendingSettingsActions.splice(0);
    queueMicrotask(() => { if (settingsActionListeners.has(callback)) queued.forEach(callback); });
    return remove;
  },
  listLocalAgents: () => ipcRenderer.invoke("pe:list-local-agents"),
  generateLocal: (requestId, brief, connection) => ipcRenderer.invoke("pe:generate-local", requestId, brief, connection),
  cancelLocal: requestId => ipcRenderer.invoke("pe:cancel-local", requestId),
  getAppearance: () => ipcRenderer.invoke("pe:appearance"),
  getState: () => ipcRenderer.invoke("pe:get-state"),
  publishState: state => ipcRenderer.invoke("pe:publish-state", state),
  sendCommand: command => ipcRenderer.invoke("pe:send-command", command),
  copyText: (text: string) => ipcRenderer.invoke("pe:copy-text", text),
  exportMarkdown: (markdown: string, fileName?: string) => ipcRenderer.invoke("pe:export-markdown", markdown, fileName),
  getShortcut: () => ipcRenderer.invoke("pe:get-shortcut"),
  setShortcut: (accelerator: string) => ipcRenderer.invoke("pe:set-shortcut", accelerator),
  getCredentials: () => ipcRenderer.invoke("pe:get-credentials"),
  saveCredentials: (value: DesktopCredentials, sessionOnly?: boolean) => ipcRenderer.invoke("pe:save-credentials", value, sessionOnly),
  onShow: callback => {
    if (typeof callback !== "function") throw new TypeError("onShow requires a callback");
    showListeners.add(callback);
    if (pendingVisibility === "show") { pendingVisibility = undefined; queueMicrotask(callback); }
    return () => { showListeners.delete(callback); };
  },
  onHide: callback => {
    if (typeof callback !== "function") throw new TypeError("onHide requires a callback");
    hideListeners.add(callback);
    if (pendingVisibility === "hide") { pendingVisibility = undefined; queueMicrotask(callback); }
    return () => { hideListeners.delete(callback); };
  },
  onAppearanceChanged: callback => subscribe(appearanceListeners, callback, lastAppearance),
  onResultVisibilityChanged: callback => subscribe(resultVisibilityListeners, callback, lastResultVisibility),
  onWorkspaceSection: callback => subscribe(sectionListeners, callback, lastSection),
  onStateChanged: callback => subscribe(stateListeners, callback, lastState),
  onCommand: callback => {
    const remove = subscribe(commandListeners, callback);
    const queued = pendingCommands.splice(0);
    queueMicrotask(() => { if (commandListeners.has(callback)) queued.forEach(callback); });
    return remove;
  },
  onOpenSettings: callback => {
    if (typeof callback !== "function") throw new TypeError("onOpenSettings requires a callback");
    settingsListeners.add(callback);
    if (pendingSettings) { pendingSettings = false; queueMicrotask(callback); }
    return () => { settingsListeners.delete(callback); };
  },
};

contextBridge.exposeInMainWorld("peDesktop", Object.freeze(bridge));

// A menu, dialog or IME gets first use of Escape, even if React removes it
// during the same event. Escape never dismisses the ordinary workspace window.
const consumedEscape = new WeakSet<Event>();
let composing = false;
window.addEventListener("compositionstart", () => { composing = true; }, { capture: true });
window.addEventListener("compositionend", () => { composing = false; }, { capture: true });
window.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const layer = Array.from(document.querySelectorAll('dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-pe-escape-layer]'))
    .some(element => element.getClientRects().length > 0 && element.getAttribute("aria-hidden") !== "true");
  if (composing || event.isComposing || event.keyCode === 229 || layer) {
    consumedEscape.add(event);
  }
}, { capture: true });
window.addEventListener("keydown", event => {
  if (event.key === "Escape" && !event.defaultPrevented && !consumedEscape.has(event) && new URL(window.location.href).searchParams.get("workspace") !== "1") {
    event.preventDefault();
    ipcRenderer.send("pe:hide");
  }
});
