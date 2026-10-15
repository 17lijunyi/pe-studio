import test from "node:test";
import assert from "node:assert/strict";
import type { Brief, Connection } from "../lib/types";
import { AIHUBMIX_BACKUP_BASE_URL, AIHUBMIX_BASE_URL } from "../lib/aihubmix";
import { configuredProviders, extractGenerationText, generateCandidate, OFFICIAL_BASES } from "../lib/providers";
import { validateConnection } from "../lib/request-validation";

const brief: Brief = { direction: "general", input: "写一篇咖啡店介绍", context: "附近居民", constraints: "不要虚构价格", targetModel: "", intensity: "balanced", outputLanguage: "zh" };
const output = { prompt: "为附近居民介绍咖啡店，不虚构价格。", changes: ["明确受众与约束"], assumptions: [] };
const suppliedKey = "aihubmix-test-user-key-never-output";
const serverKey = "aihubmix-test-server-key-never-output";
const connection = (overrides: Partial<Connection> = {}): Connection => ({ id: "writer-1", label: "AiHubMix", protocol: "aihubmix", model: "gpt-6-astra", baseUrl: AIHUBMIX_BASE_URL, apiKey: suppliedKey, ...overrides });
const mockFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(input), init ?? {}))) as typeof fetch;
const response = () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(output), reasoning_content: "INTERNAL_THINKING_MUST_NOT_BE_A_PROMPT" } }] });

test("AiHubMix sends all three models to Chat Completions with Bearer and the right token budget", async t => {
  for (const model of ["gpt-6-astra", "claude-opus-5-5", "gemini-4-argon"]) await t.test(model, async () => {
    let calls = 0;
    const result = await generateCandidate(brief, connection({ model }), { env: {}, fetchImpl: mockFetch((url, init) => {
      calls++;
      const body = JSON.parse(String(init.body));
      const headers = new Headers(init.headers);
      assert.equal(url, `${AIHUBMIX_BASE_URL}/chat/completions`);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      assert.equal(headers.get("authorization"), `Bearer ${suppliedKey}`);
      assert.equal(headers.get("content-type"), "application/json");
      assert.equal(headers.has("x-api-key"), false);
      assert.equal(headers.has("x-goog-api-key"), false);
      assert.equal(body.model, model);
      assert.equal(body.stream, false);
      assert.equal(body.messages[0].role, "user");
      assert.ok(body.messages[0].content.includes(brief.input));
      assert.ok(body.messages[0].content.includes(brief.constraints));
      const tokenField = model.startsWith("gpt-") ? "max_completion_tokens" : "max_tokens";
      assert.equal(body[tokenField], 16_000);
      assert.equal(model.startsWith("gpt-") ? "max_tokens" in body : "max_completion_tokens" in body, false);
      for (const field of ["temperature", "top_p", "thinking", "reasoning"]) assert.equal(field in body, false);
      assert.equal(String(init.body).includes(suppliedKey), false);
      return response();
    }) });
    assert.equal(calls, 1);
    assert.equal(result.status, "success");
    assert.equal(result.prompt, output.prompt);
    assert.deepEqual(result.changes, output.changes);
    assert.equal(JSON.stringify(result).includes("INTERNAL_THINKING"), false);
    assert.equal(JSON.stringify(result).includes(suppliedKey), false);
  });
});

