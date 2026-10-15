import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import React, { type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompactResultsProps } from "../components/studio/results";
import { blindFailure, blindLabel, orderedCandidateIds } from "../components/studio/blind-label";
import type { Connection, SessionRecord } from "../lib/types";

// Load the real components, discarding only CSS. SSR never mounts effects,
// Electron windows, credentials, storage, or model requests.
const compiled = buildSync({
  stdin: {
    contents: 'export { CompactResults, Results } from "./components/studio/results";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "blind-results-entry.ts",
  },
  bundle: true, platform: "node", format: "cjs", jsx: "automatic",
  external: ["react", "react-dom/server"], loader: { ".css": "empty" }, write: false,
});
const moduleOutput = { exports: {} };
runInNewContext(compiled.outputFiles[0].text, {
  module: moduleOutput, exports: moduleOutput.exports, require: createRequire(import.meta.url),
});
const components = moduleOutput.exports as {
  CompactResults: ComponentType<CompactResultsProps>;
  Results: ComponentType<{
    session: SessionRecord; connections: Connection[]; pending: string[];
    judging: boolean; running: boolean; onRetry: () => void; onRetryJudge: () => void;
    onSettings: () => void; onFavorite: () => void; onNotice: () => void;
  }>;
};

const models = ["gpt-6-astra", "claude-opus-5-5", "gemini-4-argon"];
const connections: Connection[] = models.map((model, i) => ({
  id: `writer-${i + 1}`, label: `Private provider ${i + 1}`, protocol: "aihubmix", model,
  baseUrl: "https://aihubmix.com/v1", apiKey: "",
}));
const session: SessionRecord = {
  id: "blind-result-fixture", createdAt: "2026-10-15T00:00:00.000Z", demo: false, favorite: false,
  brief: { direction: "general", input: "整理要求", context: "", constraints: "", targetModel: "", intensity: "balanced", outputLanguage: "zh" },
  candidates: connections.map((c, i) => ({
    id: c.id, provider: c.label, model: c.model, status: "success" as const,
    prompt: `完整提示词 ${i + 1}`, changes: [], assumptions: [], latencyMs: 10,
  })).reverse(),
  judge: {
    status: "complete", candidates: connections.map((c, i) => ({
      candidateId: c.id, score: 80 + i, dimensions: [], eligible: true, violations: [],
    })).reverse(),
    recommendedId: "writer-2", tiedIds: [], summary: "Private provider 2 is recommended",
    evaluatedAt: "2026-10-15T00:00:01.000Z",
  },
};
const noop = () => {};
function compact(overrides: Partial<CompactResultsProps> = {}) {
  return renderToStaticMarkup(React.createElement(components.CompactResults, {
    session, connections: [...connections].reverse(), generatingIds: [], busy: false, judging: false,
    openedCandidateIds: ["writer-2"], onOpenCandidate: noop, onRevealModels: noop, ...overrides,
  }));
}
function assertBlind(markup: string) {
  for (const identity of [...models, "GPT", "Claude", "Gemini", "Private provider", "model-logo", "aihubmix.com"]) {
    assert.equal(markup.includes(identity), false, `Blind markup exposed ${identity}`);
  }
}

test("legacy rounds keep A/B/C and scores together despite reversed arrival and score order", () => {
  assert.deepEqual(orderedCandidateIds(["writer-3", "writer-1", "writer-2", "writer-1"]), ["writer-1", "writer-2", "writer-3"]);
  assert.deepEqual(orderedCandidateIds(["demo-c", "demo-a", "demo-b"]), ["demo-a", "demo-b", "demo-c"]);
  assert.equal(blindLabel("writer-2", ["writer-3", "writer-1", "writer-2"]), "C");
  const html = compact();
  assert.match(html, /aria-label="A，80 分，展开完整提示词"/);
  assert.match(html, /aria-label="B，81 分，推荐，收起完整提示词"/);
  assert.match(html, /aria-label="C，82 分，展开完整提示词"/);
  assert.ok(html.indexOf("A，80") < html.indexOf("B，81") && html.indexOf("B，81") < html.indexOf("C，82"));
});

test("randomized round order controls labels, recommendation and scores independently of provider order", () => {
  const randomized = { ...session, candidateOrder: ["writer-3", "writer-1", "writer-2"] };
  const html = compact({ session: randomized });
  assertBlind(html);
  assert.match(html, /aria-label="A，82 分，展开完整提示词"/);
  assert.match(html, /aria-label="B，80 分，展开完整提示词"/);
  assert.match(html, /aria-label="C，81 分，推荐，收起完整提示词"/);
  assert.ok(html.indexOf("A，82") < html.indexOf("B，80") && html.indexOf("B，80") < html.indexOf("C，81"));

  const revealed = compact({ session: randomized, modelsRevealed: true });
  assert.match(revealed, /A · Gemini，82 分，展开完整提示词/);
  assert.match(revealed, /B · GPT，80 分，展开完整提示词/);
  assert.match(revealed, /C · Claude，81 分，推荐，收起完整提示词/);
});

