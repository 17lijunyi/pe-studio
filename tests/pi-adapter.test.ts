import test from "node:test";
import assert from "node:assert/strict";
import { piArguments, piFinalText, piProbeArguments, supportsRestrictedPiRun } from "../desktop/pi-adapter";

const restrictions = ["--no-session", "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline"];
const text = JSON.stringify({ prompt: "把输入整理为目标清楚的提示词。", changes: [], assumptions: [] });
const secret = "sk-unit-pi-not-a-real-key";
const assistant = (stopReason = "stop", content: unknown[] = [{ type: "text", text }]) => ({ role: "assistant", content, stopReason });
const stream = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n");
const successful = (message: unknown = assistant()) => stream({ type: "session", version: 3 }, { type: "agent_start" }, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "not-authoritative" } }, { type: "message_end", message }, { type: "agent_end", messages: [message] });

test("pi arguments restrict resources, override all context sources and keep task input out of argv", () => {
  for (const args of [piArguments("default"), piArguments("openai-codex/gpt-5.4:high"), piProbeArguments()]) {
    for (const flag of restrictions) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("--append-system-prompt") + 1], "");
    assert.ok(args[args.indexOf("--system-prompt") + 1].includes("Do not use tools"));
    assert.equal(args.some(arg => arg.includes(secret) || arg.includes(text)), false);
    assert.equal(args.includes("--approve"), false);
  }
  assert.deepEqual(piArguments("default").slice(0, 3), ["--print", "--mode", "json"]);
  assert.equal(piArguments("default").includes("--model"), false);
  const custom = piArguments("openai-codex/gpt-5.4:high");
  assert.equal(custom[custom.indexOf("--model") + 1], "openai-codex/gpt-5.4:high");
  assert.equal(custom.some(value => value.startsWith("--model=")), false);
  assert.equal(piProbeArguments().at(-1), "--help");
  assert.equal(piProbeArguments().includes("--print"), false);
  for (const invalid of ["", "--tools", "model\n--approve", "@private-file", "default;touch", "$(whoami)"]) assert.throws(() => piArguments(invalid), /模型设置无效/);
});

test("pi compatibility requires every documented restriction and output flag", () => {
  const flags = ["--print", "--mode", "--system-prompt", "--append-system-prompt", "--model", ...restrictions];
  const help = flags.join(" \n");
  assert.equal(supportsRestrictedPiRun(help), true);
  for (const flag of flags) assert.equal(supportsRestrictedPiRun(flags.map(value => value === flag ? value + "-unsupported" : value).join(" \n")), false, flag);
  assert.equal(supportsRestrictedPiRun("old pi cli"), false);
});

test("pi JSON parser only adopts authoritative completed assistant text", () => {
  assert.equal(piFinalText(successful()), text);
  const message = assistant("stop", [{ type: "thinking", thinking: secret }, { type: "text", text: "part 1" }, { type: "text", text: " part 2" }]);
  assert.equal(piFinalText(successful(message)), "part 1 part 2");
  assert.equal(piFinalText(successful().replaceAll("\n", "\r\n") + "\r\n"), text);
  const retrySuccess = stream({ type: "agent_start" }, { type: "message_end", message: assistant("error") }, { type: "agent_end", willRetry: true, messages: [assistant("error")] }, { type: "message_end", message: assistant() }, { type: "agent_end", messages: [assistant()] });
  assert.equal(piFinalText(retrySuccess), text);
});

test("pi JSON parser rejects incomplete, failed, truncated and inconsistent responses without leaking raw data", () => {
  const bad = [
    secret, "{}", "[]", "null", "", successful(assistant("error")), successful(assistant("aborted")), successful(assistant("length")), successful(assistant("pending")),
    successful(assistant("stop", [])), successful(assistant("stop", [{ type: "text", text: 7 }])), successful(assistant("stop", [{ type: "text", text: " " }])),
    stream({ type: "message_end", message: assistant() }), stream({ type: "agent_end", messages: [assistant()] }),
    stream({ type: "message_end", message: assistant() }, { type: "agent_end", messages: [] }),
    stream({ type: "message_end", message: assistant() }, { type: "agent_end", messages: [assistant("stop", [{ type: "text", text: "different" }])] }),
    stream({ type: "message_end", message: assistant() }, { type: "agent_end", willRetry: true, messages: [assistant()] }),
    successful() + "\n" + stream({ type: "agent_start" }), stream({ type: "error", message: secret }),
  ];
  for (const output of bad) assert.throws(() => piFinalText(output), error => error instanceof Error && !error.message.includes(secret) && /pi /.test(error.message));
});

test("pi rejects any tool execution, tool call or tool result even with a later completed response", () => {
  const tools = [
    { type: "tool_execution_start", args: secret }, { type: "tool_execution_update", partialResult: secret }, { type: "tool_execution_end", result: secret },
    { type: "message_end", message: assistant("toolUse", [{ type: "toolCall", name: "bash", arguments: secret }]) },
    { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: secret }] } },
    { type: "message_end", message: { role: "bashExecution", command: secret } },
    { type: "agent_end", messages: [assistant("stop", [{ type: "toolCall", name: "read" }])] },
  ];
  for (const event of tools) assert.throws(() => piFinalText(stream(event) + "\n" + successful()), error => error instanceof Error && /受限运行未生效/.test(error.message) && !error.message.includes(secret));
});
