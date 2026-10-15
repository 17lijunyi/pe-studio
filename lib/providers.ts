import type { Brief, Candidate, Connection, Protocol } from "./types";
import { buildGenerationPrompt } from "./prompts";
import { isRecord, MAX_PROMPT_LENGTH, normalizeBaseUrl, RequestError, validateModelCatalogConnection } from "./request-validation";
import { AIHUBMIX_BACKUP_BASE_URL, AIHUBMIX_BASE_URL, AIHUBMIX_TIMEOUT_MS, buildAiHubMixRequest, normalizeAiHubMixBase } from "./aihubmix";
import { DEEPSEEK_BASE_URL, DEEPSEEK_TIMEOUT_MS, MODEL_CATALOG_MAX_ENTRIES, MODEL_CATALOG_TIMEOUT_MS, normalizeDeepSeekBase, type ModelCatalogConnection, type ModelCatalogEntry, type ModelCatalogResult } from "./provider-catalog";

export type Environment = Record<string, string | undefined>;
export interface TransportOptions { fetchImpl?: typeof fetch; env?: Environment; timeoutMs?: number }

export const OFFICIAL_BASES = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
  jev: "https://api.typesafe.ai/v1",
  aihubmix: AIHUBMIX_BASE_URL,
  deepseek: DEEPSEEK_BASE_URL,
} as const;

type AiHubMixAccessReason = "quota" | "account" | "permissions" | "ip" | "model" | "channel";
export interface UpstreamDiagnostics { status: number; code?: string; type?: string; requestId?: string; traceId?: string; accessReason?: AiHubMixAccessReason }

export class UpstreamError extends Error {
  constructor(message: string, readonly diagnostics?: UpstreamDiagnostics) {
    // Only the bounded, allowlisted metadata below reaches the existing public error field.
    const details = diagnostics ? [
      `HTTP ${diagnostics.status}`,
      diagnostics.code ? `服务商代码: ${diagnostics.code}` : "",
      diagnostics.type ? `类型: ${diagnostics.type}` : "",
      diagnostics.requestId ? `请求编号: ${diagnostics.requestId}` : "",
      diagnostics.traceId ? `追踪编号: ${diagnostics.traceId}` : "",
    ].filter(Boolean).join(" · ") : "";
    super(details ? `${message} [${details}]` : message);
    this.name = "UpstreamError";
  }
}

export function environment(): Environment {
  return typeof process !== "undefined" ? process.env : {};
}

export function configuredProviders(env: Environment = environment()) {
  return {
    openai: Boolean(env.OPENAI_API_KEY?.trim()),
    anthropic: Boolean(env.ANTHROPIC_API_KEY?.trim()),
    gemini: Boolean((env.GEMINI_API_KEY || env.GOOGLE_API_KEY)?.trim()),
    jev: Boolean((env.TYPESAFE_API_KEY || env.JEV_API_KEY)?.trim()),
    aihubmix: Boolean(env.AIHUBMIX_API_KEY?.trim()),
    deepseek: Boolean(env.DEEPSEEK_API_KEY?.trim()),
  };
}

export function resolveApiKey(provider: keyof typeof OFFICIAL_BASES, baseUrl: string, suppliedKey: string, env: Environment = environment()): string {
  if (suppliedKey.trim()) return suppliedKey.trim();
  // Exact normalized base match, not suffix/origin matching: never forward an env key to a custom endpoint.
  if (normalizeBaseUrl(baseUrl) !== OFFICIAL_BASES[provider]) {
    throw new UpstreamError("自定义 API 地址需要单独填写 API Key，不能使用服务器的官方密钥。");
  }
  const key = provider === "openai" ? env.OPENAI_API_KEY : provider === "anthropic" ? env.ANTHROPIC_API_KEY :
    provider === "gemini" ? env.GEMINI_API_KEY || env.GOOGLE_API_KEY : provider === "aihubmix" ? env.AIHUBMIX_API_KEY : provider === "deepseek" ? env.DEEPSEEK_API_KEY : env.TYPESAFE_API_KEY || env.JEV_API_KEY;
  if (!key?.trim()) throw new UpstreamError("尚未配置 API Key，请在模型设置中填写后重试。");
  return key.trim();
}

