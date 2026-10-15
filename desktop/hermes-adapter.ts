import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isRecord } from "../lib/request-validation";

export interface HermesInvocation { command: string; argsPrefix: string[] }

/** Read only the installed launcher's shebang, never its user config/auth. */
export async function resolveHermesInvocation(commandPath: string, helperPath: string): Promise<HermesInvocation | undefined> {
  if (!isAbsolute(commandPath) || !isAbsolute(helperPath)) return undefined;
  let file;
  try {
    file = await open(commandPath, "r");
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0];
    // Console-script installs use a fixed absolute Python interpreter. Do not
    // run env/shell launchers or attempt to interpret arbitrary wrapper code.
    const interpreter = firstLine.match(/^#!(\/[^\r\n]*\/python(?:3(?:\.\d+)?)?)[ \t]*$/)?.[1];
    if (!interpreter || !(await stat(interpreter)).isFile()) return undefined;
    await access(interpreter, constants.X_OK);
    if (!(await stat(helperPath)).isFile()) return undefined;
    return { command: interpreter, argsPrefix: ["-I", "-B", helperPath] };
  } catch { return undefined; }
  finally { await file?.close().catch(() => undefined); }
}

export function hermesProbeArguments(): string[] { return ["--probe"]; }
export function hermesArguments(model: string): string[] { return ["--model", model]; }

export function supportsRestrictedHermesRun(output: string): boolean {
  try {
    const result: unknown = JSON.parse(output);
    return isRecord(result) && result.type === "pe-hermes-probe" && result.available === true
      && typeof result.version === "string" && /^0\.11\.\d+$/.test(result.version)
      && result.textOnly === true;
  } catch { return false; }
}

const ERRORS: Record<string, string> = {
  unsupported: "此 Hermes 版本或安装方式暂不支持受限运行，请更新命令行工具。",
  provider: "Hermes 当前配置使用的连接方式暂不支持纯文本模式，请在 Hermes 中选择 API 或受支持的登录连接。",
  model: "Hermes 尚未配置默认模型，请先在终端完成模型设置。",
  credentials: "Hermes 未完成生成，请在终端确认登录状态、接口与模型权限后重试。",
  input: "Hermes 未能接收有效提示词，请重试。",
  response: "Hermes 未返回完整提示词，请重试。",
  restricted: "Hermes 返回了工具调用或异常内容，已停止采用此次结果。",
  timeout: "Hermes 连接或生成超时，可稍后单独重试。",
  network: "Hermes 无法连接模型服务，请检查网络与代理设置后重试。",
  authentication: "Hermes 连接认证未通过，请在终端检查登录或 API Key。",
  permission: "Hermes 的模型服务拒绝访问，请检查账号与模型权限。",
  billing: "Hermes 的模型服务要求检查余额或计费状态。",
  rate_limit: "Hermes 的模型服务暂时限流，请稍后重试。",
  invalid_request: "Hermes 的模型服务拒绝了请求，请检查模型、接口协议与输入要求。",
  not_found: "Hermes 使用的模型或接口未找到，请检查本地配置。",
  unavailable: "Hermes 的模型服务暂时不可用，请稍后重试。",
  runtime: "Hermes 运行未完成，请在终端确认本地工具能够正常生成。",
};
const PHASES: Record<string, string> = { setup: "初始化", routing: "读取本地连接", request: "模型请求", response: "结果校验" };

export function hermesFinalText(output: string): string {
  let result: unknown;
  try { result = JSON.parse(output); } catch { throw new Error("Hermes 返回了无法识别的结果，请重试。"); }
  if (!isRecord(result) || result.type !== "pe-hermes-result") throw new Error("Hermes 返回了无法识别的结果，请重试。");
  if (result.ok !== true) {
    const message = typeof result.code === "string" && Object.hasOwn(ERRORS, result.code) ? ERRORS[result.code] : ERRORS.runtime;
    const phase = typeof result.phase === "string" && Object.hasOwn(PHASES, result.phase) ? PHASES[result.phase] : undefined;
    throw new Error(phase ? `${message}（阶段：${phase}）` : message);
  }
  if (result.textOnly !== true || typeof result.text !== "string" || !result.text.trim()) throw new Error(ERRORS.restricted);
  return result.text;
}
