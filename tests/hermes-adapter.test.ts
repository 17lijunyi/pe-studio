import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { hermesArguments, hermesFinalText, hermesProbeArguments, resolveHermesInvocation, supportsRestrictedHermesRun } from "../desktop/hermes-adapter";

const execute = promisify(execFile);
const helper = resolve("desktop/assets/hermes-runner.py");

test("Hermes launcher resolution uses a fixed Python interpreter without executing wrappers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pe-hermes-unit-"));
  try {
    const python = join(directory, "python3"), command = join(directory, "hermes");
    await writeFile(python, "fixture only"); await chmod(python, 0o700);
    await writeFile(command, `#!${python}\nraise RuntimeError('must never execute')\n`);
    assert.deepEqual(await resolveHermesInvocation(command, helper), { command: python, argsPrefix: ["-I", "-B", helper] });
    await writeFile(command, "#!/usr/bin/env python3\n");
    assert.equal(await resolveHermesInvocation(command, helper), undefined);
    await writeFile(command, "#!/bin/sh\nexec whoami\n");
    assert.equal(await resolveHermesInvocation(command, helper), undefined);
    assert.equal(await resolveHermesInvocation("relative/hermes", helper), undefined);
    await writeFile(command, `#!${python}\n`); await chmod(python, 0o600);
    assert.equal(await resolveHermesInvocation(command, helper), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Hermes probe accepts only the verified text-only version family and generation has no prompt argument", () => {
  const valid = { type: "pe-hermes-probe", available: true, version: "0.11.0", textOnly: true };
  assert.equal(supportsRestrictedHermesRun(JSON.stringify(valid)), true);
  for (const patch of [{ available: false }, { version: "0.12.0" }, { textOnly: false }, { type: "result" }]) {
    assert.equal(supportsRestrictedHermesRun(JSON.stringify({ ...valid, ...patch })), false);
  }
  assert.equal(supportsRestrictedHermesRun("raw diagnostic"), false);
  assert.deepEqual(hermesProbeArguments(), ["--probe"]);
  assert.deepEqual(hermesArguments("custom/exact-model"), ["--model", "custom/exact-model"]);
});

test("Hermes result parsing rejects unclassified output and never exposes raw exception details", () => {
  assert.equal(hermesFinalText(JSON.stringify({ type: "pe-hermes-result", ok: true, textOnly: true, text: "优化后的提示词" })), "优化后的提示词");
  for (const value of ["not json", { type: "result" }, { type: "pe-hermes-result", ok: true, textOnly: false, text: "untrusted" }, { type: "pe-hermes-result", ok: true, textOnly: true, text: "" }]) {
    assert.throws(() => hermesFinalText(typeof value === "string" ? value : JSON.stringify(value)));
  }
  assert.throws(() => hermesFinalText(JSON.stringify({ type: "pe-hermes-result", ok: false, code: "sk-secret-diagnostic" })), error => error instanceof Error && !error.message.includes("sk-secret"));
});