function upstreamStatusMessage(status: number, accessReason?: AiHubMixAccessReason): string {
  if (status === 403 && accessReason) {
    const messages: Record<AiHubMixAccessReason, string> = {
      quota: "AiHubMix 返回账户额度不足，请检查账户余额。",
      account: "AiHubMix 返回账户已停用，请在服务商控制台核查账户状态。",
      permissions: "AiHubMix 返回访问权限不足，请检查该连接的访问授权。",
      ip: "AiHubMix 返回当前 IP 不在该 Key 的允许范围内，请检查服务商的 IP 白名单设置。",
      model: "AiHubMix 返回该 Key 无权访问当前模型，请检查该 Key 的模型访问范围。",
      channel: "AiHubMix 返回服务通道已停用，请联系服务商核查。",
    };
    return messages[accessReason];
  }
  if (status === 401) return "服务商未通过本次请求的身份验证，请检查连接设置；具体原因尚未确认。";
  if (status === 403) return "服务商拒绝访问，请检查访问授权与连接设置；具体原因尚未确认。";
  if (status === 429) return "服务商请求限流或额度不足，请检查额度并稍后重试。";
  if (status === 404) return "服务商未找到该模型或 API 地址，请核对模型 ID 与基础地址。";
  if (status >= 300 && status < 400) return "API 地址发生跳转，请直接填写服务商的最终 HTTPS 地址。";
  if (status >= 500) return "服务商暂时不可用，请稍后重试。";
  return "服务商拒绝了请求，请检查模型 ID、API 协议与输入长度。";
}

const ERROR_BODY_LIMIT = 8_192;
const DIAGNOSTIC_CODES = new Set([
  "invalid_api_key", "authentication_error", "permission_error", "permission_denied", "access_denied",
  "insufficient_permissions", "unauthenticated", "forbidden", "unsupported_country_region_territory",
  "organization_restricted", "account_deactivated", "billing_not_active", "insufficient_quota", "insufficient_user_quota",
  "model_not_found", "model_not_available", "unsupported_model", "not_found",
  "invalid_request_error", "invalid_request", "bad_request", "invalid_argument", "invalid_parameter",
  "invalid_value", "unsupported_parameter", "rate_limit_exceeded", "rate_limit_error", "resource_exhausted",
  "overloaded_error", "server_error", "internal_server_error", "api_error",
]);

/** Only exact documented AiHubMix messages become fixed local explanations.
 * https://docs.aihubmix.com/en/FAQs/HTTP-Codes
 * The provider may put the last six key characters in these messages; no part
 * of the original message or key suffix is ever returned to the renderer.
 */
function aiHubMixAccessReason(code: string | undefined, message: unknown): AiHubMixAccessReason | undefined {
  if (code === "insufficient_user_quota") return "quota";
  if (typeof message !== "string" || message.length > 512) return undefined;
  const text = message.trim();
  if (/^Your account balance is insufficient\. Please recharge your account to continue using the API\.?$/i.test(text)) return "quota";
  if (/^Account suspended\.?$/i.test(text)) return "account";
  if (/^Forbidden [–—-] insufficient permissions\.?$/i.test(text)) return "permissions";
  if (/^Forbidden [–—-] key\([a-z0-9_-]{6}\) allowed only from approved IP ranges\.?$/i.test(text)) return "ip";
  if (/^Forbidden [–—-] key\([a-z0-9_-]{6}\) not authorized to access the requested model\.?$/i.test(text)) return "model";
  if (/^Forbidden [–—-] channel has been disabled\.?$/i.test(text)) return "channel";
  return undefined;
}