test("a single retry retains the round assignment and completed scores", () => {
  const randomized = { ...session, candidateOrder: ["writer-3", "writer-1", "writer-2"] };
  const html = compact({ session: randomized, generatingIds: ["writer-1"], busy: true, modelsRevealed: true });
  assert.match(html, /A · Gemini，82 分，展开完整提示词/);
  assert.match(html, /B · GPT，生成中，展开完整提示词/);
  assert.match(html, /C · Claude，81 分，推荐，收起完整提示词/);
});

test("partial result sets do not compress either saved round letters or legacy letters", () => {
  const partial = { ...session, candidates: session.candidates.filter(candidate => candidate.id !== "writer-1") };
  const legacy = compact({ session: partial, connections: [] });
  assert.match(legacy, /B，81 分，推荐，收起完整提示词/);
  assert.match(legacy, /C，82 分，展开完整提示词/);
  const randomized = compact({ session: { ...partial, candidateOrder: ["writer-3", "writer-1", "writer-2"] }, connections: [] });
  assert.match(randomized, /A，82 分，展开完整提示词/);
  assert.match(randomized, /C，81 分，推荐，收起完整提示词/);
  assert.doesNotMatch(randomized, /aria-label="B，/);
});

test("full results use the same randomized labels and recommendation as the compact strip", () => {
  const randomized = { ...session, candidateOrder: ["writer-3", "writer-1", "writer-2"] };
  const html = renderToStaticMarkup(React.createElement(components.Results, {
    session: randomized, connections, pending: [], judging: false, running: false,
    onRetry: noop, onRetryJudge: noop, onSettings: noop, onFavorite: noop, onNotice: noop,
  }));
  assertBlind(html);
  assert.match(html, /本次推荐 C/);
  assert.ok(html.indexOf("完整提示词 3") < html.indexOf("完整提示词 1") && html.indexOf("完整提示词 1") < html.indexOf("完整提示词 2"));
});

test("blind defaults omit identity text, tooltips, logo and accessibility metadata, with one reveal action", () => {
  const html = compact();
  assertBlind(html);
  assert.equal((html.match(/aria-label="显示全部模型"/g) || []).length, 1);
  assert.doesNotMatch(html, /title=/);
  assert.equal((html.match(/aria-expanded="true"/g) || []).length, 1);
});

test("one reveal displays every original identity without moving scores or the opened slot", () => {
  const html = compact({ modelsRevealed: true });
  for (const model of models) assert.ok(html.includes(`title="${model}"`));
  assert.match(html, /A · GPT，80 分，展开完整提示词/);
  assert.match(html, /B · Claude，81 分，推荐，收起完整提示词/);
  assert.match(html, /C · Gemini，82 分，展开完整提示词/);
  assert.equal((html.match(/class="model-logo [^"]+" aria-hidden="true"/g) || []).length, 3);
  assert.equal(html.includes('aria-label="显示全部模型"'), false);
  assertBlind(compact({ session: { ...session, id: "next-round" } }));
});

test("pending identity uses the supplied run snapshot while a completed slot keeps its returned model", () => {
  const snapshot = connections.map(c => c.id === "writer-1" ? { ...c, model: "claude-snapshot-only" } : { ...c, model: "gpt-new-setting" });
  const html = compact({ modelsRevealed: true, connections: snapshot, generatingIds: ["writer-1"], busy: true });
  assert.match(html, /A · Claude，生成中/);
  assert.ok(html.includes('title="claude-snapshot-only"'));
  assert.match(html, /B · Claude，81 分，推荐/);
  assert.ok(html.includes('title="claude-opus-5-5"'));
  assert.equal(html.includes("gpt-new-setting"), false);
});

test("blind failure preserves HTTP status without upstream names, URL, or credential-looking data", () => {
  const marker = "mock-diagnostic-credential-never-real";
  const diagnostic = `Claude HTTP 403 from https://private-provider.example/model Authorization: Bearer ${marker}`;
  assert.equal(blindFailure(diagnostic), "请求未完成（HTTP 403）。显示模型后可查看连接详情。");
  const failed: SessionRecord = { ...session, judge: null, candidates: session.candidates.map(c => c.id === "writer-2" ? { ...c, status: "error", error: diagnostic } : c) };
  const html = renderToStaticMarkup(React.createElement(components.Results, {
    session: failed, connections, pending: [], judging: false, running: false,
    onRetry: noop, onRetryJudge: noop, onSettings: noop, onFavorite: noop, onNotice: noop,
  }));
  assertBlind(html);
  assert.ok(html.includes("HTTP 403"));
  assert.equal(html.includes(marker), false);
  assert.equal(html.includes("private-provider.example"), false);
  assert.equal(html.includes("Authorization"), false);
});
