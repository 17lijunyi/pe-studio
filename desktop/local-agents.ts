import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { buildGenerationPrompt } from "../lib/prompts";
import { parseGenerationText } from "../lib/providers";
import { isRecord, validateBrief } from "../lib/request-validation";
import type { Brief, Candidate, Connection } from "../lib/types";
import { PiAdapterError, piArguments, piFinalText, piProbeArguments, supportsRestrictedPiRun } from "./pi-adapter";
import { hermesArguments, hermesFinalText, hermesProbeArguments, resolveHermesInvocation, supportsRestrictedHermesRun } from "./hermes-adapter";
import { localAgentProxyEnvironment, readLocalAgentProxyEnvironment } from "./local-agent-network";

export type LocalAgentId = "codex" | "claude" | "pi" | "hermes";
export interface LocalAgentStatus { id: LocalAgentId; label: string; installed: boolean; available: boolean; status: string; models?: string[] }

const AGENTS = [{ id: "codex", label: "Codex CLI" }, { id: "claude", label: "Claude Code" }, { id: "pi", label: "pi" }, { id: "hermes", label: "Hermes" }] as const;
const MAX_OUTPUT_BYTES = 1_048_576;
const RUN_TIMEOUT_MS = 600_000;
const IDLE_TIMEOUT_MS = 180_000;
class LocalAgentError extends Error {}

type SpawnAgent = (command: string, args: string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;
/** Dependency injection is for isolated tests; none of it crosses desktop IPC. */
export interface LocalAgentDependencies {
  findExecutable?: (id: LocalAgentId) => Promise<string | undefined>;
  spawn?: SpawnAgent;
  makeDirectory?: () => Promise<string>;
  removeDirectory?: (directory: string) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
  /** Total generation deadline; progress never extends it. */
  timeoutMs?: number;
  /** Streaming generation deadline since the most recent nonempty stdout chunk. */
  idleTimeoutMs?: number;
  probeTimeoutMs?: number;
  maxOutputBytes?: number;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  hermesInvocation?: (command: string) => Promise<{ command: string; argsPrefix: string[] } | undefined>;
}

async function findExecutable(id: LocalAgentId): Promise<string | undefined> {
  const home = homedir();
  const candidates = [
    ...(process.env.PATH || "").split(delimiter).filter(path => path && isAbsolute(path)).map(path => join(path, id)),
    join(home, ".local", "bin", id), "/opt/homebrew/bin/" + id, "/usr/local/bin/" + id,
    ...(id === "hermes" ? [join(home, ".hermes", "hermes-agent", "venv", "bin", "hermes")] : []),
    ...(id === "codex" ? ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex", "/Applications/Codex.app/Contents/Resources/codex"] : []),
  ];
  for (const path of new Set(candidates)) {
    try { if ((await stat(path)).isFile()) { await access(path, constants.X_OK); return path; } }
    catch { /* Fixed executable locations only; never inspect shell profiles or directories. */ }
  }
  return undefined;
}

function cliEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // The CLI owns its existing login. Never inject this app's provider keys,
  // startup hooks, NODE_OPTIONS, shell profiles or arbitrary model endpoints.
  const result: NodeJS.ProcessEnv = { NODE_ENV: "production", NO_COLOR: "1", TERM: "dumb", CI: "1" };
  for (const name of ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "HERMES_HOME"]) {
    if (source[name]) result[name] = source[name];
  }
  // Finder-launched apps may have only /usr/bin:/bin. Keep explicit absolute
  // PATH entries and add the same fixed installation directories we inspect.
  // No shell initialization files are sourced and no credentials are copied.
  const home = source.HOME || homedir();
  result.PATH = [...new Set([...(source.PATH || "").split(delimiter).filter(path => path && isAbsolute(path)), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter);
  return result;
}

function codexArguments(model: string, directory: string): string[] {
  // Public CLI flags + current config-schema.json, not a shell command.
  // ignore-user-config keeps the CLI's auth store while excluding user tools.
  const overrides = [
    "features.shell_tool=false", "features.shell_snapshot=false", "features.js_repl=false", "features.code_mode=false",
    "features.hooks=false", "features.plugin_hooks=false", "features.plugins=false", "features.apps=false",
    "features.multi_agent=false", "features.multi_agent_v2=false", "features.memories=false", "features.memory_tool=false",
    "features.goals=false", "features.skip_host_skill_discovery=true", "features.skill_search=false",
    "skills.bundled.enabled=false", "skills.include_instructions=false", "orchestrator.mcp.enabled=false", "cloud.skills.enabled=false",
    "mcp_servers={}", "project_doc_max_bytes=0", 'web_search="disabled"', 'approval_policy="never"', 'history.persistence="none"',
    "otel.log_user_prompt=false", "otel.log_agent_responses=false", "analytics.enabled=false",
    `log_dir=${JSON.stringify(join(directory, "logs"))}`, `sqlite_home=${JSON.stringify(directory)}`,
  ];
  return ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "--strict-config", "--color", "never", ...overrides.flatMap(value => ["-c", value]), ...(model === "default" ? [] : [`--model=${model}`]), "-"];
}

function claudeArguments(model: string): string[] {
  return ["-p", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}', "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json", "--permission-mode", "dontAsk", "--no-chrome", ...(model === "default" ? [] : [`--model=${model}`])];
}

function supportsRestrictedRun(id: LocalAgentId, help: string): boolean {
  if (id === "pi") return supportsRestrictedPiRun(help);
  if (id === "hermes") return supportsRestrictedHermesRun(help);
  const flags = id === "codex"
    ? ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "--json", "--strict-config"]
    : ["--tools", "--strict-mcp-config", "--mcp-config", "--settings", "--setting-sources", "--disable-slash-commands", "--no-session-persistence", "--output-format", "--permission-mode", "--no-chrome"];
  return flags.every(flag => help.includes(flag));
}