async function upstreamDiagnostics(response: Response, headers: Record<string, string>, body: unknown, url: string): Promise<UpstreamDiagnostics> {
  const diagnostics: UpstreamDiagnostics = { status: response.status };
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!["authorization", "x-api-key", "x-goog-api-key"].includes(name.toLowerCase())) continue;
    const secret = value.replace(/^(?:Bearer|Basic)\s+/i, "").trim();
    if (!secret) continue;
    secrets.push(secret, encodeURIComponent(secret));
    if (secret.length >= 6) secrets.push(secret.slice(-6));
    try { const encoded = btoa(secret); secrets.push(encoded, encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")); } catch { /* Non-ASCII credentials still have the exact-match guard. */ }
  }
  // Request identifiers must not be a credential or an echoed fragment of the submitted prompt.
  // The request itself is only checked in memory and is never included in diagnostics.
  let requestText = "";
  try { requestText = JSON.stringify(body) || ""; } catch { /* postJson already requires a serializable request. */ }
  const safeValue = (value: string) => !secrets.some(secret => value.includes(secret) || secret.includes(value)) && !requestText.includes(value);
  const code = (value: unknown) => typeof value === "string" && DIAGNOSTIC_CODES.has(value.toLowerCase()) && safeValue(value) && safeValue(value.toLowerCase()) ? value.toLowerCase() : undefined;
  const requestId = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,95}$/.test(value) && safeValue(value) ? value : undefined;
  diagnostics.requestId = requestId(response.headers.get("x-request-id")) || requestId(response.headers.get("request-id"));
  diagnostics.traceId = ["tid", "traceId", "trace-id", "x-trace-id", "x-tid"].map(name => requestId(response.headers.get(name))).find(Boolean);

  if (!response.body) return diagnostics;
  // Never expose free-form error messages, raw headers, HTML or complete response bodies.
  // Unknown code/type values are omitted, even when they look harmless.
  if (!/\bapplication\/(?:[a-z0-9.+-]+\+)?json\b/i.test(response.headers.get("content-type") || "")) {
    await response.body.cancel().catch(() => undefined);
    return diagnostics;
  }
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ERROR_BODY_LIMIT) { await reader.cancel().catch(() => undefined); return diagnostics; }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    const payload: unknown = JSON.parse(text);
    if (!isRecord(payload)) return diagnostics;
    const error = isRecord(payload.error) ? payload.error : payload;
    diagnostics.code = code(error.code) || code(error.status) || code(payload.code) || code(payload.status);
    diagnostics.type = code(error.type);
    diagnostics.requestId ||= requestId(error.request_id) || requestId(payload.request_id);
    diagnostics.traceId ||= requestId(error.tid) || requestId(error.traceId) || requestId(error.trace_id)
      || requestId(payload.tid) || requestId(payload.traceId) || requestId(payload.trace_id);
    // Keep provider-specific message recognition off custom gateways and other
    // vendors. A matching explanation is still a report from the upstream, not
    // an inferred root cause or permission to change the user's connection.
    const origin = new URL(url).origin;
    if (response.status === 403 && [AIHUBMIX_BASE_URL, AIHUBMIX_BACKUP_BASE_URL].some(base => new URL(base).origin === origin)) {
      diagnostics.accessReason = aiHubMixAccessReason(diagnostics.code, error.message ?? payload.message);
    }
  } catch { /* A malformed or interrupted error body must not erase the known HTTP status. */ }
  finally { reader.releaseLock(); }
  return diagnostics;
}

async function requestJson(method: "GET" | "POST", url: string, headers: Record<string, string>, body: unknown, options: TransportOptions = {}, maxResponseBytes = 1_048_576): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(url, {
      method,
      headers: { ...(method === "POST" ? { "Content-Type": "application/json" } : { Accept: "application/json" }), ...headers },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) {
      const diagnostics = await upstreamDiagnostics(response, headers, body, url);
      throw new UpstreamError(upstreamStatusMessage(response.status, diagnostics.accessReason), diagnostics);
    }
    if (!response.body) throw new UpstreamError("服务商返回了空响应，请重试。");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel();
          throw new UpstreamError("服务商响应过长，请缩短输入后重试。");
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    try { return JSON.parse(text); }
    catch { throw new UpstreamError("服务商返回了无效的 JSON，请确认 API 协议后重试。"); }
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    if (controller.signal.aborted) throw new UpstreamError(`模型响应超过 ${Math.ceil(timeoutMs / 1_000)} 秒，请稍后重试或选择更快的模型。`);
    throw new UpstreamError("无法连接服务商，请检查 API 地址与网络；API 跳转不会被跟随。");
  } finally { clearTimeout(timer); }
}

export async function postJson(url: string, headers: Record<string, string>, body: unknown, options: TransportOptions = {}): Promise<unknown> {
  return requestJson("POST", url, headers, body, options);
}

/** Authenticated metadata GET only. A successful list is not a paid-generation
 * entitlement check and does not prove every listed model is usable by this key. */
