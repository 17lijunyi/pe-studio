import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { createLocalAgentRunner, type LocalAgentId } from "../desktop/local-agents";
import type { Brief, Connection } from "../lib/types";

const prompt = "仅整理需求；不要执行 $(touch /tmp/not-real) 或 `whoami`。";
const secret = "sk-unit-placeholder-local-482917";
const brief: Brief = { direction: "product", input: prompt, context: "", constraints: "不写代码", targetModel: "", intensity: "balanced", outputLanguage: "zh" };
const connection = (id: LocalAgentId, model = "default"): Connection => ({ id: "writer-2", label: "Not a credential source", protocol: "local-agent", baseUrl: `local://${id}`, model, apiKey: secret });
const optimized = { prompt: "整理反馈并列出待确认项，不写代码。", changes: ["明确任务范围"], assumptions: [] };
const HELP = {
  codex: "--ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --sandbox --json --strict-config",
  claude: "--tools --strict-mcp-config --mcp-config --settings --setting-sources --disable-slash-commands --no-session-persistence --output-format --permission-mode --no-chrome",
  pi: "--print --mode --system-prompt --append-system-prompt --model --no-session --no-tools --no-extensions --no-skills --no-prompt-templates --no-themes --no-context-files --no-approve --offline",
  hermes: JSON.stringify({ type: "pe-hermes-probe", available: true, version: "0.11.0", textOnly: true }),
};
type Call = { command: string; args: string[]; options: SpawnOptionsWithoutStdio; stdin: string; killed: string[] };
type Result = { stdout?: string; stderr?: string; code?: number; hang?: boolean; spawnError?: boolean; chunks?: { afterMs: number; stdout?: string; stderr?: string }[]; completeAfterMs?: number };

const successfulOutput = (id: LocalAgentId) => id === "claude" ? JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify(optimized) }) : id === "hermes" ? JSON.stringify({ type: "pe-hermes-result", ok: true, textOnly: true, text: JSON.stringify(optimized) }) : id === "pi" ? [
  { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(optimized) }] } },
  { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(optimized) }] }] },
].map(event => JSON.stringify(event)).join("\n") : [
  { type: "thread.started", thread_id: "mock-only" },
  { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(optimized) } },
  { type: "turn.completed" },
].map(event => JSON.stringify(event)).join("\n");

