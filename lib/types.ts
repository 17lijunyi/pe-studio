export type Direction = "general" | "image" | "video" | "product";
export type Protocol = "openai-responses" | "openai-compatible" | "anthropic" | "gemini" | "aihubmix" | "deepseek" | "local-agent";
export interface Brief {
  direction: Direction;
  input: string;
  targetModel: string;
  context: string;
  constraints: string;
  intensity: "faithful" | "balanced" | "creative";
  outputLanguage: "zh" | "en";
}
export interface Connection {
  id: string;
  label: string;
  protocol: Protocol;
  model: string;
  baseUrl: string;
  apiKey: string;
}
export interface JudgeConnection { model: string; baseUrl: string; apiKey: string }
export interface Candidate {
  id: string;
  provider: string;
  model: string;
  prompt: string;
  changes: string[];
  assumptions: string[];
  status: "success" | "error";
  error?: string;
  latencyMs: number;
}
export interface DimensionScore { id: string; label: string; score: number; confidence: number }
export interface CandidateScore {
  candidateId: string;
  score: number;
  dimensions: DimensionScore[];
  eligible: boolean;
  violations: string[];
}
export interface JudgeReport {
  status: "complete" | "unavailable";
  candidates: CandidateScore[];
  recommendedId: string | null;
  tiedIds: string[];
  summary: string;
  model?: string;
  evaluatedAt: string;
}
export interface SessionRecord {
  /** Immutable A/B/C assignment for this generation round; absent on legacy records. */
  candidateOrder?: string[];
  /** Original non-secret connection tuple for retrying this same round. */
  connectionSnapshot?: Omit<Connection, "apiKey">[];
  id: string;
  createdAt: string;
  brief: Brief;
  candidates: Candidate[];
  judge: JudgeReport | null;
  demo: boolean;
  favorite: boolean;
}
export const DEFAULT_CONNECTIONS: Connection[] = [
  { id: "writer-1", label: "GPT", protocol: "aihubmix", model: "gpt-6-astra", baseUrl: "https://aihubmix.com/v1", apiKey: "" },
  { id: "writer-2", label: "Claude", protocol: "aihubmix", model: "claude-opus-5-5", baseUrl: "https://aihubmix.com/v1", apiKey: "" },
  { id: "writer-3", label: "Gemini", protocol: "aihubmix", model: "gemini-4-argon", baseUrl: "https://aihubmix.com/v1", apiKey: "" },
];
export const DEFAULT_JUDGE: JudgeConnection = { model: "jev-1.13.0", baseUrl: "https://api.typesafe.ai/v1", apiKey: "" };
export const DIRECTION_LABELS: Record<Direction, string> = { general: "普通提示词", image: "生图提示词", video: "视频提示词", product: "产品提示词" };
