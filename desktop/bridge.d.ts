import type { Brief, Candidate, Connection } from "../lib/types";
import type { PublicStudioState, WorkspaceCommand } from "./workspace-contract";

export type DesktopPanelMode = "input" | "results";
export type DesktopWorkspaceSection = "settings" | "library" | "tasks";
export interface DesktopAppearance {
  /** True only when this window has the public AppKit glass view installed. */
  nativeGlass?: boolean;
  dark: boolean;
  reduceTransparency: boolean;
  reduceMotion: boolean;
  increaseContrast: boolean;
}

export interface DesktopCredentials {
  writers: Record<string, string>;
  jev: string;
}

export interface DesktopShortcut {
  accelerator: string;
  registered: boolean;
}

export interface DesktopResultVisibility {
  sessionId: string | null;
  visibleIds: string[];
}

export interface LocalAgentInfo {
  id: "codex" | "claude" | "pi" | "hermes";
  label: string;
  installed: boolean;
  available: boolean;
  status: string;
  models?: string[];
}

export interface SettingsActionRequest { requestId: string; action: "save" | "discard" }

export interface PEDesktopBridge {
  readonly isDesktop: true;
  hide(): void;
  showPanel(): void;
  openResult(id: string, focus?: boolean): Promise<{ ok: boolean; error?: string }>;
  toggleResult(id: string, focus?: boolean): Promise<{ ok: boolean; visible: boolean; error?: string }>;
  closeResult(id?: string): Promise<{ ok: boolean }>;
  getResultVisibility(): Promise<DesktopResultVisibility>;
  setPanelMode(mode: DesktopPanelMode): Promise<{ ok: boolean }>;
  openWorkspace(section: DesktopWorkspaceSection): Promise<void>;
  commitSettings(config: PublicStudioState["config"], credentials: DesktopCredentials): Promise<{ ok: boolean; applied: boolean; persisted: boolean; error?: string }>;
  setSettingsModelDirty(dirty: boolean): Promise<{ ok: boolean }>;
  completeSettingsAction(requestId: string, ok: boolean): Promise<{ ok: boolean }>;
  onSettingsAction(callback: (request: SettingsActionRequest) => void): () => void;
  listLocalAgents(): Promise<LocalAgentInfo[]>;
  generateLocal(requestId: string, brief: Brief, connection: Connection): Promise<Candidate>;
  cancelLocal(requestId: string): Promise<{ ok: boolean }>;
  getAppearance(): Promise<DesktopAppearance>;
  getState(): Promise<PublicStudioState | null>;
  publishState(state: PublicStudioState): Promise<{ ok: boolean; error?: string }>;
  sendCommand(command: WorkspaceCommand): Promise<{ ok: boolean; error?: string }>;
  copyText(text: string): Promise<{ ok: boolean }>;
  exportMarkdown(markdown: string, fileName?: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
  getShortcut(): Promise<DesktopShortcut>;
  setShortcut(accelerator: string): Promise<{ ok: boolean; accelerator: string; error?: string }>;
  getCredentials(): Promise<DesktopCredentials>;
  saveCredentials(value: DesktopCredentials, sessionOnly?: boolean): Promise<{ ok: boolean; applied: boolean; persisted: boolean; error?: string }>;
  onShow(callback: () => void): () => void;
  onHide(callback: () => void): () => void;
  onResultVisibilityChanged(callback: (visibility: DesktopResultVisibility) => void): () => void;
  onAppearanceChanged(callback: (appearance: DesktopAppearance) => void): () => void;
  onWorkspaceSection(callback: (section: DesktopWorkspaceSection) => void): () => void;
  onStateChanged(callback: (state: PublicStudioState) => void): () => void;
  onCommand(callback: (command: WorkspaceCommand) => void): () => void;
  onOpenSettings(callback: () => void): () => void;
}

declare global {
  interface Window { peDesktop?: PEDesktopBridge }
}