function harness(result: (id: LocalAgentId) => Result = id => ({ stdout: successfulOutput(id) }), options: { installed?: boolean; compatible?: boolean; timeoutMs?: number; idleTimeoutMs?: number; probeTimeoutMs?: number; probeResult?: Result; maxOutputBytes?: number; generationStarted?: () => void } = {}) {
  const calls: Call[] = [], removed: string[] = [], groupKills: { pid: number; signal: string }[] = [];
  let directories = 0, located = 0;
  const runner = createLocalAgentRunner({
    findExecutable: async id => { located++; return options.installed === false ? undefined : `/mock/bin/${id}`; },
    hermesInvocation: async () => ({ command: "/mock/bin/python3", argsPrefix: ["-I", "-B", "/mock/helper.py"] }),
    makeDirectory: async () => `/mock/isolated-${++directories}`,
    removeDirectory: async directory => { removed.push(directory); },
    environment: { NODE_ENV: "production", HOME: "/mock/home", PATH: "/mock/bin:/usr/bin:.", CODEX_HOME: "/mock/codex-login", CLAUDE_CONFIG_DIR: "/mock/claude-login", PI_CODING_AGENT_DIR: "/mock/pi-login", HERMES_HOME: "/mock/hermes-login", OPENAI_API_KEY: secret, ANTHROPIC_AUTH_TOKEN: secret, DEEPSEEK_API_KEY: secret, NODE_OPTIONS: secret, HTTP_PROXY: "http://127.0.0.1:8999" },
    timeoutMs: options.timeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    probeTimeoutMs: options.probeTimeoutMs ?? 100,
    maxOutputBytes: options.maxOutputBytes,
    killProcessGroup: (pid, signal) => { groupKills.push({ pid, signal }); },
    spawn: (command, args, spawnOptions) => {
      const call: Call = { command, args, options: spawnOptions, stdin: "", killed: [] }; calls.push(call);
      const child = new EventEmitter() as EventEmitter & { pid: number; stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: (signal: string) => boolean };
      child.pid = 9_000 + calls.length;
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const timers: ReturnType<typeof setTimeout>[] = [];
      child.once("close", () => timers.forEach(clearTimeout));
      child.kill = signal => { call.killed.push(signal); timers.forEach(clearTimeout); queueMicrotask(() => child.emit("close", null)); return true; };
      child.stdin.on("data", value => { call.stdin += String(value); });
      child.stdin.on("finish", () => queueMicrotask(() => {
        const id = (command.endsWith("/python3") ? "hermes" : command.split("/").at(-1)) as LocalAgentId;
        const isProbe = args.includes("--help") || args.includes("--probe");
        if (!isProbe) options.generationStarted?.();
        const response = isProbe ? options.probeResult ?? { stdout: options.compatible === false ? "old unsupported cli" : HELP[id] } : result(id);
        if (response.spawnError) { child.emit("error", new Error(secret + prompt)); return; }
        const write = (chunk: { stderr?: string; stdout?: string }) => {
          if (chunk.stderr) child.stderr.write(chunk.stderr);
          if (chunk.stdout) child.stdout.write(chunk.stdout);
        };
        write(response);
        for (const chunk of response.chunks ?? []) timers.push(setTimeout(() => write(chunk), chunk.afterMs));
        if (response.hang) return;
        if (response.completeAfterMs === undefined) child.emit("close", response.code ?? 0);
        else timers.push(setTimeout(() => child.emit("close", response.code ?? 0), response.completeAfterMs));
      }));
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  });
  return { runner, calls, removed, groupKills, get directories() { return directories; }, get located() { return located; } };
}

test("read-only discovery reports installation separately from login and never invokes generation", async () => {
  const mock = harness();
  const agents = await mock.runner.listLocalAgents();
  assert.deepEqual(agents.map(agent => agent.id), ["codex", "claude", "pi", "hermes"]);
  assert.ok(agents.every(agent => agent.installed && agent.available && agent.status.includes("登录与模型权限在运行时确认")));
  assert.equal(mock.calls.length, 4);
  assert.ok(mock.calls.every(call => (call.args.includes("--help") || call.args.includes("--probe")) && call.stdin === ""));
  assert.equal(mock.removed.length, 4);
  assert.doesNotMatch(JSON.stringify(agents), /\/mock\/|sk-unit|已登录/);
  const missing = harness(undefined, { installed: false });
  assert.ok((await missing.runner.listLocalAgents()).every(agent => !agent.installed && !agent.available));
  assert.equal(missing.calls.length, 0);
  const incompatible = harness(undefined, { compatible: false });
  assert.ok((await incompatible.runner.listLocalAgents()).every(agent => agent.installed && !agent.available));
  assert.equal(incompatible.calls.length, 4);
});

test("Codex execution uses stdin, isolated cwd, preserved login location and no inherited provider keys", async () => {
  const mock = harness();
  const result = await mock.runner.generateLocalCandidate(brief, connection("codex", "Custom/Exact-Model"));
  assert.equal(result.status, "success");
  assert.equal(result.prompt, optimized.prompt);
  assert.equal(result.id, "writer-2");
  assert.equal(result.provider, "Codex CLI");
  assert.equal(result.model, "Custom/Exact-Model");
  assert.equal(mock.calls.length, 2);
  const generation = mock.calls[1];
  assert.equal(generation.options.shell, false);
  assert.equal(generation.options.detached, true);
  assert.equal(generation.options.cwd, "/mock/isolated-1");
  assert.ok(generation.stdin.includes(prompt));
  assert.equal(generation.args.some(arg => arg.includes(prompt) || arg.includes(secret)), false);
  assert.ok(generation.args.includes("--model=Custom/Exact-Model"));
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--strict-config", "--json"]) assert.ok(generation.args.includes(flag));
  assert.equal(generation.args[generation.args.indexOf("--sandbox") + 1], "read-only");
  for (const setting of ["features.shell_tool=false", "features.hooks=false", "features.skip_host_skill_discovery=true", "skills.bundled.enabled=false", "skills.include_instructions=false", "orchestrator.mcp.enabled=false", "mcp_servers={}", 'web_search="disabled"']) assert.ok(generation.args.includes(setting));
  assert.equal(generation.options.env?.HOME, "/mock/home");
  assert.equal(generation.options.env?.CODEX_HOME, "/mock/codex-login");
  assert.equal(Object.values(generation.options.env || {}).some(value => value === secret), false);
  assert.equal(generation.options.env?.NODE_OPTIONS, undefined);
  assert.equal(generation.options.env?.HTTP_PROXY, "http://127.0.0.1:8999");
  assert.deepEqual(mock.removed, ["/mock/isolated-1"]);
});

test("Claude execution disables tools/hooks/MCP/skills while retaining its existing OAuth path", async () => {
  const mock = harness();
  const result = await mock.runner.generateLocalCandidate(brief, connection("claude"));
  assert.equal(result.status, "success");
  assert.equal(result.provider, "Claude Code");
  assert.equal(result.model, "default");
  const generation = mock.calls[1];
  assert.equal(generation.options.shell, false);
  assert.equal(generation.args[generation.args.indexOf("--tools") + 1], "");
  assert.equal(generation.args[generation.args.indexOf("--setting-sources") + 1], "");
  assert.ok(generation.args.includes('{"mcpServers":{}}'));
  assert.ok(generation.args.includes('{"disableAllHooks":true}'));
  assert.equal(generation.args[generation.args.indexOf("--permission-mode") + 1], "dontAsk");
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--no-chrome"]) assert.ok(generation.args.includes(flag));
  assert.equal(generation.args.includes("--bare"), false);
  assert.equal(generation.args.includes("--dangerously-skip-permissions"), false);
  assert.equal(generation.args.some(arg => arg.startsWith("--model")), false);
  assert.equal(generation.options.env?.CLAUDE_CONFIG_DIR, "/mock/claude-login");
  assert.ok(generation.stdin.includes(prompt));
  assert.equal(Object.values(generation.options.env || {}).some(value => value === secret), false);
  assert.deepEqual(mock.removed, ["/mock/isolated-1"]);
});

test("untrusted executable IDs, URLs and model options are rejected before spawning", async () => {
  for (const patch of [
    { baseUrl: "local://sh" }, { baseUrl: "local://codex/extra" }, { baseUrl: "local://codex?flag=1" },
    { model: "--dangerously-bypass-approvals-and-sandbox" }, { model: "model\n--tools=Bash" },
    { protocol: "aihubmix" as const }, { id: "writer-9" },
  ]) {
    const mock = harness();
    await assert.rejects(mock.runner.generateLocalCandidate(brief, { ...connection("codex"), ...patch }), /本地 Agent 设置无效/);
    assert.equal(mock.calls.length, 0);
    assert.equal(mock.located, 0);
  }
});

test("pi and Hermes keep candidate identity and use isolated text generation without borrowed keys", async () => {
  for (const id of ["pi", "hermes"] as const) {
    const mock = harness();
    const result = await mock.runner.generateLocalCandidate(brief, connection(id));
    assert.equal(result.status, "success");
    assert.equal(result.id, "writer-2");
    assert.equal(result.provider, id === "pi" ? "pi" : "Hermes");
    assert.equal(result.prompt, optimized.prompt);
    const [probe, generation] = mock.calls;
    assert.equal(probe.stdin, "");
    assert.ok(generation.stdin.includes(prompt));
    assert.ok(generation.args.every(arg => !arg.includes(prompt) && !arg.includes(secret)));
    assert.equal(generation.options.shell, false);
    assert.equal(generation.options.detached, true);
    assert.equal(generation.options.cwd, "/mock/isolated-1");
    assert.equal(Object.values(generation.options.env || {}).includes(secret), false);
    const entries = generation.options.env!.PATH!.split(":");
    assert.ok(entries.includes("/usr/local/bin") && entries.includes("/opt/homebrew/bin"));
    assert.equal(entries.includes("."), false);
    if (id === "pi") {
      for (const flag of ["--no-tools", "--no-extensions", "--no-context-files", "--offline", "--no-session"]) {
        assert.ok(probe.args.includes(flag) && generation.args.includes(flag));
      }
      assert.equal(generation.options.env?.PI_CODING_AGENT_DIR, "/mock/pi-login");
    } else {
      assert.equal(probe.command, "/mock/bin/python3");
      assert.ok(probe.args.includes("--probe"));
      assert.deepEqual(generation.args, ["-I", "-B", "/mock/helper.py", "--model", "default"]);
      assert.equal(generation.options.env?.HERMES_HOME, "/mock/hermes-login");
    }
    assert.deepEqual(mock.removed, ["/mock/isolated-1"]);
  }
});

test("pi and Hermes cancellation terminates the process group and keeps no partial result", async () => {
  for (const id of ["pi", "hermes"] as const) {
    const abort = new AbortController();
    const mock = harness(() => ({ hang: true }), { generationStarted: () => queueMicrotask(() => abort.abort()) });
    const result = await mock.runner.generateLocalCandidate(brief, connection(id), abort.signal);
    assert.equal(result.status, "error");
    assert.equal(result.prompt, "");
    assert.match(result.error!, /取消/);
    assert.equal(mock.groupKills.at(-1)?.signal, "SIGKILL");
    assert.deepEqual(mock.removed, ["/mock/isolated-1"]);
  }
});

test("missing/incompatible tools never receive a prompt or claim successful generation", async () => {
  for (const options of [{ installed: false }, { compatible: false }]) {
    const mock = harness(undefined, options);
    const result = await mock.runner.generateLocalCandidate(brief, connection("claude"));
    assert.equal(result.status, "error");
    assert.equal(result.prompt, "");
    assert.ok(mock.calls.every(call => call.stdin === "" && call.args.includes("--help")));
    assert.equal(mock.removed.length, mock.directories);
  }
});

test("cancellation before start performs no detection or process launch", async () => {
  const mock = harness();
  const abort = new AbortController(); abort.abort();
  const result = await mock.runner.generateLocalCandidate(brief, connection("codex"), abort.signal);
  assert.equal(result.status, "error");
  assert.match(result.error || "", /已取消/);
  assert.equal(mock.calls.length, 0);
  assert.equal(mock.located, 0);
  assert.equal(mock.directories, 0);
});

test("in-flight cancellation kills the process and cleans its temporary directory", async () => {
  const abort = new AbortController();
  const mock = harness(() => ({ hang: true }), { generationStarted: () => abort.abort() });
  const result = await mock.runner.generateLocalCandidate(brief, connection("codex"), abort.signal);
  assert.equal(result.status, "error");
  assert.match(result.error || "", /已取消/);
  assert.ok(mock.calls[1].killed.includes("SIGKILL"));
  assert.deepEqual(mock.groupKills, [{ pid: 9_002, signal: "SIGKILL" }]);
  assert.deepEqual(mock.removed, ["/mock/isolated-1"]);
});

test("timeouts and stdout/stderr output limits kill the process and expose no raw data", async () => {
  const hung = harness(() => ({ hang: true }), { timeoutMs: 2 });
  const timedOut = await hung.runner.generateLocalCandidate(brief, connection("claude"));
  assert.equal(timedOut.status, "error");
  assert.match(timedOut.error || "", /响应超时/);
  assert.ok(hung.calls[1].killed.includes("SIGKILL"));
  assert.deepEqual(hung.groupKills, [{ pid: 9_002, signal: "SIGKILL" }]);
  assert.equal(hung.removed.length, 1);
  for (const output of [{ stdout: secret.repeat(300) }, { stderr: secret.repeat(300) }]) {
    const mock = harness(() => output, { maxOutputBytes: 4_096 });
    const result = await mock.runner.generateLocalCandidate(brief, connection("claude"));
    assert.equal(result.status, "error");
    assert.match(result.error || "", /输出过长/);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.ok(mock.calls[1].killed.includes("SIGKILL"));
    assert.deepEqual(mock.groupKills, [{ pid: 9_002, signal: "SIGKILL" }]);
    assert.equal(mock.removed.length, 1);
  }
});

test("Codex and pi stdout progress refreshes the idle deadline until a complete result", async () => {
  for (const id of ["codex", "pi"] as const) {
    const mock = harness(() => ({
      chunks: [
        ...[10, 30, 50, 70].map(afterMs => ({ afterMs, stdout: JSON.stringify({ type: "progress" }) + "\n" })),
        { afterMs: 90, stdout: successfulOutput(id) },
      ],
      completeAfterMs: 95,
    }), { idleTimeoutMs: 40, timeoutMs: 250 });
    const result = await mock.runner.generateLocalCandidate(brief, connection(id));
    assert.equal(result.status, "success");
    assert.equal(result.prompt, optimized.prompt);
    assert.deepEqual(mock.groupKills, []);
    assert.deepEqual(mock.removed, ["/mock/isolated-1"]);
  }
});

test("a stalled stream hits its idle deadline and stderr cannot keep it alive", async () => {
  for (const chunks of [[], [10, 20, 30, 40, 50, 60].map(afterMs => ({ afterMs, stderr: secret }))]) {
    const mock = harness(() => ({ hang: true, chunks }), { idleTimeoutMs: 35, timeoutMs: 150 });
    const result = await mock.runner.generateLocalCandidate(brief, connection("pi"));
    assert.equal(result.status, "error");
    assert.equal(result.prompt, "");
    assert.match(result.error!, /长时间没有输出/);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.deepEqual(mock.groupKills, [{ pid: 9_002, signal: "SIGKILL" }]);
    assert.deepEqual(mock.removed, ["/mock/isolated-1"]);
  }
});

test("continuous stdout never extends the independent total generation deadline", async () => {
  const mock = harness(() => ({
    hang: true,
    chunks: [10, 25, 40, 55, 70, 85, 100, 115].map(afterMs => ({ afterMs, stdout: JSON.stringify({ type: "progress" }) + "\n" })),
  }), { idleTimeoutMs: 40, timeoutMs: 75 });
  const result = await mock.runner.generateLocalCandidate(brief, connection("pi"));
  assert.equal(result.status, "error");
  assert.equal(result.prompt, "");
  assert.match(result.error!, /超过总等待上限/);
  assert.deepEqual(mock.groupKills, [{ pid: 9_002, signal: "SIGKILL" }]);
  assert.deepEqual(mock.removed, ["/mock/isolated-1"]);
});

test("nonstreaming Claude and Hermes results are not subject to stdout idle deadlines", async () => {
  for (const id of ["claude", "hermes"] as const) {
    const mock = harness(() => ({ chunks: [{ afterMs: 70, stdout: successfulOutput(id) }], completeAfterMs: 75 }), { idleTimeoutMs: 15, timeoutMs: 150 });
    const result = await mock.runner.generateLocalCandidate(brief, connection(id));
    assert.equal(result.status, "success");
    assert.equal(result.prompt, optimized.prompt);
    assert.deepEqual(mock.groupKills, []);
    assert.deepEqual(mock.removed, ["/mock/isolated-1"]);
  }
});

test("probe progress cannot extend the separate strict discovery deadline", async () => {
  const mock = harness(undefined, {
    idleTimeoutMs: 100,
    timeoutMs: 200,
    probeTimeoutMs: 25,
    probeResult: { hang: true, chunks: [5, 15, 30, 40].map(afterMs => ({ afterMs, stdout: "partial help\n" })) },
  });
  const agents = await mock.runner.listLocalAgents();
  assert.ok(agents.every(agent => agent.installed && !agent.available));
  assert.equal(mock.calls.length, 4);
  assert.ok(mock.calls.every(call => call.stdin === "" && call.killed.includes("SIGKILL")));
  assert.equal(mock.groupKills.length, 4);
  assert.equal(mock.removed.length, 4);
});

test("CLI failures, malformed JSON and unexpected tool events never leak stdout/stderr or create prompts", async () => {
  for (const [id, response] of [
    ["claude", { stderr: secret + prompt, code: 1 }],
    ["claude", { stdout: secret + prompt }],
    ["claude", { stdout: JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: secret }) }],
    ["codex", { stdout: JSON.stringify({ type: "turn.failed", error: { message: secret + prompt } }) }],
    ["codex", { stdout: JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: secret } }) }],
    ["codex", { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(optimized) } }) }],
    ["codex", { spawnError: true }],
  ] as const) {
    const mock = harness(() => response);
    const result = await mock.runner.generateLocalCandidate(brief, connection(id));
    assert.equal(result.status, "error");
    assert.equal(result.prompt, "");
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal((result.error || "").includes(prompt), false);
    assert.equal(mock.removed.length, 1);
  }
});
