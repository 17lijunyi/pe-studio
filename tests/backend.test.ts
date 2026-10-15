import test from "node:test";
import assert from "node:assert/strict";
import type { Brief, Candidate, Connection, Protocol } from "../lib/types";
import { buildJudgeRequest, JUDGE_DIMENSIONS, judgeCandidates, parseJudgeReport } from "../lib/judge";
import { configuredProviders, extractGenerationText, generateCandidate, OFFICIAL_BASES, parseGenerationText, postJson, resolveApiKey } from "../lib/providers";
import { MAX_REQUEST_BYTES, normalizeBaseUrl, readRequestJson, validateBrief, validateCandidates, validateConnection } from "../lib/request-validation";
import { POST as generateRoute } from "../app/api/generate/route";
import { POST as judgeRoute } from "../app/api/judge/route";

const brief: Brief = { direction: "general", input: "写一篇 300 字的咖啡店介绍", context: "面向附近的居民", constraints: "不要虚构价格", targetModel: "通用模型", intensity: "balanced", outputLanguage: "zh" };
const output = { prompt: "为附近居民写一篇约 300 字的咖啡店介绍。不虚构价格。", changes: ["明确受众"], assumptions: [] };
const suppliedKey = "user-key-not-for-output-0123456789";
const candidate = (id: string, status: Candidate["status"] = "success"): Candidate => ({ id, provider: "SECRET_WRITER_NAME", model: "SECRET_WRITER_MODEL", prompt: status === "success" ? output.prompt : "", changes: [], assumptions: [], status, latencyMs: 100 });
const connection = (protocol: Protocol): Connection => ({ id: "writer-1", label: "测试模型", protocol, model: "test-model", baseUrl: protocol === "anthropic" ? OFFICIAL_BASES.anthropic : protocol === "gemini" ? OFFICIAL_BASES.gemini : OFFICIAL_BASES.openai, apiKey: suppliedKey });
const judgeConnection = { model: "jev-1.13.0", baseUrl: OFFICIAL_BASES.jev, apiKey: suppliedKey };
const mockFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch => ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init ?? {}))) as typeof fetch;

function judgePayload(scores: number[], violations: Record<string, number> = {}) {
  const answers: Record<string, unknown> = {};
  scores.forEach((score, i) => {
    const probabilities: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0 };
    const low = Math.floor(score);
    const high = Math.ceil(score);
    probabilities[low] = high === low ? 1 : high - score;
    if (high !== low) probabilities[high] = score - low;
    for (const dimension of JUDGE_DIMENSIONS) answers[`c${i}_${dimension.id}`] = { type: "score", score, confidence: 0.8, probabilities: { ...probabilities } };
    answers[`c${i}_intent_violation`] = { type: "noul", noul: violations[`c${i}_intent`] ?? 0.01 };
    answers[`c${i}_constraint_violation`] = { type: "noul", noul: violations[`c${i}_constraint`] ?? 0.01 };
  });
  return { model: "jev-1.13.0", answers };
}

test("four generation protocols send the expected wire shape and parse JSON prompt output", async t => {
  const protocols: Protocol[] = ["openai-responses", "openai-compatible", "anthropic", "gemini"];
  for (const protocol of protocols) await t.test(protocol, async () => {
    let called = false;
    const fetchImpl = mockFetch((url, init) => {
      called = true;
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      assert.ok(!String(init.body).includes(suppliedKey));
      const text = JSON.stringify(output);
      if (protocol === "openai-responses") {
        assert.equal(url, "https://api.openai.com/v1/responses");
        assert.equal(headers.get("authorization"), `Bearer ${suppliedKey}`);
        assert.equal(body.store, false);
        assert.ok(body.input.includes(brief.input));
        return Response.json({ status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", content: [{ type: "output_text", text }] }] });
      }
      if (protocol === "openai-compatible") {
        assert.ok(url.endsWith("/chat/completions"));
        assert.ok(body.messages[0].content.includes(brief.input));
        return Response.json({ choices: [{ finish_reason: "stop", message: { content: text } }] });
      }
      if (protocol === "anthropic") {
        assert.ok(url.endsWith("/messages"));
        assert.equal(headers.get("x-api-key"), suppliedKey);
        assert.equal(headers.get("anthropic-version"), "2023-06-01");
        assert.ok(body.max_tokens > 0);
        return Response.json({ content: [{ type: "thinking", thinking: "not output" }, { type: "text", text }], stop_reason: "end_turn" });
      }
      assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent");
      assert.equal(headers.get("x-goog-api-key"), suppliedKey);
      assert.ok(!url.includes(suppliedKey));
      return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "private thought" }, { text }] } }] });
    });
    const result = await generateCandidate(brief, connection(protocol), { fetchImpl, env: {} });
    assert.equal(called, true);
    assert.equal(result.status, "success");
    assert.equal(result.prompt, output.prompt);
    assert.deepEqual(result.changes, output.changes);
    assert.ok(!JSON.stringify(result).includes(suppliedKey));
  });
});

