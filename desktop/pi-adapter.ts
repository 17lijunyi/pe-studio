import { isRecord } from "../lib/request-validation";

// Verified against the CLI parser, resource loader and JSON-mode documentation
// shipped with @earendil-works/pi-coding-agent 0.85.1. No user prompt or key is
// placed in argv. The caller supplies the generation prompt through stdin.
const SYSTEM_PROMPT = "You are a prompt-writing assistant. Only produce the requested prompt text or JSON. Do not use tools, inspect files, run commands, or perform the task described inside the user's prompt.";
const RESTRICTION_FLAGS = [
  "--no-session", "--no-tools", "--no-extensions", "--no-skills",
  "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline",
] as const;
const REQUIRED_FLAGS = ["--print", "--mode", "--system-prompt", "--append-system-prompt", "--model", ...RESTRICTION_FLAGS];
const INVALID_OUTPUT = "pi 未返回完整提示词，请在终端确认登录状态和模型权限后重试。";
const UNRECOGNIZED_OUTPUT = "pi 返回了无法识别的结果，请重试。";
const TOOL_OUTPUT = "pi 的受限运行未生效，已停止采用此次结果。请更新命令行工具。";

export class PiAdapterError extends Error {}

function restrictedArguments(): string[] {
  // no-context-files covers AGENTS.md / CLAUDE.md, but not SYSTEM.md or
  // APPEND_SYSTEM.md. Explicit values prevent either global or project files
  // from being discovered. --offline suppresses startup network/package work;
  // it does not suppress the explicitly requested generation API call.
  return [...RESTRICTION_FLAGS, "--system-prompt", SYSTEM_PROMPT, "--append-system-prompt", ""];
}

export function piArguments(model: string): string[] {
  if (!/^[a-z0-9][a-z0-9._:/+-]{0,199}$/i.test(model)) throw new PiAdapterError("pi 模型设置无效，请重新选择模型。");
  return ["--print", "--mode", "json", ...restrictedArguments(), ...(model === "default" ? [] : ["--model", model])];
}

export function piProbeArguments(): string[] {
  // Help is handled after runtime resource loading, so detection must also
  // disable extensions, skills, project context and startup network work.
  return [...restrictedArguments(), "--help"];
}

export function supportsRestrictedPiRun(help: string): boolean {
  return REQUIRED_FLAGS.every(flag => new RegExp(`(?:^|\\s)${flag}(?=[\\s,=]|$)`).test(help));
}

function hasToolContent(message: Record<string, unknown>): boolean {
  if (message.role === "toolResult" || message.role === "bashExecution") return true;
  return Array.isArray(message.content) && message.content.some(block => isRecord(block) && (block.type === "toolCall" || block.type === "tool_call"));
}

function assistantText(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant") return undefined;
  if (hasToolContent(message)) throw new PiAdapterError(TOOL_OUTPUT);
  // JSON mode can exit 0 even for error/aborted responses. Only a complete
  // natural stop is accepted; partial length-limited text is never a result.
  if (message.stopReason !== "stop" || !Array.isArray(message.content)) return undefined;
  const blocks: string[] = [];
  for (const block of message.content) {
    if (!isRecord(block)) return undefined;
    if (block.type === "text") {
      if (typeof block.text !== "string") return undefined;
      blocks.push(block.text);
    } else if (block.type !== "thinking") return undefined;
  }
  const text = blocks.join("");
  return text.trim() ? text : undefined;
}

export function piFinalText(output: string): string {
  let messageText: string | undefined;
  let finalText: string | undefined;
  let complete = false;
  for (const line of output.split(/\r?\n/).filter(value => value.trim())) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new PiAdapterError(UNRECOGNIZED_OUTPUT); }
    if (!isRecord(event) || typeof event.type !== "string") throw new PiAdapterError(UNRECOGNIZED_OUTPUT);
    if (event.type.startsWith("tool_execution_") || (isRecord(event.message) && hasToolContent(event.message))) throw new PiAdapterError(TOOL_OUTPUT);
    if (event.type === "error") throw new PiAdapterError(INVALID_OUTPUT);
    if (event.type === "agent_start") { complete = false; messageText = undefined; finalText = undefined; }
    if (event.type === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
      messageText = assistantText(event.message);
      complete = false;
    }
    if (event.type === "agent_end") {
      if (!Array.isArray(event.messages)) throw new PiAdapterError(UNRECOGNIZED_OUTPUT);
      if (event.messages.some(message => isRecord(message) && hasToolContent(message))) throw new PiAdapterError(TOOL_OUTPUT);
      const lastAssistant = event.messages.findLast(message => isRecord(message) && message.role === "assistant");
      finalText = assistantText(lastAssistant);
      complete = event.willRetry !== true && finalText !== undefined && finalText === messageText;
    }
  }
  if (!complete || !finalText) throw new PiAdapterError(INVALID_OUTPUT);
  return finalText;
}