// Run the real bridge against in-memory Python module fixtures. No installed
// Agent, user config/auth, subprocess commands, network, or model is invoked.
async function runFixture(body: string): Promise<unknown> {
  const directory = await mkdtemp(join(tmpdir(), "pe-hermes-python-unit-"));
  try {
    const script = `import importlib.util, json, os, sys, types
from pathlib import Path
spec = importlib.util.spec_from_file_location("pe_test_hermes", ${JSON.stringify(helper)})
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
def module(name, **members):
    value = types.ModuleType(name)
    value.__dict__.update(members)
    sys.modules[name] = value
    return value
module("hermes_cli", __path__=[])
module("agent", __path__=[])
config = {"model": {"default": "original-model", "provider": "custom"}}
config_module = module("hermes_cli.config", load_config=lambda: config, ensure_hermes_home=lambda: (_ for _ in ()).throw(AssertionError("bootstrap")))
sys.modules["hermes_cli"].config = config_module
module("hermes_constants", get_default_hermes_root=lambda: Path(os.environ["HOME"]), get_hermes_home=lambda: Path(os.environ["HOME"]))
module("dotenv", load_dotenv=lambda *a, **kw: None)
proxy_normalizations = []
module("utils", normalize_proxy_env_vars=lambda: proxy_normalizations.append(True))
runtime = {"provider": "custom", "api_mode": "chat_completions", "api_key": "sk-fixture-secret-9876", "base_url": "https://example.invalid/v1"}
module("hermes_cli.runtime_provider", resolve_requested_provider=lambda: "custom", resolve_runtime_provider=lambda **kw: runtime)
module("hermes_cli.auth", PROVIDER_REGISTRY={}, resolve_provider=lambda x: x)
calls = []
message = types.SimpleNamespace(content="optimized text", tool_calls=None, function_call=None)
choice = types.SimpleNamespace(message=message, finish_reason="stop")
class Client:
    def __init__(self, **kw):
        calls.append({"init": kw})
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))
    def create(self, **kw):
        calls.append({"request": kw})
        return types.SimpleNamespace(choices=[choice])
    def close(self): pass
module("openai", OpenAI=Client)
module("agent.auxiliary_client", CodexAuxiliaryClient=lambda c,m:c, _codex_cloudflare_headers=lambda k:{})
bridge.source_tree = lambda: "0.11.0"
${body}
`;
    const result = await execute("/usr/bin/python3", ["-I", "-B", "-c", script], {
      cwd: directory, env: { NODE_ENV: "test", HOME: directory, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" }, timeout: 5000, maxBuffer: 100_000,
    });
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("Hermes bridge sends one text request through native routing without tools or session context", async () => {
  const result = await runFixture(`result = bridge.generate("prompt with /command and AGENTS.md remains plain text", "default")
print(json.dumps({"result": result, "calls": calls, "proxyNormalizations": len(proxy_normalizations), "forbiddenLoaded": any(n in sys.modules for n in ["run_agent", "cli", "tools", "plugins", "model_tools"])}))`);
  assert.ok(result && typeof result === "object");
  const value = result as { result: { ok: boolean; text: string }; calls: { request?: { model: string; messages: unknown[]; tools?: unknown } }[]; proxyNormalizations: number; forbiddenLoaded: boolean };
  assert.equal(value.result.ok, true); assert.equal(value.result.text, "optimized text"); assert.equal(value.forbiddenLoaded, false);
  assert.equal(value.calls.length, 2);
  assert.equal(value.calls[1].request?.model, "original-model");
  assert.equal(value.calls[1].request?.tools, undefined);
  assert.equal(value.calls[1].request?.messages.length, 2);
  assert.equal(value.proxyNormalizations, 1);
});

test("Hermes normalizes native proxy settings before resolving credentials", async () => {
  const result = await runFixture(`def resolve_checked(**kw):
    assert proxy_normalizations == [True], "normalization must precede auth/network routing"
    return runtime
sys.modules["hermes_cli.runtime_provider"].resolve_runtime_provider = resolve_checked
bridge.generate("plain prompt", "default")
print(json.dumps({"normalizedBeforeRouting": True}))`);
  assert.deepEqual(result, { normalizedBeforeRouting: true });
});

test("Hermes safely distinguishes HTTP, timeout and network failures without raw diagnostics", async () => {
  const result = await runFixture(`class HTTPError(Exception):
    def __init__(self, status):
        super().__init__("sk-fixture-secret-9876 https://private.invalid/path?token=secret full response body")
        self.status_code = status
class APIConnectionError(Exception): pass
class APITimeoutError(APIConnectionError): pass
class ConnectError(Exception): pass
bridge._CURRENT_PHASE = "request"
wrapped = APIConnectionError("raw secret")
wrapped.__cause__ = TimeoutError("sk-fixture-secret-9876")
errors = [HTTPError(status) for status in [400, 401, 402, 403, 404, 408, 429, 503]]
errors += [APITimeoutError("secret"), wrapped, ConnectError("secret"), RuntimeError("secret")]
print(json.dumps([bridge.safe_error_result(error) for error in errors]))`);
  const rows = result as { type: string; ok: boolean; code: string; phase: string }[];
  assert.deepEqual(rows.map(row => row.code), ["invalid_request", "authentication", "billing", "permission", "not_found", "timeout", "rate_limit", "unavailable", "timeout", "timeout", "network", "runtime"]);
  assert.ok(rows.every(row => row.type === "pe-hermes-result" && row.ok === false && row.phase === "request"));
  const output = JSON.stringify(rows);
  for (const secret of ["sk-fixture", "private.invalid", "response body", "raw secret"]) assert.ok(!output.includes(secret));
});

test("Hermes main emits a safe stage and error code for unexpected SDK errors", async () => {
  const result = await runFixture(`import io, contextlib
bridge._CURRENT_PHASE = "routing"
def fail(*args):
    raise TimeoutError("sk-fixture-secret-9876 https://private.invalid token=secret")
bridge.generate = fail
sys.argv = ["helper", "--model", "default"]
sys.stdin = io.TextIOWrapper(io.BytesIO(b"plain prompt"))
captured = io.StringIO()
with contextlib.redirect_stdout(captured):
    bridge.main()
print(captured.getvalue().strip())`);
  assert.deepEqual(result, { type: "pe-hermes-result", ok: false, code: "timeout", phase: "routing" });
});

test("Hermes adapter maps safe failures and rejects unrecognized phase text", () => {
  for (const [code, expected] of [["timeout", "超时"], ["network", "网络"], ["authentication", "认证"], ["permission", "权限"], ["billing", "计费"], ["rate_limit", "限流"], ["invalid_request", "拒绝了请求"], ["not_found", "未找到"], ["unavailable", "不可用"], ["runtime", "运行未完成"]]) {
    assert.throws(() => hermesFinalText(JSON.stringify({ type: "pe-hermes-result", ok: false, code, phase: "request" })), error => error instanceof Error && error.message.includes(expected) && error.message.includes("阶段：模型请求"));
  }
  assert.throws(() => hermesFinalText(JSON.stringify({ type: "pe-hermes-result", ok: false, code: "secret-code", phase: "secret-phase" })), error => error instanceof Error && !error.message.includes("secret") && !error.message.includes("阶段"));
  assert.throws(() => hermesFinalText(JSON.stringify({ type: "pe-hermes-result", ok: false, code: "__proto__", phase: "toString" })), error => error instanceof Error && error.message.includes("运行未完成") && !error.message.includes("阶段"));
});

test("Hermes bridge rejects tool output, truncation and credential echoes", async () => {
  for (const setup of [
    "message.tool_calls = [dict(name='terminal')]",
    "choice.finish_reason = 'length'",
    "message.content = runtime['api_key']",
  ]) {
    const result = await runFixture(`${setup}
try:
    bridge.generate("plain prompt", "default")
    result = {"accepted": True}
except bridge.BridgeError as error:
    result = {"code": error.code}
print(json.dumps(result))`);
    assert.ok(result && typeof result === "object" && "code" in result);
    assert.ok(["restricted", "response"].includes(String(result.code)));
  }
});

test("Hermes bridge blocks importing Agent/tool modules and launching local commands", async () => {
  const result = await runFixture(`bridge.generate("plain prompt", "explicit-model")
blocked = []
for name in ["tools", "plugins", "run_agent", "cli", "model_tools", "hermes_cli.main"]:
    try:
        __import__(name)
    except bridge.BridgeError:
        blocked.append(name)
for event in ["subprocess.Popen", "os.system", "os.posix_spawn"]:
    try:
        bridge.block_local_commands(event, ())
    except bridge.BridgeError:
        blocked.append(event)
print(json.dumps({"blocked": blocked, "model": calls[1]["request"]["model"]}))`);
  assert.deepEqual(result, { blocked: ["tools", "plugins", "run_agent", "cli", "model_tools", "hermes_cli.main", "subprocess.Popen", "os.system", "os.posix_spawn"], model: "explicit-model" });
});

test("Hermes respects an explicit profile and a named route's default model", async () => {
  const result = await runFixture(`root = Path(os.environ["HOME"])
(root / "active_profile").write_text("other-profile")
os.environ["HERMES_HOME"] = str(root / "explicit-profile")
bridge.active_profile()
profile = os.environ["HERMES_HOME"]
config["model"].pop("default")
runtime["model"] = "named-route-default"
bridge.generate("plain prompt", "default")
print(json.dumps({"respected": profile.endswith("/explicit-profile"), "model": calls[1]["request"]["model"]}))`);
  assert.deepEqual(result, { respected: true, model: "named-route-default" });
});