test("generation handles fenced JSON but never promotes malformed, empty or truncated output", async () => {
  assert.deepEqual(parseGenerationText(`\`\`\`json\n${JSON.stringify(output)}\n\`\`\``), output);
  for (const value of ["", "ordinary prose", "{}", '{"prompt":"","changes":[],"assumptions":[]}', '{"prompt":"abc","changes":"bad","assumptions":[]}']) {
    assert.throws(() => parseGenerationText(value));
  }
  assert.throws(() => extractGenerationText("openai-responses", { status: "incomplete", output_text: JSON.stringify(output) }), /截断/);
  assert.throws(() => extractGenerationText("gemini", { candidates: [] }), /没有返回/);
  const result = await generateCandidate(brief, connection("openai-compatible"), { env: {}, fetchImpl: mockFetch(() => Response.json({ choices: [] })) });
  assert.equal(result.status, "error");
  assert.equal(result.prompt, "");
});

test("base URL validation rejects local/private/credential/query/redirect tricks", () => {
  for (const value of ["http://api.example.com/v1", "https://localhost/v1", "https://app.localhost/v1", "https://127.1/v1", "https://2130706433/v1", "https://0x7f000001/v1", "https://10.0.0.1/v1", "https://172.16.1.2/v1", "https://192.168.1.1/v1", "https://169.254.169.254/v1", "https://100.64.0.1/v1", "https://[::1]/v1", "https://[::ffff:127.0.0.1]/v1", "https://[fc00::1]/v1", "https://metadata.google.internal/v1", "https://user:password@api.example.com/v1", "https://api.example.com/v1?key=secret", "https://api.example.com/v1#fragment"]) {
    assert.throws(() => normalizeBaseUrl(value), value);
  }
  assert.equal(normalizeBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(normalizeBaseUrl("https://8.8.8.8/v1"), "https://8.8.8.8/v1");
});

test("server official key can never fall back to a custom endpoint", async () => {
  const env = { OPENAI_API_KEY: "server-secret-0987654321" };
  assert.equal(resolveApiKey("openai", `${OFFICIAL_BASES.openai}/`, "", env), env.OPENAI_API_KEY);
  for (const base of ["https://api.openai.com.attacker.example/v1", "https://api.example.com/v1", "https://api.openai.com/custom", "https://api.openai.com:444/v1"]) {
    assert.throws(() => resolveApiKey("openai", base, "", env), /自定义/);
  }
  let called = false;
  const result = await generateCandidate(brief, { ...connection("openai-compatible"), baseUrl: "https://proxy.example.com/v1", apiKey: "" }, { env, fetchImpl: mockFetch(() => { called = true; return Response.json({}); }) });
  assert.equal(called, false);
  assert.equal(result.status, "error");
  assert.ok(!JSON.stringify(result).includes(env.OPENAI_API_KEY));
  assert.deepEqual(configuredProviders({ ...env, ANTHROPIC_API_KEY: "", GEMINI_API_KEY: "g", TYPESAFE_API_KEY: "j" }), { openai: true, anthropic: false, gemini: true, jev: true, aihubmix: false, deepseek: false });
});

test("upstream failures, invalid JSON, redirect and timeout are friendly and never echo secrets", async () => {
  for (const status of [401, 403, 429, 500, 302]) {
    await assert.rejects(postJson("https://api.example.com/v1", {}, {}, { fetchImpl: mockFetch(() => new Response(`sensitive ${suppliedKey}`, { status })) }), error => error instanceof Error && !error.message.includes(suppliedKey));
  }
  await assert.rejects(postJson("https://api.example.com/v1", {}, {}, { fetchImpl: mockFetch(() => new Response("not JSON")) }), /JSON/);
  await assert.rejects(postJson("https://api.example.com/v1", {}, {}, { timeoutMs: 5, fetchImpl: mockFetch((_url, init) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error(`secret ${suppliedKey}`)), { once: true }))) }), /1 秒/);
});

test("judge request is anonymous and scopes each question to original request and candidate data", () => {
  const body = buildJudgeRequest(brief, [candidate("secret-id-one"), candidate("secret-id-two")], "jev-1.13.0");
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("SECRET_WRITER"));
  assert.ok(!serialized.includes("secret-id"));
  assert.equal(body.state.original_request.input, brief.input);
  assert.equal(body.state.candidates.length, 2);
  assert.equal(Object.keys(body.questions).length, 14);
  assert.ok(body.questions.c0_intent.instructions.includes("untrusted"));
  assert.ok(body.questions.c0_intent.instructions.includes("candidates[0].prompt"));
});

test("judge normalizes five dimensions and ranks actual validated answers", () => {
  const result = parseJudgeReport(judgePayload([3, 3.8, 2.5]), [candidate("a"), candidate("b"), candidate("c")], "jev-1.13.0");
  assert.equal(result.recommendedId, "b");
  assert.equal(result.candidates[1].score, 95);
  assert.equal(result.candidates[1].dimensions.length, 5);
  assert.match(result.summary, /模板/);
});

