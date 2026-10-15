import test from "node:test";
import assert from "node:assert/strict";
import { POST as modelsPost } from "../app/api/models/route";
import { POST as generatePost } from "../app/api/generate/route";
import { CLOUD_PROVIDERS, DEEPSEEK_BASE_URL, MODEL_CATALOG_MAX_ENTRIES, providerForConnection, type ModelCatalogConnection } from "../lib/provider-catalog";
import { configuredProviders, generateCandidate, listProviderModels } from "../lib/providers";
import { validateConnection, validateModelCatalogConnection } from "../lib/request-validation";
import { DEFAULT_CONNECTIONS, type Brief, type Connection } from "../lib/types";

const secret = "sk-catalog-mock-credential-never-real-572918";
const serverKey = "sk-catalog-server-env-never-real-392847";
const brief: Brief = { direction: "general", input: "整理咖啡店介绍，不编造价格", context: "", constraints: "", targetModel: "", intensity: "balanced", outputLanguage: "zh" };
const connection: Connection = { id: "writer-2", label: "DeepSeek", protocol: "deepseek", model: "Custom/DeepSeek-Exact-ID", baseUrl: DEEPSEEK_BASE_URL, apiKey: secret };
const catalog = (patch: Partial<ModelCatalogConnection> = {}): ModelCatalogConnection => ({ protocol: "deepseek", baseUrl: DEEPSEEK_BASE_URL, apiKey: secret, ...patch });
const output = { prompt: "介绍咖啡店，价格未知则不写。", changes: ["保留事实约束"], assumptions: [] };
const mockFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch =>
  ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init || {}))) as typeof fetch;