function finalText(id: LocalAgentId, output: string): string {
  if (id === "pi" || id === "hermes") {
    try { return id === "pi" ? piFinalText(output) : hermesFinalText(output); }
    catch (error) { throw new LocalAgentError(error instanceof Error ? error.message : "本地 Agent 未返回完整提示词，请重试。"); }
  }
  if (id === "claude") {
    let result: unknown;
    try { result = JSON.parse(output); } catch { throw new LocalAgentError("Claude Code 返回了无法识别的结果，请重试。"); }
    if (!isRecord(result) || result.type !== "result" || result.subtype !== "success" || result.is_error === true || typeof result.result !== "string") throw new LocalAgentError("Claude Code 未完成生成，请在终端确认登录状态和模型权限后重试。");
    return result.result;
  }
  let text = "", complete = false;
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new LocalAgentError("Codex CLI 返回了无法识别的结果，请重试。"); }
    if (!isRecord(event)) continue;
    if (event.type === "turn.failed" || event.type === "error") throw new LocalAgentError("Codex CLI 未完成生成，请在终端确认登录状态和模型权限后重试。");
    if (event.type === "turn.completed") complete = true;
    if ((event.type === "item.started" || event.type === "item.completed") && isRecord(event.item)) {
      if (["command_execution", "mcp_tool_call", "file_change", "web_search"].includes(String(event.item.type))) throw new LocalAgentError("本地 Agent 的受限运行未生效，已停止采用此次结果。请更新命令行工具。");
      if (event.type === "item.completed" && event.item.type === "agent_message" && typeof event.item.text === "string") text = event.item.text;
    }
  }
  if (!complete || !text.trim()) throw new LocalAgentError("Codex CLI 未返回完整提示词，请重试。");
  return text;
}