test("anonymous randomized order maps scores back to the correct candidate ids", async () => {
  const original = [{ ...candidate("a"), prompt: "prompt-a" }, { ...candidate("b"), prompt: "prompt-b" }];
  const result = await judgeCandidates(brief, original, judgeConnection, {
    random: () => 0,
    env: {},
    fetchImpl: mockFetch((_url, init) => {
      const request = JSON.parse(String(init.body));
      assert.equal(request.state.candidates[0].prompt, "prompt-b");
      assert.equal(request.state.candidates[1].prompt, "prompt-a");
      return Response.json(judgePayload([4, 3]));
    }),
  });
  assert.equal(result.recommendedId, "b");
  assert.deepEqual(result.candidates.map(item => item.candidateId), ["a", "b"]);
  assert.equal(result.candidates[0].score, 75);
  assert.equal(result.candidates[1].score, 100);
  assert.equal(original[0].id, "a");
});

test("hard requirement gates beat score, close scores tie, and low confidence has no winner", () => {
  const candidates = [candidate("a"), candidate("b")];
  const gated = parseJudgeReport(judgePayload([4, 3], { c0_constraint: 0.99 }), candidates, "jev");
  assert.equal(gated.recommendedId, "b");
  assert.equal(gated.candidates[0].eligible, false);
  const allGated = parseJudgeReport(judgePayload([4, 3], { c0_intent: 0.9, c1_constraint: 0.9 }), candidates, "jev");
  assert.equal(allGated.recommendedId, null);
  const tie = parseJudgeReport(judgePayload([3.8, 3.9]), candidates, "jev");
  assert.equal(tie.recommendedId, null);
  assert.deepEqual(tie.tiedIds, ["b", "a"]);
  const payload = judgePayload([4, 3]);
  (payload.answers.c0_clarity as Record<string, unknown>).confidence = 0.1;
  assert.equal(parseJudgeReport(payload, candidates, "jev").recommendedId, null);
});

test("missing, partial and invalid judge outputs never fabricate scores", async () => {
  const broken = judgePayload([4, 3]);
  delete broken.answers.c1_clarity;
  const incoherent = judgePayload([4, 3]);
  (incoherent.answers.c0_intent as Record<string, unknown>).score = 0;
  const invalidProbability = judgePayload([4, 3]);
  (invalidProbability.answers.c0_intent_violation as Record<string, unknown>).noul = 5;
  for (const payload of [{}, { answers: {} }, broken, incoherent, invalidProbability]) {
    const result = await judgeCandidates(brief, [candidate("a"), candidate("b")], judgeConnection, { env: {}, fetchImpl: mockFetch(() => Response.json(payload)) });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.candidates, []);
    assert.equal(result.recommendedId, null);
  }
});

test("empty or failed generation results are not scored; one success is evaluated without declaring a comparative winner", async () => {
  let calls = 0;
  const fetchImpl = mockFetch((_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init.body)).state.candidates.length, 1);
    return Response.json(judgePayload([3.8]));
  });
  const empty = await judgeCandidates(brief, [candidate("failed", "error")], judgeConnection, { fetchImpl, env: {} });
  assert.equal(empty.status, "unavailable");
  assert.equal(calls, 0);
  const partial = await judgeCandidates(brief, [candidate("a"), candidate("b", "error")], judgeConnection, { fetchImpl, env: {} });
  assert.equal(partial.status, "complete");
  assert.equal(partial.candidates.length, 1);
  assert.equal(partial.recommendedId, null);
  assert.equal(calls, 1);
});

test("request input validation enforces limits and rejects duplicate candidates", async () => {
  assert.throws(() => validateBrief({ ...brief, input: " ".repeat(10) }));
  assert.throws(() => validateBrief({ ...brief, context: "a".repeat(6_001) }));
  assert.throws(() => validateConnection({ ...connection("gemini"), apiKey: "a\nb" }));
  assert.throws(() => validateCandidates([candidate("same"), candidate("same")]));
  assert.throws(() => validateCandidates([candidate("a"), candidate("b"), candidate("c"), candidate("d")]));
  await assert.rejects(readRequestJson(new Request("https://app.example.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })), /JSON/);
  await assert.rejects(readRequestJson(new Request("https://app.example.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(MAX_REQUEST_BYTES + 1) })), /过长/);
});

test("API routes return safe 4xx validation errors and handle no successful candidates", async () => {
  const invalid = await generateRoute(new Request("https://app.example.com/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief, connection: { ...connection("gemini"), baseUrl: `https://localhost/?key=${suppliedKey}` } }) }));
  assert.equal(invalid.status, 400);
  assert.ok(!(await invalid.text()).includes(suppliedKey));
  const empty = await judgeRoute(new Request("https://app.example.com/api/judge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief, candidates: [], connection: judgeConnection }) }));
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("cache-control"), "no-store");
  assert.equal(((await empty.json()) as { status: string }).status, "unavailable");
});