const completion = () => Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output), reasoning_content: "DO_NOT_PROMOTE_REASONING" } }] });
const modelResponse = () => Response.json({ object: "list", data: [{ id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", owned_by: "deepseek", context_window: 1_048_576, api_capabilities: { arbitrary: true } }] });
const request = (value: unknown) => new Request("https://pe.example/api/models", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
const apiPayload = (response: Response) => response.json() as Promise<{ ok: boolean; error: string; models: { id: string }[] }>;

test("new defaults keep three stable independent slots and legacy validation does not migrate or overwrite them", () => {
  assert.deepEqual(DEFAULT_CONNECTIONS.map(item => item.id), ["writer-1", "writer-2", "writer-3"]);
  assert.ok(DEFAULT_CONNECTIONS.every(item => item.protocol === "aihubmix" && item.baseUrl === "https://aihubmix.com/v1" && item.apiKey === ""));
  const legacy: Connection = { ...connection, protocol: "openai-compatible", model: "MyExact-ID", label: "My existing slot", baseUrl: "https://proxy.example.com/v1" };
  assert.deepEqual(validateConnection(legacy), legacy);
  assert.equal(providerForConnection(legacy), undefined);
  assert.equal(providerForConnection({ ...legacy, baseUrl: DEEPSEEK_BASE_URL })?.id, "deepseek");
  assert.equal(providerForConnection({ ...legacy, baseUrl: "https://aihubmix.com/v1" })?.id, "aihubmix");
  assert.equal(legacy.apiKey, secret);
  assert.deepEqual(CLOUD_PROVIDERS.map(item => item.id), ["aihubmix", "deepseek"]);
});

test("DeepSeek generation uses the selected slot's exact model and explicit key on its public custom URL", async () => {
  let calls = 0;
  const result = await generateCandidate(brief, { ...connection, baseUrl: "https://custom.example.com/proxy/chat/completions/" }, { env: { AIHUBMIX_API_KEY: serverKey, DEEPSEEK_API_KEY: serverKey }, fetchImpl: mockFetch((url, init) => {
    calls++;
    assert.equal(url, "https://custom.example.com/proxy/chat/completions");
    assert.equal(init.method, "POST");
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${secret}`);
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, connection.model);
    assert.equal(body.messages[0].role, "user");
    assert.ok(body.messages[0].content.includes(brief.input));
    assert.equal(body.max_tokens, 16_000);
    assert.equal(body.stream, false);
    for (const field of ["max_completion_tokens", "temperature", "top_p", "reasoning_effort", "thinking"]) assert.equal(field in body, false);
    assert.equal(String(init.body).includes(secret), false);
    return completion();
  }) });
  assert.equal(calls, 1);
  assert.equal(result.status, "success");
  assert.equal(result.prompt, output.prompt);
  assert.equal(result.model, connection.model);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PROMOTE|sk-catalog/);
});

test("DeepSeek's environment key is separate and only goes to its exact official base", async () => {
  assert.equal(configuredProviders({}).deepseek, false);
  assert.equal(configuredProviders({ DEEPSEEK_API_KEY: " " }).deepseek, false);
  assert.equal(configuredProviders({ DEEPSEEK_API_KEY: serverKey }).deepseek, true);
  let calls = 0;
  const mocked = mockFetch((_url, init) => { calls++; assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${serverKey}`); return modelResponse(); });
  const official = await listProviderModels(catalog({ apiKey: "" }), { env: { DEEPSEEK_API_KEY: serverKey }, fetchImpl: mocked });
  assert.equal(official.ok, true);
  assert.equal(calls, 1);
  for (const baseUrl of ["https://custom.example.com", "https://api.deepseek.com.attacker.example", "https://api.deepseek.com:444", "https://api.deepseek.com/custom"]) {
    const denied = await listProviderModels(catalog({ apiKey: "", baseUrl }), { env: { DEEPSEEK_API_KEY: serverKey }, fetchImpl: mocked });
    assert.equal(denied.ok, false);
  }
  const noBorrow = await listProviderModels(catalog({ apiKey: "" }), { env: { AIHUBMIX_API_KEY: serverKey, OPENAI_API_KEY: serverKey }, fetchImpl: mocked });
  assert.equal(noBorrow.ok, false);
  assert.equal(calls, 1);
});

test("model discovery sends metadata GET only and exposes only safe directory fields", async () => {
  for (const [protocol, baseUrl, expectedUrl] of [["deepseek", DEEPSEEK_BASE_URL, `${DEEPSEEK_BASE_URL}/models`], ["aihubmix", "https://aihubmix.com", "https://aihubmix.com/v1/models"]] as const) {
    let calls = 0;
    const result = await listProviderModels(catalog({ protocol, baseUrl }), { env: {}, fetchImpl: mockFetch((url, init) => {
      calls++;
      assert.equal(url, expectedUrl);
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store");
      assert.ok(init.signal);
      assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${secret}`);
      return modelResponse();
    }) });
    assert.equal(calls, 1);
    if (!result.ok) throw new Error(result.error);
    assert.equal(result.provider, protocol);
    assert.deepEqual(result.models, [{ id: "deepseek-flash", displayName: "DeepSeek-V4.1-Flash", ownedBy: "deepseek" }]);
    assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
    assert.doesNotMatch(JSON.stringify(result), /context_window|capabilities|sk-catalog|Bearer/);
  }
});

test("directory parsing keeps exact case, deduplicates, and never returns secrets or unsafe labels", async () => {
  const result = await listProviderModels(catalog(), { env: {}, fetchImpl: mockFetch(() => Response.json({ data: [
    { id: "Vendor/Case-Exact-Model", display_name: "Exact model", owned_by: "vendor" },
    { id: "Vendor/Case-Exact-Model", display_name: "duplicate" },
    { id: "safe-model", name: `<script>${secret}</script>`, owned_by: secret },
    { id: secret }, { id: `id_${secret.slice(-6)}` }, { id: btoa(secret) },
    { id: "<script>alert</script>" }, { id: "line\nbreak" }, { id: "x".repeat(201) }, { id: "" }, null,
  ] })) });
  if (!result.ok) throw new Error(result.error);
  assert.deepEqual(result.models, [{ id: "Vendor/Case-Exact-Model", displayName: "Exact model", ownedBy: "vendor" }, { id: "safe-model" }]);
  assert.doesNotMatch(JSON.stringify(result), /572918|sk-catalog|script|duplicate/);
});

test("metadata validation preserves the public HTTPS boundary and rejects local agents before any fetch", async () => {
  let calls = 0;
  const never = mockFetch(() => { calls++; throw new Error("Must not reach transport"); });
  for (const baseUrl of ["http://api.deepseek.com", "https://127.0.0.1", "https://[::1]", "https://192.168.1.1", "https://localhost", "https://service.internal", "https://user:pass@api.deepseek.com", "https://api.deepseek.com?key=hidden", "local://claude"]) {
    assert.throws(() => validateModelCatalogConnection(catalog({ baseUrl })));
    const result = await listProviderModels(catalog({ baseUrl }), { env: {}, fetchImpl: never });
    assert.equal(result.ok, false);
  }
  const local = { ...connection, protocol: "local-agent" as const, baseUrl: "local://claude", model: "default", apiKey: "" };
  assert.throws(() => validateConnection(local), /本地 Agent.*macOS/);
  const generated = await generateCandidate(brief, local, { env: {}, fetchImpl: never });
  assert.equal(generated.status, "error");
  assert.match(generated.error || "", /本地 Agent.*macOS/);
  const listed = await listProviderModels(local, { env: {}, fetchImpl: never });
  assert.equal(listed.ok, false);
  assert.equal(calls, 0);
});

test("catalog failures retain safe HTTP and trace evidence without emitting upstream HTML or credentials", async () => {
  for (const [body, contentType] of [[`<html>${secret}</html>`, "text/html"], [`private ${secret}`, "text/plain"], [`{broken ${secret}`, "application/json"]]) {
    const result = await listProviderModels(catalog(), { env: {}, fetchImpl: mockFetch(() => new Response(body, { status: 403, headers: { "content-type": contentType, tid: "tid_catalog_forbidden_12345" } })) });
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Expected safe failure");
    assert.match(result.error, /HTTP 403/);
    assert.match(result.error, /tid_catalog_forbidden_12345/);
    assert.doesNotMatch(result.error, /sk-catalog|572918|html|private|broken/);
  }
  const result = await listProviderModels(catalog(), { env: {}, fetchImpl: mockFetch(() => Response.json({ error: { code: "invalid_api_key", message: secret, arbitrary: secret } }, { status: 401 })) });
  assert.equal(result.ok, false);
  if (!result.ok) { assert.match(result.error, /HTTP 401.*invalid_api_key/); assert.equal(result.error.includes(secret), false); }
});

test("catalog bounds, malformed success and redirects fail without a generation request", async () => {
  for (const payload of [{ data: "invalid" }, { data: Array.from({ length: MODEL_CATALOG_MAX_ENTRIES + 1 }, () => ({ id: "model" })) }, { data: [{ id: secret }] }]) {
    const result = await listProviderModels(catalog(), { env: {}, fetchImpl: mockFetch(() => Response.json(payload)) });
    assert.equal(result.ok, false);
  }
  const oversized = await listProviderModels(catalog(), { env: {}, fetchImpl: mockFetch(() => new Response(JSON.stringify({ data: [], padding: "x".repeat(1_048_576) }))) });
  assert.equal(oversized.ok, false);
  const malformed = await listProviderModels(catalog(), { env: {}, fetchImpl: mockFetch(() => new Response(`not JSON ${secret}`)) });
  assert.equal(malformed.ok, false);
  assert.equal(JSON.stringify(malformed).includes(secret), false);
  const redirect = await listProviderModels(catalog(), { env: {}, fetchImpl: mockFetch((_url, init) => { assert.equal(init.redirect, "error"); return new Response(null, { status: 302, headers: { location: "https://private.invalid" } }); }) });
  assert.equal(redirect.ok, false);
  assert.match(JSON.stringify(redirect), /HTTP 302/);
});

test("both DeepSeek generation and model GET honor the bounded timeout", async () => {
  const hung: typeof fetch = (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("mock aborted")), { once: true }));
  const generated = await generateCandidate(brief, connection, { env: {}, fetchImpl: hung, timeoutMs: 2 });
  assert.equal(generated.status, "error");
  assert.match(generated.error || "", /响应超过/);
  const listed = await listProviderModels(catalog(), { env: {}, fetchImpl: hung, timeoutMs: 2 });
  assert.equal(listed.ok, false);
  if (!listed.ok) assert.match(listed.error, /响应超过/);
});

test("DeepSeek never promotes reasoning-only, malformed or truncated generation into a successful prompt", async () => {
  for (const payload of [
    { choices: [{ message: { content: "", reasoning_content: JSON.stringify(output) } }] },
    { choices: [{ message: { content: "not JSON" } }] },
    { choices: [{ finish_reason: "length", message: { content: JSON.stringify(output) } }] },
  ]) {
    const result = await generateCandidate(brief, connection, { env: {}, fetchImpl: mockFetch(() => Response.json(payload)) });
    assert.equal(result.status, "error");
    assert.equal(result.prompt, "");
    assert.doesNotMatch(JSON.stringify(result), /DO_NOT_PROMOTE/);
  }
});

test("model API accepts a not-yet-selected model and rejects unsafe/local protocols without contacting them", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = mockFetch((url, init) => { calls++; assert.equal(url, `${DEEPSEEK_BASE_URL}/models`); assert.equal(init.method, "GET"); return modelResponse(); });
  try {
    const response = await modelsPost(request({ connection: catalog() }));
    assert.equal(response.status, 200);
    const payload = await apiPayload(response);
    assert.equal(payload.ok, true);
    assert.equal(payload.models[0].id, "deepseek-flash");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(JSON.stringify(payload).includes(secret), false);
    for (const input of [catalog({ baseUrl: "https://127.0.0.1" }), catalog({ protocol: "local-agent", baseUrl: "local://claude" }), catalog({ protocol: "anthropic" })]) {
      const denied = await modelsPost(request({ connection: input }));
      assert.equal(denied.status, 400);
      assert.equal((await apiPayload(denied)).ok, false);
    }
    const localGeneration = await generatePost(request({ brief, connection: { ...connection, protocol: "local-agent", baseUrl: "local://claude" } }));
    assert.equal(localGeneration.status, 400);
    assert.match((await apiPayload(localGeneration)).error, /本地 Agent.*macOS/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test("model API exposes a safe 502 on upstream failure and safe validation errors", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mockFetch(() => Response.json({ error: { code: "invalid_api_key", message: secret } }, { status: 401 }));
  try {
    const response = await modelsPost(request({ connection: catalog() }));
    assert.equal(response.status, 502);
    const payload = await apiPayload(response);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /HTTP 401/);
    assert.equal(JSON.stringify(payload).includes(secret), false);
    const wrongType = await modelsPost(new Request("https://pe.example/api/models", { method: "POST", body: "private text" }));
    assert.equal(wrongType.status, 415);
    assert.equal((await apiPayload(wrongType)).ok, false);
    const malformed = await modelsPost(new Request("https://pe.example/api/models", { method: "POST", headers: { "content-type": "application/json" }, body: `{${secret}` }));
    assert.equal(malformed.status, 400);
    assert.equal(JSON.stringify(await malformed.json()).includes(secret), false);
  } finally { globalThis.fetch = previousFetch; }
});