export function createLocalAgentRunner(dependencies: LocalAgentDependencies = {}) {
  const locate = dependencies.findExecutable || findExecutable;
  const spawnProcess: SpawnAgent = dependencies.spawn || ((command, args, options) => spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }));
  const makeDirectory = dependencies.makeDirectory || (() => mkdtemp(join(tmpdir(), "pe-studio-agent-")));
  const removeDirectory = dependencies.removeDirectory || (directory => rm(directory, { recursive: true, force: true }));
  let networkEnvironment: Promise<Record<string, string | undefined>> | undefined;
  let networkEnvironmentExpires = 0;
  const environment = async () => {
    const source = dependencies.environment || process.env;
    // Unit-test environments stay isolated from the user's system settings.
    // Real probes in one batch share a short-lived, bounded read of the
    // existing macOS proxy. Only proxy variables cross this boundary.
    if (dependencies.environment) return { ...cliEnvironment(source), ...localAgentProxyEnvironment(source) };
    if (!networkEnvironment || Date.now() >= networkEnvironmentExpires) {
      networkEnvironment = readLocalAgentProxyEnvironment(source);
      networkEnvironmentExpires = Date.now() + 3_000;
    }
    return { ...cliEnvironment(source), ...await networkEnvironment };
  };
  const timeoutMs = Math.max(1, Math.min(dependencies.timeoutMs ?? RUN_TIMEOUT_MS, RUN_TIMEOUT_MS));
  const idleTimeoutMs = Math.max(1, Math.min(dependencies.idleTimeoutMs ?? IDLE_TIMEOUT_MS, IDLE_TIMEOUT_MS));
  const probeTimeoutMs = Math.max(1, Math.min(dependencies.probeTimeoutMs ?? 5_000, 5_000));
  const outputLimit = Math.max(1, Math.min(dependencies.maxOutputBytes ?? MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES));
  const killProcessGroup = dependencies.killProcessGroup || ((pid: number, kind: NodeJS.Signals) => { process.kill(-pid, kind); });
  const hermesInvocation = dependencies.hermesInvocation || (command => {
    // External Python needs the explicitly unpacked helper, not an ASAR path.
    const base = typeof __dirname === "string" ? __dirname.replace(/\.asar(?=[/\\])/, ".asar.unpacked") : join(process.cwd(), "desktop");
    return resolveHermesInvocation(command, join(base, "assets", "hermes-runner.py"));
  });

  async function invocation(id: LocalAgentId, command: string) {
    if (id !== "hermes") return { command, argsPrefix: [] as string[] };
    const resolved = await hermesInvocation(command);
    if (!resolved) throw new LocalAgentError("Hermes 安装方式暂不支持受限运行，请检查命令行安装及 Python 环境。");
    return resolved;
  }

  async function run(command: string, args: string[], directory: string, input: string, timeout: number, limit: number, signal?: AbortSignal, idleTimeout?: number): Promise<string> {
    if (signal?.aborted) throw new LocalAgentError("本地 Agent 任务已取消。");
    const childEnvironment = await environment();
    if (signal?.aborted) throw new LocalAgentError("本地 Agent 任务已取消。");
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try { child = spawnProcess(command, args, { cwd: directory, shell: false, detached: true, env: childEnvironment }); }
      catch { reject(new LocalAgentError("无法启动本地 Agent，请检查命令行工具是否可运行。")); return; }
      let bytes = 0, settled = false, failure: LocalAgentError | undefined;
      const chunks: Buffer[] = [];
      let stopTimer: ReturnType<typeof setTimeout> | undefined;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = (kind: NodeJS.Signals) => {
        if (child.pid && process.platform !== "win32") { try { killProcessGroup(child.pid, kind); } catch { /* May already have exited. */ } }
        try { child.kill(kind); } catch { /* May already have exited. */ }
      };
      const finish = (error?: LocalAgentError) => {
        if (settled) return;
        settled = true; clearTimeout(timer); if (idleTimer) clearTimeout(idleTimer); if (stopTimer) clearTimeout(stopTimer);
        signal?.removeEventListener("abort", abort);
        if (error) { chunks.length = 0; reject(error); }
        else { const value = Buffer.concat(chunks).toString("utf8"); chunks.length = 0; resolve(value); }
      };
      const stop = (error: LocalAgentError) => {
        if (settled || failure) return;
        // These runs have no write tools or session persistence to flush. Kill
        // the entire detached group synchronously: a parent exiting early must
        // not cancel a delayed kill and leave grandchildren running. This also
        // works when Electron exits immediately after aborting its controllers.
        failure = error; clearTimeout(timer); if (idleTimer) clearTimeout(idleTimer); kill("SIGKILL");
        if (!settled) {
          stopTimer = setTimeout(() => { kill("SIGKILL"); finish(error); }, 1_000);
        }
      };
      const abort = () => stop(new LocalAgentError("本地 Agent 任务已取消。"));
      // Streaming output proves the agent is still making progress, but it
      // must not be able to extend the independent total deadline forever.
      const timer = setTimeout(() => stop(new LocalAgentError("本地 Agent 响应超时：已超过总等待上限，请稍后重试。")), timeout);
      const resetIdleTimer = () => {
        if (idleTimeout === undefined) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop(new LocalAgentError("本地 Agent 响应超时：长时间没有输出，请稍后重试。")), idleTimeout);
      };
      resetIdleTimer();
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer | string) => {
        if (settled || failure) return;
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.length;
        if (bytes > limit) stop(new LocalAgentError("本地 Agent 输出过长，已停止此次任务。"));
        else {
          chunks.push(value);
          if (value.length > 0) resetIdleTimer();
        }
      });
      // Drain stderr but retain no text: it can contain credentials or prompts.
      child.stderr.on("data", (chunk: Buffer | string) => {
        if (settled || failure) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > limit) stop(new LocalAgentError("本地 Agent 输出过长，已停止此次任务。"));
      });
      child.once("error", () => stop(new LocalAgentError("无法启动本地 Agent，请检查命令行工具是否可运行。")));
      child.once("close", code => finish(failure || (code === 0 ? undefined : new LocalAgentError("本地 Agent 未完成生成，请在终端确认登录状态和模型权限后重试。"))));
      child.stdin.on("error", () => stop(new LocalAgentError("本地 Agent 未能接收任务，请重试。")));
      if (signal?.aborted) abort();
      else child.stdin.end(input);
    });
  }

  async function probe(id: LocalAgentId, command: string, directory: string, signal?: AbortSignal): Promise<boolean> {
    const plan = await invocation(id, command);
    const args = id === "codex" ? ["exec", "--help"] : id === "pi" ? piProbeArguments() : id === "hermes" ? hermesProbeArguments() : ["--help"];
    const help = await run(plan.command, [...plan.argsPrefix, ...args], directory, "", probeTimeoutMs, Math.min(outputLimit, 131_072), signal);
    return supportsRestrictedRun(id, help);
  }

  async function listLocalAgents(): Promise<LocalAgentStatus[]> {
    return Promise.all(AGENTS.map(async agent => {
      const command = await locate(agent.id);
      if (!command) return { ...agent, installed: false, available: false, status: "未检测到命令行工具，请先安装并在终端登录。" };
      let directory: string | undefined;
      try {
        directory = await makeDirectory();
        const available = await probe(agent.id, command, directory);
        return { ...agent, installed: true, available, status: available ? "已检测到命令行工具；登录与模型权限在运行时确认。" : "此版本缺少受限运行参数，请更新命令行工具。", ...(available ? { models: ["default"] } : {}) };
      } catch { return { ...agent, installed: true, available: false, status: "无法确认受限运行支持，请检查或更新命令行工具。" }; }
      finally { if (directory) await removeDirectory(directory).catch(() => undefined); }
    }));
  }

  async function generateLocalCandidate(briefValue: Brief, connection: Connection, signal?: AbortSignal): Promise<Candidate> {
    const match = connection.baseUrl.match(/^local:\/\/(codex|claude|pi|hermes)$/);
    if (connection.protocol !== "local-agent" || !match || !/^writer-[123]$/.test(connection.id) || !/^[a-z0-9][a-z0-9._:/+-]{0,199}$/i.test(connection.model)) throw new LocalAgentError("本地 Agent 设置无效，请重新选择已支持的 Agent 和模型。");
    const id = match[1] as LocalAgentId;
    const agent = AGENTS.find(value => value.id === id)!;
    const started = Date.now();
    const base: Candidate = { id: connection.id, provider: agent.label, model: connection.model, prompt: "", changes: [], assumptions: [], status: "error", latencyMs: 0 };
    let directory: string | undefined;
    try {
      const brief = validateBrief(briefValue);
      if (signal?.aborted) throw new LocalAgentError("本地 Agent 任务已取消。");
      const command = await locate(id);
      if (!command) throw new LocalAgentError("未检测到所选本地 Agent，请先安装并在终端登录。");
      directory = await makeDirectory();
      if (!await probe(id, command, directory, signal)) throw new LocalAgentError("此版本缺少受限运行参数，请更新命令行工具。");
      const plan = await invocation(id, command);
      const args = id === "codex" ? codexArguments(connection.model, directory) : id === "claude" ? claudeArguments(connection.model) : id === "pi" ? piArguments(connection.model) : hermesArguments(connection.model);
      // Codex and pi expose JSONL progress. Claude's JSON result and the Hermes
      // helper are silent until complete, so their SDK/network timeouts and the
      // total deadline apply instead of mistaking silence for stalled output.
      const result = await run(plan.command, [...plan.argsPrefix, ...args], directory, buildGenerationPrompt(brief), timeoutMs, outputLimit, signal, id === "codex" || id === "pi" ? idleTimeoutMs : undefined);
      const parsed = parseGenerationText(finalText(id, result));
      if (connection.apiKey && JSON.stringify(parsed).includes(connection.apiKey)) throw new LocalAgentError("本地 Agent 返回了异常内容，已隐藏此次结果。");
      return { ...base, ...parsed, status: "success", latencyMs: Date.now() - started };
    } catch (error) {
      return { ...base, error: error instanceof LocalAgentError || error instanceof PiAdapterError ? error.message : "本地 Agent 未返回有效提示词，请检查登录状态与模型选择后重试。", latencyMs: Date.now() - started };
    } finally { if (directory) await removeDirectory(directory).catch(() => undefined); }
  }
  return { listLocalAgents, generateLocalCandidate };
}

const defaultRunner = createLocalAgentRunner();
export const listLocalAgents = defaultRunner.listLocalAgents;
export const generateLocalCandidate = defaultRunner.generateLocalCandidate;
