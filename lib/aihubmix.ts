/** Official AiHubMix unified Chat Completions gateway. */
export const AIHUBMIX_BASE_URL = "https://aihubmix.com/v1";
export const AIHUBMIX_BACKUP_BASE_URL = "https://api.inferera.com/v1";
export const AIHUBMIX_RECOMMENDED_MODELS = [
  "gpt-6-astra",
  "claude-opus-5-5",
  "gemini-4-argon",
  "gpt-6.1-sol",
] as const;
export const AIHUBMIX_TIMEOUT_MS = 180_000;

// The gateway's SDK base includes /v1. Accept its documented bare-domain form
// and a pasted full Chat Completions endpoint without duplicating the route.
export function normalizeAiHubMixBase(value: string): string {
  const url = new URL(value);
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) path = path.slice(0, -"/chat/completions".length);
  url.pathname = path || "/v1";
  return url.toString().replace(/\/+$/, "");
}

export function buildAiHubMixRequest(model: string, prompt: string) {
  // GPT and o-series use the completion budget, including reasoning. The
  // gateway's Claude/Gemini examples retain max_tokens. Never send both fields,
  // or temperature/top_p that some reasoning models reject.
  const gpt = /^(?:gpt-|o\d(?:[.-]|$))/i.test(model);
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    ...(gpt ? { max_completion_tokens: 16_000 } : { max_tokens: 16_000 }),
    stream: false,
  };
}
