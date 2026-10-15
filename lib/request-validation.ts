import type { Brief, Candidate, Connection, JudgeConnection, Protocol } from "./types";
import { normalizeAiHubMixBase } from "./aihubmix";
import { normalizeDeepSeekBase, type ModelCatalogConnection } from "./provider-catalog";

export const MAX_REQUEST_BYTES = 256 * 1024;
export const MAX_PROMPT_LENGTH = 18_000;

export class RequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "RequestError";
    this.status = status;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new RequestError(`${label}格式不正确。`);
  return value;
}

function field(data: Record<string, unknown>, name: string, max: number, required = false): string {
  const value = data[name];
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new RequestError(`${name} 为空、格式不正确或超过 ${max} 字符。`);
  }
  return value.trim();
}

function enumeration<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new RequestError(`${label}不在支持的选项中。`);
  }
  return value as T;
}

export function validateBrief(value: unknown): Brief {
  const data = record(value, "需求");
  return {
    direction: enumeration(data.direction, ["general", "image", "video", "product"], "提示词方向"),
    input: field(data, "input", 12_000, true),
    targetModel: field(data, "targetModel", 200),
    context: field(data, "context", 6_000),
    constraints: field(data, "constraints", 4_000),
    intensity: enumeration(data.intensity, ["faithful", "balanced", "creative"], "优化强度"),
    outputLanguage: enumeration(data.outputLanguage, ["zh", "en"], "输出语言"),
  };
}

// URL normalizes alternative IPv4 forms (127.1, hexadecimal, integer) before this check.
function unsafeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") && !host.includes(":")) return true;
  if (host === "localhost" || /\.(localhost|local|internal|lan|home|invalid|test)$/.test(host)) return true;
  if (host.startsWith("[")) {
    // Only global-unicast IPv6 is accepted; reject mapped IPv4, loopback and local ranges.
    const ipv6 = host.slice(1, -1);
    return !/^[23][0-9a-f]{3}:/.test(ipv6) || ipv6.startsWith("2001:db8:");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  return false;
}

export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new RequestError("API 地址不是有效的 HTTPS URL。"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || unsafeHost(url.hostname)) {
    throw new RequestError("API 地址必须是公网 HTTPS 地址，且不能包含账号、查询参数或片段。");
  }
  return url.toString().replace(/\/+$/, "");
}

function keyField(data: Record<string, unknown>): string {
  const key = field(data, "apiKey", 2_048);
  if (/[\r\n\x00-\x1f\x7f]/.test(key)) throw new RequestError("API Key 格式不正确。");
  return key;
}

export function validateConnection(value: unknown): Connection {
  const data = record(value, "模型设置");
  const protocol = enumeration<Protocol>(data.protocol, ["openai-responses", "openai-compatible", "anthropic", "gemini", "aihubmix", "deepseek", "local-agent"], "API 协议");
  if (protocol === "local-agent") throw new RequestError("本地 Agent 仅可在 macOS App 内运行，不能通过云端模型接口调用。");
  const baseUrl = normalizeBaseUrl(field(data, "baseUrl", 1_000, true));
  return {
    id: field(data, "id", 100, true),
    label: field(data, "label", 100, true),
    protocol,
    model: field(data, "model", 200, true),
    baseUrl: protocol === "aihubmix" ? normalizeAiHubMixBase(baseUrl) : protocol === "deepseek" ? normalizeDeepSeekBase(baseUrl) : baseUrl,
    apiKey: keyField(data),
  };
}

export function validateModelCatalogConnection(value: unknown): ModelCatalogConnection {
  const data = record(value, "模型目录连接");
  if (data.protocol === "local-agent") throw new RequestError("本地 Agent 不使用云端模型目录，请在 macOS App 中选择本地 Agent。");
  const protocol = enumeration<"aihubmix" | "deepseek">(data.protocol, ["aihubmix", "deepseek"], "模型目录厂商");
  const baseUrl = normalizeBaseUrl(field(data, "baseUrl", 1_000, true));
  return { protocol, baseUrl: protocol === "aihubmix" ? normalizeAiHubMixBase(baseUrl) : normalizeDeepSeekBase(baseUrl), apiKey: keyField(data) };
}

export function validateJudgeConnection(value: unknown): JudgeConnection {
  const data = record(value, "Jev 设置");
  return {
    model: field(data, "model", 200, true),
    baseUrl: normalizeBaseUrl(field(data, "baseUrl", 1_000, true)),
    apiKey: keyField(data),
  };
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 12 || value.some(item => typeof item !== "string" || item.length > 1_000)) {
    throw new RequestError(`${label}格式不正确。`);
  }
  return value.map(item => item.trim()).filter(Boolean);
}

export function validateCandidates(value: unknown): Candidate[] {
  if (!Array.isArray(value) || value.length > 3) throw new RequestError("每次最多评审三个候选提示词。");
  const seen = new Set<string>();
  const candidates = value.map(raw => {
    const data = record(raw, "候选提示词");
    const id = field(data, "id", 100, true);
    if (seen.has(id)) throw new RequestError("候选提示词的 ID 不能重复。");
    seen.add(id);
    const status = enumeration(data.status, ["success", "error"], "候选状态");
    const prompt = field(data, "prompt", MAX_PROMPT_LENGTH, status === "success");
    return {
      id, status, prompt,
      provider: field(data, "provider", 100),
      model: field(data, "model", 200),
      changes: stringList(data.changes ?? [], "修改说明"),
      assumptions: stringList(data.assumptions ?? [], "假设说明"),
      latencyMs: typeof data.latencyMs === "number" && Number.isFinite(data.latencyMs) && data.latencyMs >= 0 ? data.latencyMs : 0,
    };
  });
  if (candidates.reduce((sum, item) => sum + item.prompt.length, 0) > 40_000) {
    throw new RequestError("候选提示词总长度超过 40000 字符，请缩短后再评审。");
  }
  return candidates;
}

export async function readRequestJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new RequestError("请使用 JSON 格式提交请求。", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_REQUEST_BYTES) throw new RequestError("请求内容过长，请缩短后重试。", 413);
  if (!request.body) throw new RequestError("请求内容为空。");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new RequestError("请求内容过长，请缩短后重试。", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  try { return record(JSON.parse(text), "请求"); }
  catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError("请求不是有效的 JSON。");
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export function requestErrorResponse(error: unknown): Response {
  return jsonResponse({ error: error instanceof RequestError ? error.message : "请求处理失败，请稍后重试。" }, error instanceof RequestError ? error.status : 500);
}