export async function listProviderModels(connection: ModelCatalogConnection, options: TransportOptions = {}): Promise<ModelCatalogResult> {
  const started = Date.now();
  try {
    const validated = validateModelCatalogConnection(connection);
    const protocol = validated.protocol as "aihubmix" | "deepseek";
    const key = resolveApiKey(protocol, validated.baseUrl, validated.apiKey, options.env);
    const payload = await requestJson("GET", `${validated.baseUrl}/models`, { Authorization: `Bearer ${key}` }, undefined, { ...options, timeoutMs: options.timeoutMs ?? MODEL_CATALOG_TIMEOUT_MS }, 1_048_576);
    if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length > MODEL_CATALOG_MAX_ENTRIES) throw new UpstreamError("服务商返回的模型目录格式不正确或条目过多。");
    const secrets = [key, encodeURIComponent(key), key.slice(-6)];
    try { const encoded = btoa(key); secrets.push(encoded, encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")); } catch { /* The exact key and suffix are still protected. */ }
    const safeText = (value: unknown, max: number): string | undefined => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f<>]/.test(value) && !secrets.some(secret => secret && value.includes(secret)) ? value.trim() : undefined;
    const seen = new Set<string>();
    const models: ModelCatalogEntry[] = [];
    for (const entry of payload.data) {
      if (!isRecord(entry)) continue;
      const id = safeText(entry.id, 200);
      if (!id || !/^[a-z0-9][a-z0-9._:/+@-]*$/i.test(id) || seen.has(id)) continue;
      seen.add(id);
      const displayName = safeText(entry.display_name ?? entry.name, 120);
      const ownedBy = safeText(entry.owned_by, 80);
      models.push({ id, ...(displayName ? { displayName } : {}), ...(ownedBy ? { ownedBy } : {}) });
    }
    if (payload.data.length && !models.length) throw new UpstreamError("服务商返回的模型目录没有可识别的模型 ID，请检查接口设置。");
    return { ok: true, provider: protocol, models, latencyMs: Date.now() - started };
  } catch (error) { return { ok: false, error: `模型目录读取失败：${safeErrorMessage(error)}` }; }
}

function textBlocks(content: unknown, type: string): string {
  if (!Array.isArray(content)) return "";
  return content.filter(isRecord).filter(block => block.type === type && typeof block.text === "string")
    .map(block => block.text as string).join("\n");
}

export function extractGenerationText(protocol: Protocol, payload: unknown): string {
  if (!isRecord(payload)) throw new UpstreamError("模型响应格式不正确，请确认 API 协议。");
  let text = "";
  if (protocol === "openai-responses") {
    if (payload.status === "incomplete") throw new UpstreamError("模型输出被截断，请缩短需求后重试。");
    if (payload.status === "failed" || payload.error) throw new UpstreamError("模型未能完成生成，请稍后重试。");
    if (Array.isArray(payload.output)) {
      text = payload.output.filter(isRecord).filter(item => item.type === "message")
        .map(item => textBlocks(item.content, "output_text")).filter(Boolean).join("\n");
    }
    // Some compatible Responses gateways expose the SDK-style convenience field.
    if (!text && typeof payload.output_text === "string") text = payload.output_text;
  } else if (protocol === "openai-compatible" || protocol === "aihubmix" || protocol === "deepseek") {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (isRecord(choice)) {
      if (choice.finish_reason === "length") throw new UpstreamError("模型输出被截断，请缩短需求后重试。");
      const message = isRecord(choice.message) ? choice.message : {};
      text = typeof message.content === "string" ? message.content : textBlocks(message.content, "text");
    }
  } else if (protocol === "anthropic") {
    if (payload.stop_reason === "max_tokens") throw new UpstreamError("模型输出被截断，请缩短需求后重试。");
    text = textBlocks(payload.content, "text");
  } else {
    const candidate = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
    if (isRecord(candidate)) {
      if (candidate.finishReason === "MAX_TOKENS") throw new UpstreamError("模型输出被截断，请缩短需求后重试。");
      const content = isRecord(candidate.content) ? candidate.content : {};
      if (Array.isArray(content.parts)) {
        text = content.parts.filter(isRecord).filter(part => part.thought !== true && typeof part.text === "string")
          .map(part => part.text as string).join("\n");
      }
    }
  }
  if (!text.trim()) throw new UpstreamError("模型没有返回提示词，可能被服务商过滤或输出为空，请调整输入后重试。");
  return text.trim();
}

