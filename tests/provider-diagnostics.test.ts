import test from "node:test";
import assert from "node:assert/strict";
import { generateCandidate } from "../lib/providers";
import { AIHUBMIX_BASE_URL } from "../lib/aihubmix";
import type { Brief, Connection } from "../lib/types";

// Every transport is injected. These tests neither read environment keys nor contact a service.
const secret = "sk-test-diagnostic-secret-never-display-987654";
const brief: Brief = { direction: "general", input: "req_private_prompt_938475", context: "", constraints: "", targetModel: "", intensity: "balanced", outputLanguage: "zh" };
const connection: Connection = { id: "writer-1", label: "Test gateway", protocol: "aihubmix", model: "GpT-CaseSensitive-Test", baseUrl: AIHUBMIX_BASE_URL, apiKey: secret };
const mockFetch = (handler: (url: string, init: RequestInit) => Response): typeof fetch =>
  ((url: string | URL | Request, init?: RequestInit) => Promise.resolve(handler(String(url), init || {}))) as typeof fetch;
const run = (response: () => Response, override: Partial<Connection> = {}) => generateCandidate(brief, { ...connection, ...override }, { env: {}, fetchImpl: mockFetch(response) });

test("401 and 403 retain distinct HTTP evidence and allowlisted service diagnostics without claiming a root cause", async () => {
  for (const status of [401, 403]) {
    const result = await run(() => Response.json({ error: { code: "invalid_api_key", type: "authentication_error", message: `private details ${secret}` } }, { status, headers: { "x-request-id": "req_gateway_12345678", "x-secret": secret } }));
    assert.equal(result.status, "error");
    assert.equal(result.prompt, "");
    assert.match(result.error || "", new RegExp(`HTTP ${status}`));
    assert.match(result.error || "", /具体原因尚未确认/);
    assert.match(result.error || "", /服务商代码: invalid_api_key/);
    assert.match(result.error || "", /类型: authentication_error/);
    assert.match(result.error || "", /请求编号: req_gateway_12345678/);
    assert.doesNotMatch(result.error || "", /API Key 无效|当前地区不可用|private details/);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("only known code/type values and bounded request-id fields are retained", async () => {
  const result = await run(() => Response.json({
    error: { code: "PERMISSION_DENIED", type: "unrecognized_sensitive_type", request_id: "req_body_12345678", message: brief.input, other: secret },
  }, { status: 403, headers: { "request-id": "not a safe request id", "authorization": `Bearer ${secret}` } }));
  assert.match(result.error || "", /服务商代码: permission_denied/);
  assert.match(result.error || "", /请求编号: req_body_12345678/);
  assert.doesNotMatch(result.error || "", /unrecognized|not a safe|类型:/);
  assert.equal((result.error || "").includes(brief.input), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("request identifiers cannot echo a key, its common encoding or submitted prompt", async () => {
  const encodings = [secret, encodeURIComponent(secret), btoa(secret), btoa(secret).replace(/=+$/, "")];
  for (const requestId of [...encodings, `req_${secret}`, brief.input, "a".repeat(97), "<script>alert(1)</script>"]) {
    const result = await run(() => Response.json({ error: { code: secret, type: secret, request_id: requestId, message: secret } }, { status: 401, headers: { "x-request-id": requestId } }));
    assert.match(result.error || "", /HTTP 401/);
    assert.doesNotMatch(result.error || "", /请求编号:|服务商代码:|类型:/);
    for (const value of [...encodings, brief.input]) assert.equal((result.error || "").includes(value), false);
  }
  // A credential that happens to match a known diagnostic code is still private.
  const codeKey = await run(() => Response.json({ error: { code: "INVALID_API_KEY" } }, { status: 401 }), { apiKey: "invalid_api_key" });
  assert.doesNotMatch(codeKey.error || "", /invalid_api_key|服务商代码:/);
});

test("oversized, HTML and malformed error bodies retain the HTTP status without leaking response text", async () => {
  let canceled = false;
  const huge = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: "invalid_api_key", message: secret.repeat(250) } }))); },
    cancel() { canceled = true; },
  });
  const oversized = await run(() => new Response(huge, { status: 403, headers: { "content-type": "application/json", "x-request-id": "req_header_76543210" } }));
  assert.equal(canceled, true);
  assert.match(oversized.error || "", /HTTP 403/);
  assert.match(oversized.error || "", /请求编号: req_header_76543210/);
  assert.doesNotMatch(oversized.error || "", /服务商代码:/);
  for (const [body, contentType] of [[`<html>${secret}</html>`, "text/html"], [`{broken ${secret}`, "application/json"]]) {
    const result = await run(() => new Response(body, { status: 503, headers: { "content-type": contentType } }));
    assert.match(result.error || "", /HTTP 503/);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("an unsupported token parameter is reported without silently changing the model, protocol or retrying", async () => {
  let calls = 0;
  const result = await generateCandidate(brief, connection, { env: {}, fetchImpl: mockFetch((url, init) => {
    calls++;
    const body = JSON.parse(String(init.body));
    assert.equal(url, `${AIHUBMIX_BASE_URL}/chat/completions`);
    assert.equal(body.model, connection.model);
    assert.equal(body.max_completion_tokens, 16_000);
    assert.equal("max_tokens" in body, false);
    return Response.json({ error: { code: "unsupported_parameter", type: "invalid_request_error", param: "max_completion_tokens", message: `untrusted ${secret}` } }, { status: 400 });
  }) });
  assert.equal(calls, 1);
  assert.equal(result.model, connection.model);
  assert.equal(result.status, "error");
  assert.match(result.error || "", /HTTP 400/);
  assert.match(result.error || "", /服务商代码: unsupported_parameter/);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("documented AiHubMix 403 quota errors retain tid and use a fixed explanation", async () => {
  const result = await run(() => Response.json({
    error: {
      code: "insufficient_user_quota",
      message: `Your account balance is insufficient. Please recharge your account to continue using the API. ${secret}`,
    },
    tid: "trace_quota_12345678",
  }, { status: 403 }));
  assert.equal(result.status, "error");
  assert.match(result.error || "", /AiHubMix 返回账户额度不足/);
  assert.match(result.error || "", /HTTP 403/);
  assert.match(result.error || "", /服务商代码: insufficient_user_quota/);
  assert.match(result.error || "", /追踪编号: trace_quota_12345678/);
  assert.doesNotMatch(result.error || "", /Your account|987654|sk-test/);
});

test("trace IDs are accepted only from the explicit bounded header and body fields", async () => {
  const fixtures: { payload: unknown; headers: Record<string, string>; expected: string }[] = [
    { payload: { error: { message: "unknown", tid: "trace_nested_12345678" } }, headers: {}, expected: "trace_nested_12345678" },
    { payload: { error: { message: "unknown", traceId: "trace_camel_12345678" } }, headers: {}, expected: "trace_camel_12345678" },
    { payload: { error: { message: "unknown" }, traceId: "trace_outer_12345678" }, headers: {}, expected: "trace_outer_12345678" },
    { payload: { message: "unknown", trace_id: "trace_snake_12345678" }, headers: {}, expected: "trace_snake_12345678" },
    { payload: { error: { tid: "trace_body_12345678" } }, headers: { tid: "trace_header_12345678" }, expected: "trace_header_12345678" },
    { payload: {}, headers: { TraceId: "trace_camelheader_12345678" }, expected: "trace_camelheader_12345678" },
    { payload: {}, headers: { "x-trace-id": "trace_xheader_12345678" }, expected: "trace_xheader_12345678" },
  ];
  for (const fixture of fixtures) {
    const result = await run(() => Response.json(fixture.payload, { status: 403, headers: fixture.headers }));
    assert.match(result.error || "", new RegExp(`追踪编号: ${fixture.expected}`));
    assert.match(result.error || "", /具体原因尚未确认/);
  }
  const both = await run(() => Response.json({ error: { tid: "trace_body_12345678" } }, {
    status: 403, headers: { "x-request-id": "req_original_12345678" },
  }));
  assert.match(both.error || "", /请求编号: req_original_12345678/);
  assert.match(both.error || "", /追踪编号: trace_body_12345678/);
});

test("AiHubMix documented message-only 403 errors classify without exposing key suffixes", async () => {
  const fixtures = [
    ["Your account balance is insufficient. Please recharge your account to continue using the API.", /账户额度不足/],
    ["Account suspended.", /账户已停用/],
    ["Forbidden – insufficient permissions.", /访问权限不足/],
    ["Forbidden – key(987654) allowed only from approved IP ranges.", /IP 不在该 Key 的允许范围内/],
    ["Forbidden - key(987654) not authorized to access the requested model.", /Key 无权访问当前模型/],
    ["Forbidden — channel has been disabled.", /服务通道已停用/],
  ] as const;
  for (const [message, expected] of fixtures) {
    let calls = 0;
    const result = await generateCandidate(brief, { ...connection, id: "writer-2", model: "claude-opus-5-5" }, { env: {}, fetchImpl: mockFetch((_url, init) => {
      calls++;
      const body = JSON.parse(String(init.body));
      assert.equal(body.model, "claude-opus-5-5");
      assert.equal(body.max_tokens, 16_000);
      assert.equal("max_completion_tokens" in body, false);
      return Response.json({ error: { message }, tid: "trace_access_12345678" }, { status: 403 });
    }) });
    assert.equal(calls, 1);
    assert.equal(result.model, "claude-opus-5-5");
    assert.match(result.error || "", expected);
    assert.match(result.error || "", /追踪编号: trace_access_12345678/);
    assert.equal((result.error || "").includes(message), false);
    assert.doesNotMatch(result.error || "", /987654|sk-test/);
  }
});

test("unknown, embellished and non-AiHubMix 403 messages do not establish a cause", async () => {
  const messages = [
    "model permission failed, probably no balance",
    "Forbidden – channel has been disabled. " + secret,
    "prefix: Forbidden – insufficient permissions.",
    "Forbidden – key(not-a-six-character-suffix) not authorized to access the requested model.",
    "Key error；987654",
    "Account suspended.\n" + brief.input,
    "x".repeat(513),
  ];
  for (const message of messages) {
    const result = await run(() => Response.json({ error: { message } }, { status: 403 }));
    assert.match(result.error || "", /具体原因尚未确认/);
    assert.equal((result.error || "").includes(message), false);
    assert.doesNotMatch(result.error || "", /987654|req_private|sk-test/);
  }
  const custom = await run(() => Response.json({ error: { message: "Account suspended." } }, { status: 403 }), { baseUrl: "https://proxy.example.com/v1" });
  assert.match(custom.error || "", /具体原因尚未确认/);
  assert.doesNotMatch(custom.error || "", /账户已停用/);
  const not403 = await run(() => Response.json({ error: { code: "insufficient_user_quota", message: "Account suspended." } }, { status: 503 }));
  assert.doesNotMatch(not403.error || "", /账户已停用|账户额度不足/);
});

test("trace IDs cannot echo credentials, a key suffix, prompt, markup or out-of-bound values", async () => {
  const unsafeValues = [
    secret, `trace_${secret}`, btoa(secret), `trace_${secret.slice(-6)}`, brief.input,
    "short", "t".repeat(97), "trace has spaces", "<script>private</script>",
  ];
  for (const value of unsafeValues) {
    const result = await run(() => Response.json({
      tid: value, traceId: value, trace_id: value,
      error: { tid: value, traceId: value, trace_id: value, message: secret },
    }, { status: 403, headers: { tid: value, TraceId: value, "x-trace-id": value } }));
    assert.match(result.error || "", /HTTP 403/);
    assert.doesNotMatch(result.error || "", /追踪编号:|987654|sk-test|req_private|<script>/);
  }
  const unknownField = await run(() => Response.json({ error: { correlationId: "private_unapproved_12345678" } }, {
    status: 403, headers: { "x-private-trace": "private_unapproved_12345678" },
  }));
  assert.doesNotMatch(unknownField.error || "", /private_unapproved|追踪编号:/);
});

test("HTML, plain, malformed and oversized bodies never become 403 explanations or leak content", async () => {
  for (const [body, contentType] of [
    [`<html>Account suspended. ${secret}</html>`, "text/html"],
    [`Account suspended. ${secret}`, "text/plain"],
    [`{\"error\":{\"message\":\"Account suspended.\",\"private\":\"${secret}\"`, "application/json"],
    [JSON.stringify({ error: { message: "Account suspended.", private: secret.repeat(250) } }), "application/json"],
  ]) {
    const result = await run(() => new Response(body, { status: 403, headers: { "content-type": contentType, tid: "trace_fallback_12345678" } }));
    assert.match(result.error || "", /HTTP 403/);
    assert.match(result.error || "", /具体原因尚未确认/);
    assert.match(result.error || "", /追踪编号: trace_fallback_12345678/);
    assert.doesNotMatch(result.error || "", /账户已停用|Account suspended|987654|sk-test|<html>/);
  }
});