test("AiHubMix accepts a bare domain, SDK base and full endpoint without duplicated paths", async () => {
  for (const baseUrl of ["https://aihubmix.com", "https://aihubmix.com/", AIHUBMIX_BASE_URL, `${AIHUBMIX_BASE_URL}/`, `${AIHUBMIX_BASE_URL}/chat/completions`, `${AIHUBMIX_BASE_URL}/chat/completions/`]) {
    const validated = validateConnection(connection({ baseUrl, apiKey: "" }));
    assert.equal(validated.baseUrl, AIHUBMIX_BASE_URL);
    let calls = 0;
    const result = await generateCandidate(brief, validated, { env: { AIHUBMIX_API_KEY: serverKey }, fetchImpl: mockFetch((url, init) => {
      calls++;
      assert.equal(url, `${AIHUBMIX_BASE_URL}/chat/completions`);
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${serverKey}`);
      return response();
    }) });
    assert.equal(result.status, "success", baseUrl);
    assert.equal(calls, 1);
  }
});

test("AiHubMix preserves arbitrary exact model IDs instead of limiting or case-normalizing presets", async () => {
  // Synthetic IDs exercise exact forwarding, not availability in a provider's catalog.
  for (const [model, tokenField] of [["Custom-Vendor/CaseSensitive-2026", "max_tokens"], ["GpT-CaseSensitive-Test", "max_completion_tokens"], ["O3-CaseSensitive-Test", "max_completion_tokens"]]) {
    const validated = validateConnection(connection({ model }));
    assert.equal(validated.model, model);
    const result = await generateCandidate(brief, validated, { env: {}, fetchImpl: mockFetch((_url, init) => {
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, model);
      assert.equal(body[tokenField], 16_000);
      assert.equal(tokenField === "max_tokens" ? "max_completion_tokens" in body : "max_tokens" in body, false);
      return response();
    }) });
    assert.equal(result.status, "success");
    assert.equal(result.model, model);
  }
});

test("AiHubMix accepts final text blocks and rejects empty, refusal-only or truncated answers", async () => {
  assert.equal(extractGenerationText("aihubmix", { choices: [{ message: { content: [{ type: "text", text: JSON.stringify(output) }], reasoning_content: "ignore me" } }] }), JSON.stringify(output));
  for (const payload of [
    { choices: [] },
    { choices: [{ message: { content: "", reasoning_content: JSON.stringify(output) } }] },
    { choices: [{ finish_reason: "stop", message: { content: null, refusal: "Unable to assist" } }] },
    { choices: [{ finish_reason: "content_filter", message: { content: null } }] },
    { choices: [{ finish_reason: "length", message: { content: JSON.stringify(output) } }] },
    { choices: [{ message: { content: "not JSON" } }] },
  ]) {
    const result = await generateCandidate(brief, connection(), { env: {}, fetchImpl: mockFetch(() => Response.json(payload)) });
    assert.equal(result.status, "error");
    assert.equal(result.prompt, "");
    assert.ok(result.error);
  }
});

test("AiHubMix has its own configuration flag and never borrows official-vendor environment keys", async () => {
  assert.equal(configuredProviders({}).aihubmix, false);
  assert.equal(configuredProviders({ AIHUBMIX_API_KEY: " " }).aihubmix, false);
  assert.equal(configuredProviders({ AIHUBMIX_API_KEY: serverKey }).aihubmix, true);
  let calls = 0;
  const result = await generateCandidate(brief, connection({ apiKey: "" }), {
    env: { OPENAI_API_KEY: "official-openai-secret", ANTHROPIC_API_KEY: "official-anthropic-secret", GEMINI_API_KEY: "official-gemini-secret" },
    fetchImpl: mockFetch(() => { calls++; return response(); }),
  });
  assert.equal(calls, 0);
  assert.equal(result.status, "error");
  assert.match(result.error ?? "", /API Key/);
  assert.equal(JSON.stringify(result).includes("official-"), false);
});

test("AiHubMix environment key cannot reach backup, custom, lookalike or official-vendor endpoints", async () => {
  const forbiddenBases = [AIHUBMIX_BACKUP_BASE_URL, "https://proxy.example.com/v1", "https://aihubmix.com.attacker.example/v1", "https://aihubmix.com/custom", "https://aihubmix.com:444/v1", OFFICIAL_BASES.openai, OFFICIAL_BASES.anthropic, OFFICIAL_BASES.gemini];
  for (const baseUrl of forbiddenBases) {
    let calls = 0;
    const result = await generateCandidate(brief, connection({ baseUrl, apiKey: "" }), {
      env: { AIHUBMIX_API_KEY: serverKey, OPENAI_API_KEY: "official-openai-secret" },
      fetchImpl: mockFetch(() => { calls++; return response(); }),
    });
    assert.equal(calls, 0, baseUrl);
    assert.equal(result.status, "error", baseUrl);
    assert.equal(JSON.stringify(result).includes(serverKey), false);
  }
  for (const protocol of ["openai-responses", "openai-compatible", "anthropic", "gemini"] as const) {
    const baseUrl = protocol === "anthropic" ? OFFICIAL_BASES.anthropic : protocol === "gemini" ? OFFICIAL_BASES.gemini : OFFICIAL_BASES.openai;
    let calls = 0;
    const result = await generateCandidate(brief, connection({ protocol, baseUrl, apiKey: "" }), {
      env: { AIHUBMIX_API_KEY: serverKey }, fetchImpl: mockFetch(() => { calls++; return response(); }),
    });
    assert.equal(calls, 0);
    assert.equal(result.status, "error");
  }
});

test("AiHubMix backup/custom endpoints use only the explicitly supplied key", async () => {
  for (const baseUrl of [AIHUBMIX_BACKUP_BASE_URL, "https://proxy.example.com/v1"]) {
    let calls = 0;
    const result = await generateCandidate(brief, connection({ baseUrl }), {
      env: { AIHUBMIX_API_KEY: serverKey, OPENAI_API_KEY: "official-openai-secret" },
      fetchImpl: mockFetch((url, init) => {
        calls++;
        assert.equal(url, `${baseUrl}/chat/completions`);
        assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${suppliedKey}`);
        return response();
      }),
    });
    assert.equal(calls, 1);
    assert.equal(result.status, "success");
  }
});

test("AiHubMix upstream errors and echoed credentials never leak into candidates", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const result = await generateCandidate(brief, connection(), { env: {}, fetchImpl: mockFetch(() => new Response(`echoed ${suppliedKey}`, { status })) });
    assert.equal(result.status, "error");
    assert.equal(JSON.stringify(result).includes(suppliedKey), false);
  }
  const echoed = await generateCandidate(brief, connection(), { env: {}, fetchImpl: mockFetch(() => Response.json({ choices: [{ message: { content: JSON.stringify({ ...output, prompt: suppliedKey }) } }] })) });
  assert.equal(echoed.status, "error");
  assert.equal(echoed.prompt, "");
  assert.equal(JSON.stringify(echoed).includes(suppliedKey), false);
});