export function parseGenerationText(text: string): Pick<Candidate, "prompt" | "changes" | "assumptions"> {
  const clean = text.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, "$1").trim();
  let value: unknown;
  try { value = JSON.parse(clean); } catch { throw new UpstreamError("模型未返回约定的 JSON 提示词格式，请重新生成。"); }
  if (!isRecord(value) || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > MAX_PROMPT_LENGTH) {
    throw new UpstreamError("模型返回的提示词为空或过长，请重新生成。");
  }
  const list = (items: unknown): string[] => {
    if (!Array.isArray(items) || items.length > 12 || items.some(item => typeof item !== "string" || item.length > 1_000)) {
      throw new UpstreamError("模型返回的修改说明格式不正确，请重新生成。");
    }
    return items.map(item => item.trim()).filter(Boolean);
  };
  return { prompt: value.prompt.trim(), changes: list(value.changes), assumptions: list(value.assumptions) };
}

export function safeErrorMessage(error: unknown): string {
  return error instanceof UpstreamError || error instanceof RequestError ? error.message : "模型调用失败，请稍后重试。";
}

export async function generateCandidate(brief: Brief, connection: Connection, options: TransportOptions = {}): Promise<Candidate> {
  const started = Date.now();
  const base: Candidate = { id: connection.id, provider: connection.label, model: connection.model, prompt: "", changes: [], assumptions: [], status: "error", latencyMs: 0 };
  try {
    const protocol = connection.protocol;
    if (protocol === "local-agent") throw new UpstreamError("本地 Agent 仅可在 macOS App 内运行，不能通过云端模型接口调用。");
    const validatedBase = normalizeBaseUrl(connection.baseUrl);
    const baseUrl = protocol === "aihubmix" ? normalizeAiHubMixBase(validatedBase) : protocol === "deepseek" ? normalizeDeepSeekBase(validatedBase) : validatedBase;
    const provider = protocol === "anthropic" ? "anthropic" : protocol === "gemini" ? "gemini" : protocol === "aihubmix" ? "aihubmix" : protocol === "deepseek" ? "deepseek" : "openai";
    const key = resolveApiKey(provider, baseUrl, connection.apiKey, options.env);
    const prompt = buildGenerationPrompt(brief);
    let endpoint: string;
    let body: unknown;
    let headers: Record<string, string>;
    if (protocol === "openai-responses") {
      endpoint = `${baseUrl}/responses`;
      headers = { Authorization: `Bearer ${key}` };
      body = { model: connection.model, input: prompt, max_output_tokens: 6_000, store: false };
    } else if (protocol === "aihubmix") {
      endpoint = `${baseUrl}/chat/completions`;
      headers = { Authorization: `Bearer ${key}` };
      body = buildAiHubMixRequest(connection.model, prompt);
    } else if (protocol === "deepseek") {
      endpoint = `${baseUrl}/chat/completions`;
      headers = { Authorization: `Bearer ${key}` };
      body = { model: connection.model, messages: [{ role: "user", content: prompt }], max_tokens: 16_000, stream: false };
    } else if (protocol === "openai-compatible") {
      endpoint = `${baseUrl}/chat/completions`;
      headers = { Authorization: `Bearer ${key}` };
      body = { model: connection.model, messages: [{ role: "user", content: prompt }], max_tokens: 6_000, stream: false };
    } else if (protocol === "anthropic") {
      endpoint = `${baseUrl}/messages`;
      headers = { "x-api-key": key, "anthropic-version": "2023-06-01" };
      body = { model: connection.model, max_tokens: 6_000, messages: [{ role: "user", content: prompt }] };
    } else {
      endpoint = `${baseUrl}/models/${encodeURIComponent(connection.model.replace(/^models\//, ""))}:generateContent`;
      headers = { "x-goog-api-key": key };
      body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 6_000, responseMimeType: "application/json" } };
    }
    const transport = protocol === "aihubmix" || protocol === "deepseek" ? { ...options, timeoutMs: options.timeoutMs ?? (protocol === "aihubmix" ? AIHUBMIX_TIMEOUT_MS : DEEPSEEK_TIMEOUT_MS) } : options;
    const payload = await postJson(endpoint, headers, body, transport);
    const result = parseGenerationText(extractGenerationText(protocol, payload));
    if (JSON.stringify(result).includes(key)) throw new UpstreamError("服务商返回了异常内容，已隐藏，请检查服务商设置。");
    return { ...base, ...result, status: "success", latencyMs: Date.now() - started };
  } catch (error) {
    return { ...base, error: safeErrorMessage(error), latencyMs: Date.now() - started };
  }
}
