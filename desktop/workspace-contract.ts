import type { Brief, Connection, JudgeConnection, SessionRecord } from "../lib/types";

/** Only public task data crosses the workspace channel. Credentials use the protected bridge. */
export interface PublicStudioState {
  brief: Brief;
  config: { writers: Omit<Connection, "apiKey">[]; judge: Omit<JudgeConnection, "apiKey"> };
  /** Credential-free connection snapshot for the task currently displayed. */
  runConnections: Omit<Connection, "apiKey">[];
  history: SessionRecord[];
  session: SessionRecord | null;
  pending: string[];
  judging: boolean;
  running: boolean;
  modelsRevealed: boolean;
  credentialsStatus: "loading" | "ready" | "failed";
}

export type WorkspaceSection = "settings" | "library" | "tasks";
export type WorkspaceCommand =
  | { type: "update-brief"; patch: Pick<Brief, "targetModel" | "context" | "constraints" | "intensity" | "outputLanguage"> }
  | { type: "new-session" }
  | { type: "restore-session"; id: string }
  | { type: "delete-session"; id: string }
  | { type: "toggle-favorite"; id: string }
  | { type: "open-demo" }
  | { type: "retry-candidate"; id: string }
  | { type: "retry-judge" }
  | { type: "reveal-models" }
  | { type: "config-updated"; config: PublicStudioState["config"] }
  | { type: "credentials-changed" };
