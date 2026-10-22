import { BrowserWindow, clipboard, dialog, screen } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { APP_ORIGIN } from "./server";
import { nativeGlassStatus } from "./native-glass";
import type { PublicStudioState } from "./workspace-contract";

const SMOKE_KEY = "desktop-smoke-memory-only-placeholder";
const NEXT_SMOKE_KEY = "desktop-smoke-next-run-memory-only-placeholder";
const PROVIDER_DRAFT_KEYS = ["desktop-smoke-provider-a-placeholder", "desktop-smoke-provider-deepseek-placeholder", "desktop-smoke-provider-b-placeholder"];
const AIHUBMIX_MODELS = ["gpt-6-astra", "claude-opus-5-5", "gemini-4-argon"];
const PROVIDERS = ["openai", "anthropic", "gemini"] as const;
const FORBIDDEN_REQUEST_ID = "req_smoke_gpt_forbidden_01";
const CLAUDE_FORBIDDEN_TRACE_ID = "tid_smoke_claude_forbidden_01";
const pause = (ms = 60) => new Promise<void>(resolve => setTimeout(resolve, ms));

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function until(label: string, check: () => Promise<boolean> | boolean, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause();
  }
  throw new Error("Timed out: " + label);
}

// Each callback is serialized without its closure. Only explicit, mock data is
// passed into Chromium; this helper is not exposed by the production bridge.
function evaluate<T, A = undefined>(target: BrowserWindow, task: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
  return target.webContents.executeJavaScript(`(${task.toString()})(${JSON.stringify(arg)})`, true);
}

function mockModelTransport(aihubmix: boolean) {
  const previousFetch = globalThis.fetch;
  const envNames = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "TYPESAFE_API_KEY", "JEV_API_KEY", "AIHUBMIX_API_KEY", "DEEPSEEK_API_KEY"];
  const previousEnv = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  for (const name of aihubmix ? ["AIHUBMIX_API_KEY", "TYPESAFE_API_KEY"] : ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "TYPESAFE_API_KEY"]) process.env[name] = SMOKE_KEY;
  const writersGate = gate();
  const judgeGate = gate();
  const failNext = new Set<typeof PROVIDERS[number]>();
  let closed = false;
  const calls: Record<string, number> = { openai: 0, anthropic: 0, gemini: 0, jev: 0 };
  const modelCatalogRequests: { provider: string; method: string; authenticated: boolean }[] = [];
  let nextCatalogGate: ReturnType<typeof gate> | undefined;
  const writerRequests: { endpoint: string; model: string; bearerAuthenticated: boolean }[] = [];
  const judgeRequests: { model: string; originalKeyUsed: boolean }[] = [];
  const prompts = Object.fromEntries(PROVIDERS.map(name => [name,
    "SMOKE_" + name.toUpperCase() + "：为咖啡店写一篇约 300 字介绍，面向周边居民，不虚构价格。\n" +
    Array.from({ length: 18 }, (_, i) => "第 " + (i + 1) + " 项：保留原始需求中的事实，未知信息标为待确认。").join("\n") +
    "\nEND_OF_COMPLETE_" + name.toUpperCase(),
  ])) as Record<typeof PROVIDERS[number], string>;
  globalThis.fetch = async (input, init) => {
    if (closed) throw new Error("Smoke transport is closed");
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (["https://aihubmix.com/v1/models", "https://api.deepseek.com/models", "https://api.deepseek.com/v1/models"].includes(url)) {
      const method = init?.method || "GET";
      const bearer = new Headers(init?.headers).get("authorization");
      const authenticated = [SMOKE_KEY, ...PROVIDER_DRAFT_KEYS].some(key => bearer === "Bearer " + key);
      if (method !== "GET" || !authenticated || init?.body) throw new Error("Model catalog must use authenticated read-only GET");
      const provider = url.includes("deepseek") ? "deepseek" : "aihubmix";
      modelCatalogRequests.push({ provider, method, authenticated });
      const delayedCatalog = nextCatalogGate;
      nextCatalogGate = undefined;
      if (delayedCatalog) await delayedCatalog.promise;
      if (closed) throw new Error("Smoke transport is closed");
      return Response.json({ data: provider === "aihubmix" ? AIHUBMIX_MODELS.map(id => ({ id, object: "model", owned_by: "aihubmix" })) : [{ id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" }, { id: "deepseek-flash", object: "model", owned_by: "deepseek" }] });
    }
    if (url === "https://api.typesafe.ai/v1/systemone") {
      calls.jev++;
      judgeRequests.push({ model: body.model, originalKeyUsed: new Headers(init?.headers).get("authorization") === "Bearer " + SMOKE_KEY });
      await judgeGate.promise;
      if (closed) throw new Error("Smoke transport is closed");
      const answers: Record<string, unknown> = {};
      for (const [id, raw] of Object.entries(body.questions as Record<string, { type: string }>)) {
        const index = Number(id.match(/^c(\d+)_/)?.[1]);
        const prompt = String(body.state.candidates[index].prompt);
        // The Anthropic prompt remains scored and usable while ineligible for
        // an automatic recommendation, irrespective of its shuffled letter.
        if (raw.type === "noul") answers[id] = { type: "noul", noul: prompt.includes("ANTHROPIC") ? 0.8 : 0.01 };
        else {
          // GPT wins after the reader has explicitly selected Claude.
          const score = prompt.includes("OPENAI") ? 3.9 : prompt.includes("ANTHROPIC") ? 3.5 : 3;
          const probabilities = { "0": 0, "1": 0, "2": 0, "3": 4 - score, "4": score - 3 };
          answers[id] = { type: "score", score, confidence: 0.8, probabilities };
        }
      }
      return Response.json({ model: "jev-1.13.0", answers });
    }
    let name: typeof PROVIDERS[number] | null;
    if (aihubmix) {
      if (url !== "https://aihubmix.com/v1/chat/completions") throw new Error("Unexpected AiHubMix destination");
      const modelIndex = AIHUBMIX_MODELS.indexOf(body.model);
      const authenticated = new Headers(init?.headers).get("authorization") === "Bearer " + SMOKE_KEY;
      if (modelIndex < 0 || !authenticated || init?.method !== "POST" || body.stream !== false || !Array.isArray(body.messages)) throw new Error("Invalid AiHubMix request");
      if (new Headers(init?.headers).has("x-api-key") || new Headers(init?.headers).has("x-goog-api-key")) throw new Error("Unexpected vendor auth header");
      name = PROVIDERS[modelIndex];
      writerRequests.push({ endpoint: url, model: body.model, bearerAuthenticated: authenticated });
    } else {
      name = url === "https://api.openai.com/v1/responses" ? "openai" : url === "https://api.anthropic.com/v1/messages" ? "anthropic" : url.startsWith("https://generativelanguage.googleapis.com/v1beta/models/") ? "gemini" : null;
    }
    // No fallback to the real fetch: a missed mock must never cause a paid call.
    if (!name) throw new Error("Unexpected network destination in isolated smoke");
    calls[name]++;
    const failThisRequest = failNext.delete(name);
    await writersGate.promise;
    if (closed) throw new Error("Smoke transport is closed");
    if (failThisRequest) {
      if (aihubmix && name === "anthropic") return Response.json({
        error: { type: "permission_error", message: `Forbidden – key(${SMOKE_KEY.slice(-6)}) not authorized to access the requested model.` },
        tid: CLAUDE_FORBIDDEN_TRACE_ID,
      }, { status: 403 });
      return Response.json({ error: { type: "permission_error", code: "permission_denied" } }, { status: 403, headers: { "x-request-id": FORBIDDEN_REQUEST_ID } });
    }
    const text = JSON.stringify({ prompt: prompts[name], changes: ["明确输出目标"], assumptions: [] });
    if (aihubmix) return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: text, reasoning_content: "SMOKE_REASONING_MUST_NOT_BECOME_PROMPT" } }] });
    if (name === "openai") return Response.json({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }] });
    if (name === "anthropic") return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text }] });
    return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }] });
  };
  return {
    calls, writerRequests, judgeRequests, modelCatalogRequests, prompts, releaseWriters: writersGate.release, releaseJudge: judgeGate.release,
    delayNextCatalog() { if (nextCatalogGate) throw new Error("A catalog delay is already pending"); nextCatalogGate = gate(); return nextCatalogGate.release; },
    failNextWriter(name: typeof PROVIDERS[number]) {
      if (closed) throw new Error("Cannot schedule a failure after closing the smoke transport");
      failNext.add(name);
    },
    close() { closed = true; writersGate.release(); judgeGate.release(); },
    restore(restoreFetch = true) {
      closed = true;
      writersGate.release(); judgeGate.release();
      if (restoreFetch) globalThis.fetch = previousFetch;
      for (const name of envNames) {
        if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name];
      }
    },
  };
}

async function reloadRenderer(target: BrowserWindow): Promise<void> {
  const loaded = new Promise<void>(resolve => target.webContents.once("did-finish-load", () => resolve()));
  target.webContents.reload();
  await loaded;
}

async function waitForPanel(target: BrowserWindow): Promise<void> {
  await until("compact desktop panel", () => evaluate(target, () => Boolean(document.querySelector(".pe-panel #prompt-input") && window.peDesktop?.isDesktop)));
  await until("public studio state", async () => Boolean(await evaluate(target, () => window.peDesktop!.getState())));
}

async function showPanel(target: BrowserWindow): Promise<void> {
  await evaluate(target, () => window.peDesktop!.showPanel());
  // The renderer can be visible before AppKit has made it key or the native
  // material has finished its entrance. Real clicks need that active window.
  await until("panel active and entrance settled", async () => target.isVisible() && target.isFocused() && evaluate(target, () => Array.from(document.querySelector(".pe-kit-scene")?.getAnimations() || []).every(animation => animation.playState === "finished" || animation.playState === "idle")));
}

async function stateOf(target: BrowserWindow): Promise<PublicStudioState> {
  const state = await evaluate(target, () => window.peDesktop!.getState());
  if (!state) throw new Error("Public state was unavailable");
  const serialized = JSON.stringify(state);
  if ([SMOKE_KEY, NEXT_SMOKE_KEY, ...PROVIDER_DRAFT_KEYS].some(marker => serialized.includes(marker)) || /"apiKey"\s*:/.test(serialized)) throw new Error("Credential entered public snapshot");
  return state;
}

function candidateOrder(state: PublicStudioState): string[] {
  return state.session?.candidateOrder || state.runConnections.map(connection => connection.id);
}

async function resultPosition(popup: BrowserWindow, id: string): Promise<number> {
  const position = candidateOrder(await stateOf(popup)).indexOf(id);
  if (position < 0) throw new Error("Candidate is missing from this round's blind order: " + id);
  return position;
}

async function assertRoundOrder(popup: BrowserWindow, expected: string[]): Promise<void> {
  const current = candidateOrder(await stateOf(popup));
  if (JSON.stringify(current) !== JSON.stringify(expected) || new Set(current).size !== 3 || [...current].sort().join(",") !== "writer-1,writer-2,writer-3") throw new Error("Blind candidate order changed or is not a permutation: " + JSON.stringify(current));
}

async function assertDisplayedAssociations(popup: BrowserWindow, revealed: boolean): Promise<void> {
  const state = await stateOf(popup);
  const order = candidateOrder(state);
  const checked = await evaluate(popup, ({ order, candidates, scores, revealed }) => Array.from(document.querySelectorAll<HTMLElement>(".compact-results-tab")).every((element, position) => {
    const id = order[position];
    const candidate = candidates.find(value => value.id === id);
    const score = scores.find(value => value.candidateId === id);
    const letter = String.fromCharCode(65 + position);
    const name = element.querySelector(".compact-results-brand")?.textContent?.trim() || "";
    const title = element.getAttribute("title");
    const scoreText = element.querySelector(".compact-results-tab-score")?.textContent || "";
    return name.startsWith(revealed ? letter + " · " : letter) && (!revealed || title === candidate?.model)
      && (!score || scoreText.includes(String(Math.round(score.score * 10) / 10) + " 分"));
  }), { order, candidates: state.session!.candidates, scores: state.session!.judge?.candidates || [], revealed });
  if (!checked) throw new Error("Displayed letters, model identities or scores do not follow the saved round order");
}

function resultWindow(id: string): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(window => {
    if (window.isDestroyed()) return false;
    try { return new URL(window.webContents.getURL()).searchParams.get("result") === id; }
    catch { return false; }
  });
}

async function openResult(popup: BrowserWindow, id: string): Promise<BrowserWindow> {
  const index = await resultPosition(popup, id);
  const transitions: { panelVisible: boolean; panelFocused: boolean; resultPresent: boolean; resultVisible: boolean; resultFocused: boolean; resultLoading: boolean }[] = [];
  if (!resultWindow(id)?.isVisible()) await clickResultControl(popup, index);
  else resultWindow(id)!.focus();
  try {
    await until("independent result " + id, () => {
      const result = resultWindow(id);
      const snapshot = { panelVisible: popup.isVisible(), panelFocused: popup.isFocused(), resultPresent: Boolean(result), resultVisible: Boolean(result?.isVisible()), resultFocused: Boolean(result?.isFocused()), resultLoading: Boolean(result?.webContents.isLoadingMainFrame()) };
      if (JSON.stringify(transitions.at(-1)) !== JSON.stringify(snapshot) && transitions.length < 20) transitions.push(snapshot);
      return Boolean(result?.isVisible());
    });
  } catch {
    throw new Error("Result did not become visible: " + id + " " + JSON.stringify(transitions));
  }
  const bubble = resultWindow(id)!;
  try {
    await until("explicit result activation transfers focus", () => {
      const snapshot = { panelVisible: popup.isVisible(), panelFocused: popup.isFocused(), resultPresent: !bubble.isDestroyed(), resultVisible: bubble.isVisible(), resultFocused: bubble.isFocused(), resultLoading: bubble.webContents.isLoadingMainFrame() };
      if (JSON.stringify(transitions.at(-1)) !== JSON.stringify(snapshot) && transitions.length < 20) transitions.push(snapshot);
      return bubble.isFocused();
    });
  } catch {
    const windows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed()).map(window => ({ title: window.getTitle(), url: window.webContents.getURL(), visible: window.isVisible(), focused: window.isFocused(), loading: window.webContents.isLoadingMainFrame() }));
    const disclosure = await evaluate(popup, () => window.peDesktop!.getResultVisibility());
    throw new Error("Explicit result focus failed: " + id + " " + JSON.stringify({ transitions, windows, disclosure }));
  }
  await until("result bubble renderer", () => evaluate(bubble, () => Boolean(document.querySelector(".pe-result-bubble"))));
  await assertResultVisibility(popup, id, true);
  return bubble;
}

async function clickResultControl(popup: BrowserWindow, index: number): Promise<void> {
  await evaluate(popup, position => {
    const button = document.querySelectorAll<HTMLButtonElement>(".compact-results-tab")[position];
    if (!button) throw new Error("Model result control is missing");
    button.click();
  }, index);
}

async function assertResultVisibility(popup: BrowserWindow, id: string, visible: boolean): Promise<void> {
  const index = await resultPosition(popup, id);
  await until("model disclosure and native visibility agree: " + id + "=" + visible, async () => {
    const reflected = await evaluate(popup, async ({ resultId, position, expected }) => {
      const visibility = await window.peDesktop!.getResultVisibility();
      const state = await window.peDesktop!.getState();
      return visibility.sessionId === (state?.session?.id ?? null)
        && visibility.visibleIds.includes(resultId) === expected
        && document.querySelectorAll(".compact-results-tab")[position]?.getAttribute("aria-expanded") === String(expected);
    }, { resultId: id, position: index, expected: visible });
    return reflected && Boolean(resultWindow(id)?.isVisible()) === visible;
  });
}

async function assertResultsCollapsed(popup: BrowserWindow): Promise<void> {
  await until("all results collapsed", async () => {
    if (BrowserWindow.getAllWindows().some(window => {
      try { return !window.isDestroyed() && new URL(window.webContents.getURL()).searchParams.has("result") && window.isVisible(); }
      catch { return false; }
    })) return false;
    return evaluate(popup, async () => (await window.peDesktop!.getResultVisibility()).visibleIds.length === 0
      && Array.from(document.querySelectorAll(".compact-results-tab")).every(button => button.getAttribute("aria-expanded") === "false"));
  });
}

async function assertNoQualificationLabels(target: BrowserWindow): Promise<void> {
  const removed = await evaluate(target, () => {
    const text = document.body.innerText + "\n" + Array.from(document.querySelectorAll("[aria-label],[title]")).map(element => `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`).join("\n");
    return /未达标|未满足硬性要求/.test(text);
  });
  if (removed) throw new Error("Removed qualification labels remain visible or accessible");
}

async function assertBlindUi(target: BrowserWindow, kind: "panel" | "result"): Promise<Record<string, unknown>> {
  const inspected = await evaluate(target, ({ kind, models }) => {
    const roots = kind === "panel" ? Array.from(document.querySelectorAll<HTMLElement>(".compact-results-brand")) : Array.from(document.querySelectorAll<HTMLElement>(".result-bubble-identity"));
    const labels = roots.map(element => element.innerText.trim());
    const metadata = Array.from(document.querySelectorAll<HTMLElement>("[aria-label],[title]")).filter(element => element.checkVisibility()).map(element => `${element.getAttribute("aria-label") || ""} ${element.getAttribute("title") || ""}`).join("\n");
    const identifyingUi = labels.join("\n") + "\n" + metadata + "\n" + Array.from(document.querySelectorAll<HTMLElement>(".result-bubble-empty")).map(element => element.innerText).join("\n");
    const brandIdentityVisible = /GPT|Claude|Gemini|AiHubMix|DeepSeek|OpenAI|Anthropic/i.test(identifyingUi) || models.some(model => identifyingUi.includes(model));
    const logoCount = document.querySelectorAll(".model-logo").length;
    const coloredIdentity = Array.from(document.querySelectorAll<HTMLElement>(".compact-results-tab,.pe-result-bubble")).some(element => /model-brand-(?!custom)[a-z]+/.test(element.className));
    return { labels, brandIdentityVisible, logoCount, coloredIdentity, rawDiagnostics: Boolean(document.querySelector(".result-bubble-diagnostic")), revealVisible: Boolean(document.querySelector<HTMLElement>(".compact-reveal-model,.result-reveal-model")?.checkVisibility()) };
  }, { kind, models: AIHUBMIX_MODELS });
  const expected = kind === "panel" ? inspected.labels.join(",") === "A,B,C" : inspected.labels.length === 1 && /^[ABC]$/.test(inspected.labels[0]);
  if (!expected || inspected.brandIdentityVisible || inspected.logoCount || inspected.coloredIdentity || inspected.rawDiagnostics || !inspected.revealVisible) throw new Error("Blind model identity leaked or reveal missing: " + JSON.stringify(inspected));
  return { lettersOnly: true, noNamesOrTitles: true, noBrandLogosOrColors: true, noRawDiagnostics: true, revealVisible: true };
}

async function revealModels(target: BrowserWindow): Promise<void> {
  await evaluate(target, () => {
    const button = document.querySelector<HTMLButtonElement>(".compact-reveal-model,.result-reveal-model");
    if (!button || button.disabled) throw new Error("Explicit model reveal action unavailable");
    button.click();
  });
  await until("all model identities revealed", async () => (await stateOf(target)).modelsRevealed);
  await until("revealed identity rendered", () => evaluate(target, () => !document.querySelector(".compact-reveal-model,.result-reveal-model") && document.querySelectorAll(".model-logo").length > 0));
}

async function checkSingleResultSwitching(popup: BrowserWindow): Promise<Record<string, unknown>> {
  const firstId = candidateOrder(await stateOf(popup))[0];
  await evaluate(popup, async () => { const bridge = window.peDesktop!; const visibility = await bridge.getResultVisibility(); for (const id of visibility.visibleIds) { if (!(await bridge.closeResult(id)).ok) throw new Error("Could not close visible result before rapid switching"); } });
  await assertResultsCollapsed(popup);
  await evaluate(popup, () => {
    const controls = document.querySelectorAll<HTMLButtonElement>(".compact-results-tab");
    for (const position of [0, 1, 2, 0]) controls[position].click();
  });
  await until("rapid ABC-A switch settles to A only", async () => {
    const visible = await evaluate(popup, () => window.peDesktop!.getResultVisibility());
    const nativeVisible = ["writer-1", "writer-2", "writer-3"].filter(id => resultWindow(id)?.isVisible());
    return visible.visibleIds.join(",") === firstId && nativeVisible.join(",") === firstId;
  });
  await assertResultVisibility(popup, firstId, true);
  await clickResultControl(popup, 0);
  await assertResultsCollapsed(popup);
  if (!popup.isVisible()) throw new Error("Collapsing final result also hid input window");
  return { rapidSwitchSettlesToLastSelection: true, oneVisibleResult: true, nativeAndControlsSynchronized: true, repeatedClickCollapses: true };
}

async function checkModelMarks(target: BrowserWindow, selector: string, expectedCount: number): Promise<Record<string, unknown>> {
  const marks = await evaluate(target, selected => Array.from(document.querySelectorAll<HTMLElement>(selected)).map(logo => {
    const parent = logo.parentElement!;
    const range = document.createRange();
    range.selectNodeContents(parent); range.setEndBefore(logo);
    const label = range.toString().trim();
    const labelBounds = range.getBoundingClientRect();
    const bounds = logo.getBoundingClientRect();
    const style = getComputedStyle(logo);
    const asset = style.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
    const localAsset = asset ? new URL(asset) : null;
    return {
      label, afterName: Boolean(label) && bounds.left >= labelBounds.right - 2,
      transparentBackground: style.backgroundColor === "rgba(0, 0, 0, 0)",
      localSvg: localAsset?.origin === location.origin && /^\/brands\/(?:gpt|claude|gemini)\.svg$/.test(localAsset.pathname),
      visible: logo.checkVisibility() && bounds.width > 0 && bounds.height > 0,
      hiddenFromAccessibility: logo.getAttribute("aria-hidden") === "true",
    };
  }), selector);
  if (marks.length !== expectedCount || marks.some(mark => !mark.afterName || !mark.transparentBackground || !mark.localSvg || !mark.visible || !mark.hiddenFromAccessibility)) throw new Error("Model name trailing transparent local marks failed: " + JSON.stringify(marks));
  return { afterName: true, transparentBackground: true, localSvg: true, marks };
}

async function checkResultBoundary(bubble: BrowserWindow): Promise<Record<string, unknown>> {
  return evaluate(bubble, async () => {
    const bridge = window.peDesktop!;
    const state = await bridge.getState();
    if (!state) throw new Error("Result window did not receive public state");
    const denied = async (action: () => Promise<unknown>) => {
      try { const value = await action(); return Boolean(value && typeof value === "object" && "ok" in value && value.ok === false); }
      catch { return true; }
    };
    const restricted = {
      getCredentials: await denied(() => bridge.getCredentials()),
      saveCredentials: await denied(() => bridge.saveCredentials({ writers: {}, jev: "" }, true)),
      commitSettings: await denied(() => bridge.commitSettings(state.config, { writers: {}, jev: "" })),
      getShortcut: await denied(() => bridge.getShortcut()),
      setShortcut: await denied(() => bridge.setShortcut("Control+Q")),
      openWorkspace: await denied(() => bridge.openWorkspace("settings")),
      publishState: await denied(() => bridge.publishState(state)),
      setPanelMode: await denied(() => bridge.setPanelMode("results")),
      updateConfig: await denied(() => bridge.sendCommand({ type: "config-updated", config: state.config })),
      crossCandidateRetry: await denied(() => bridge.sendCommand({ type: "retry-candidate", id: "writer-1" })),
      crossCandidateClose: await denied(() => bridge.closeResult("writer-1")),
      openAnotherCandidate: await denied(() => bridge.openResult("writer-1")),
      toggleAnotherCandidate: await denied(() => bridge.toggleResult("writer-1")),
      toggleOwnCandidate: await denied(() => bridge.toggleResult("writer-2")),
      getResultVisibility: await denied(() => bridge.getResultVisibility()),
      setSettingsModelDirty: await denied(() => bridge.setSettingsModelDirty(true)),
      completeSettingsAction: await denied(() => bridge.completeSettingsAction("smoke-forged-request", true)),
      listLocalAgents: await denied(() => bridge.listLocalAgents()),
      generateLocal: await denied(() => bridge.generateLocal("smoke-denied-result", state.brief, { id: "writer-2", label: "Local", protocol: "local-agent", model: "default", baseUrl: "local://codex", apiKey: "" })),
      cancelLocal: await denied(() => bridge.cancelLocal("smoke-denied-result")),
    };
    const apiBlocked = async (path: string, init?: RequestInit) => {
      try { return (await fetch(path, init)).status === 403; } catch { return true; }
    };
    const configApiBlocked = await apiBlocked("/api/config");
    const modelsApiBlocked = await apiBlocked("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const generationApiBlocked = await apiBlocked("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    // While the judge is gated, the owner deliberately ignores retry actions.
    // This tests authorization without starting extra mock model requests.
    if (!state.running) throw new Error("Result permission test must run during a pending review");
    const ownRetryAllowed = (await bridge.sendCommand({ type: "retry-candidate", id: "writer-2" })).ok;
    const judgeRetryAllowed = (await bridge.sendCommand({ type: "retry-judge" })).ok;
    if (Object.values(restricted).some(value => !value) || !configApiBlocked || !modelsApiBlocked || !generationApiBlocked || !ownRetryAllowed || !judgeRetryAllowed) throw new Error("Result-window capability boundary failed: " + JSON.stringify({ restricted, configApiBlocked, modelsApiBlocked, generationApiBlocked, ownRetryAllowed, judgeRetryAllowed }));
    return { restricted, configApiBlocked, modelsApiBlocked, generationApiBlocked, ownRetryAllowed, judgeRetryAllowed };
  });
}

async function checkGroupWindows(popup: BrowserWindow, bubble: BrowserWindow, workspace: BrowserWindow): Promise<Record<string, unknown>> {
  await showPanel(popup);
  bubble.focus();
  await until("result owns group focus", () => bubble.isFocused());
  popup.emit("blur");
  await pause(150);
  if (!popup.isVisible() || !bubble.isVisible()) throw new Error("Focus within the floating group dismissed a window");
  const before = [popup.getBounds(), bubble.getBounds()];
  const area = screen.getDisplayMatching(before[0]).workArea;
  const maxRight = Math.max(...before.map(bounds => bounds.x + bounds.width));
  const minLeft = Math.min(...before.map(bounds => bounds.x));
  const maxBottom = Math.max(...before.map(bounds => bounds.y + bounds.height));
  const minTop = Math.min(...before.map(bounds => bounds.y));
  const dx = area.x + area.width - maxRight >= 12 ? 12 : minLeft - area.x >= 12 ? -12 : 0;
  const dy = area.y + area.height - maxBottom >= 9 ? 9 : minTop - area.y >= 9 ? -9 : 0;
  bubble.setPosition(before[1].x + dx, before[1].y + dy);
  bubble.emit("move");
  await until("native movement follows group", () => popup.getBounds().x === before[0].x + dx && popup.getBounds().y === before[0].y + dy);
  const moved = [popup.getBounds(), bubble.getBounds()];
  if (moved[1].x - moved[0].x !== before[1].x - before[0].x || moved[1].y - moved[0].y !== before[1].y - before[0].y) throw new Error("Group dragging changed the relative window position");
  bubble.setPosition(area.x - 120, area.y - 120);
  bubble.emit("moved");
  await pause(180);
  const clamped = [popup.getBounds(), bubble.getBounds()];
  if (clamped.some(bounds => bounds.x < area.x || bounds.y < area.y || bounds.x + bounds.width > area.x + area.width || bounds.y + bounds.height > area.y + area.height)) throw new Error("Floating group escaped the display work area");
  const scrollBefore = await evaluate(bubble, () => document.querySelector<HTMLElement>(".result-bubble-prompt")?.scrollTop);
  const beforeInputMove = popup.getBounds();
  const inputDx = beforeInputMove.x + beforeInputMove.width + 14 <= area.x + area.width ? 14 : -14;
  popup.focus();
  popup.setPosition(beforeInputMove.x + inputDx, beforeInputMove.y);
  popup.emit("move");
  await assertResultsCollapsed(popup);
  if (!popup.isVisible()) throw new Error("Dragging the input panel hid the input panel itself");
  const anchor = popup.getBounds();
  workspace.show(); workspace.focus();
  await until("workspace owns focus", () => workspace.isFocused());
  popup.emit("blur"); bubble.emit("blur");
  await until("leaving group hides every floating window", () => !popup.isVisible() && !bubble.isVisible());
  await showPanel(popup);
  await assertResultsCollapsed(popup);
  if (popup.getBounds().x !== anchor.x || popup.getBounds().y !== anchor.y) throw new Error("Reopening lost the dragged main-window position");
  await openResult(popup, "writer-2");
  const scrollAfter = await evaluate(bubble, () => document.querySelector<HTMLElement>(".result-bubble-prompt")?.scrollTop);
  if (scrollAfter !== scrollBefore) throw new Error("Explicit reopening after input drag lost the reading position");
  return { internalFocusRetainedGroup: true, nativeResultDragMovesGroup: { dx, dy }, clampedBounds: clamped, inputDragCollapsesResults: true, inputRemainsVisible: true, showAfterInputDragDoesNotRestoreResults: true, explicitReopenPreservesScroll: true, outsideFocusHidWholeGroup: true, anchorRestored: true };
}

async function checkWriterFailureRetry(popup: BrowserWindow, workspace: BrowserWindow, mocked: ReturnType<typeof mockModelTransport>, directory: string, provider: "openai" | "anthropic" = "openai"): Promise<Record<string, unknown>> {
  const index = PROVIDERS.indexOf(provider);
  const id = `writer-${index + 1}`;
  const stem = provider === "openai" ? "gpt" : "claude";
  const specificClaude = provider === "anthropic";
  const previousId = (await stateOf(popup)).session?.id;
  const beforeCalls = { ...mocked.calls };
  mocked.failNextWriter(provider);
  await showPanel(popup);
  await evaluate(popup, async () => {
    const input = document.querySelector<HTMLTextAreaElement>("#prompt-input")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "桌面失败恢复测试：为咖啡店写真实、简洁的介绍，保留已成功生成的提示词。");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 100));
    const generate = document.querySelector<HTMLButtonElement>(".generate-button");
    if (!generate || generate.disabled) throw new Error("Failure-recovery generation action unavailable");
    generate.click();
  });
  await until("partial failure and two successful reviews", async () => {
    const state = await stateOf(popup);
    return Boolean(state.session && state.session.id !== previousId && !state.running && state.session.candidates.length === 3 && state.session.judge?.status === "complete");
  });
  const partial = (await stateOf(popup)).session!;
  const partialOrder = candidateOrder(await stateOf(popup));
  const failed = partial.candidates.find(candidate => candidate.id === id);
  const retained = partial.candidates.filter(candidate => candidate.id !== id);
  if (PROVIDERS.some(name => mocked.calls[name] !== beforeCalls[name] + 1) || mocked.calls.jev !== beforeCalls.jev + 1) throw new Error("Partial-failure run made unexpected model requests");
  if (failed?.status !== "error" || failed.prompt || partial.judge?.candidates.some(candidate => candidate.candidateId === id) || partial.judge?.recommendedId === id) throw new Error("Failed " + stem + " result received a fabricated prompt, score or recommendation");
  if (retained.length !== 2 || retained.some(candidate => candidate.status !== "success" || candidate.prompt !== mocked.prompts[PROVIDERS[Number(candidate.id.slice(-1)) - 1]]) || partial.judge?.candidates.length !== 2) throw new Error("A failed writer discarded successful candidates or their scores");
  await assertResultsCollapsed(popup);
  const bubble = await openResult(popup, id);
  if ((await stateOf(popup)).modelsRevealed) throw new Error("A new generation kept prior model reveal state");
  const blindPanel = await assertBlindUi(popup, "panel");
  const blindResult = await assertBlindUi(bubble, "result");
  await revealModels(bubble);
  await until(stem + " failure diagnostics", () => evaluate(bubble, () => Boolean(document.querySelector(".result-bubble-diagnostic summary"))));
  const visibleFailure = await evaluate(bubble, expected => {
    document.querySelector<HTMLElement>(".result-bubble-diagnostic summary")!.click();
    const details = document.querySelector<HTMLDetailsElement>(".result-bubble-diagnostic")!;
    const text = details.innerText;
    return {
      detailsOpen: details.open,
      http403: text.includes("HTTP 403"),
      codeAndType: text.includes("permission_error") && (expected.claude || text.includes("permission_denied")),
      traceEvidence: text.includes(expected.traceId),
      causeEvidence: expected.claude ? text.includes("AiHubMix 返回该 Key 无权访问当前模型") && !text.includes("具体原因尚未确认") : text.includes("具体原因尚未确认"),
      noCredentialOrSuffix: !text.includes(expected.key) && !text.includes(expected.key.slice(-6)) && !text.includes("Forbidden – key("),
      noPrompt: !document.querySelector(".result-bubble-prompt pre"),
      noScore: !/\d+(?:\.\d+)?\s*分/.test(document.querySelector(".result-bubble-meta")?.textContent || ""),
      copyDisabled: document.querySelector<HTMLButtonElement>(".result-bubble-copy")?.disabled === true,
      retryEnabled: document.querySelector<HTMLButtonElement>(".result-bubble-retry")?.disabled === false,
    };
  }, { claude: specificClaude, traceId: specificClaude ? CLAUDE_FORBIDDEN_TRACE_ID : FORBIDDEN_REQUEST_ID, key: SMOKE_KEY });
  if (Object.values(visibleFailure).some(value => !value)) throw new Error(stem + " failure details were incomplete or misleading: " + JSON.stringify(visibleFailure));
  await assertNoQualificationLabels(popup);
  await assertNoQualificationLabels(bubble);
  // Native captures can otherwise return the compositor frame from before the
  // details toggle, even though the DOM has already confirmed it is expanded.
  await pause(150);
  await writeFile(join(directory, `${stem}-403-result.png`), (await bubble.webContents.capturePage()).toPNG());
  await writeFile(join(directory, `${stem}-403-panel.png`), (await popup.webContents.capturePage()).toPNG());
  const partialCalls = { ...mocked.calls };
  const savedConfig = (await stateOf(popup)).config;
  const nextModel = "Smoke-Model-For-Next-Round-Only";
  await evaluate(workspace, ({ config, id, model }) => window.peDesktop!.sendCommand({ type: "config-updated", config: { ...config, writers: config.writers.map(writer => writer.id === id ? { ...writer, model } : writer) } }), { config: savedConfig, id, model: nextModel });
  await until("next-round model selected before single retry", async () => (await stateOf(popup)).config.writers.find(writer => writer.id === id)?.model === nextModel);
  await evaluate(bubble, () => document.querySelector<HTMLButtonElement>(".result-bubble-retry")!.click());
  await until("single " + stem + " retry and refreshed review", async () => {
    const state = await stateOf(popup);
    return !state.running && state.session?.id === partial.id && state.session.candidates.find(candidate => candidate.id === id)?.status === "success" && state.session.judge?.status === "complete";
  });
  const recovered = (await stateOf(popup)).session!;
  await assertRoundOrder(popup, partialOrder);
  if (PROVIDERS.some(name => mocked.calls[name] !== partialCalls[name] + Number(name === provider)) || mocked.calls.jev !== partialCalls.jev + 1) throw new Error("Single " + stem + " retry unexpectedly reran another writer");
  if (retained.some(candidate => JSON.stringify(recovered.candidates.find(value => value.id === candidate.id)) !== JSON.stringify(candidate))) throw new Error("Single retry changed another writer's successful result");
  if (recovered.candidates.find(candidate => candidate.id === id)?.prompt !== mocked.prompts[provider] || recovered.judge?.candidates.length !== 3 || !recovered.judge.candidates.some(candidate => candidate.candidateId === id && Number.isFinite(candidate.score))) throw new Error("Successful " + stem + " retry did not restore its complete prompt and score");
  if (recovered.candidates.find(candidate => candidate.id === id)?.model !== failed.model || (await stateOf(popup)).runConnections.find(connection => connection.id === id)?.model !== failed.model) throw new Error("A next-round model selection replaced the current round's retry identity");
  await until("recovered " + stem + " result shown", () => evaluate(bubble, prompt => document.querySelector(".result-bubble-prompt > pre")?.textContent === prompt && !document.querySelector(".result-bubble-diagnostic") && document.querySelector<HTMLButtonElement>(".result-bubble-copy")?.disabled === false && /\d+(?:\.\d+)?\s*分/.test(document.querySelector(".result-bubble-meta")?.textContent || ""), mocked.prompts[provider]));
  await writeFile(join(directory, `${stem}-recovered-result.png`), (await bubble.webContents.capturePage()).toPNG());
  await assertDisplayedAssociations(popup, true);
  await evaluate(workspace, config => window.peDesktop!.sendCommand({ type: "config-updated", config }), savedConfig);
  await until("model configuration restored after retry test", async () => JSON.stringify((await stateOf(popup)).config) === JSON.stringify(savedConfig));
  return { provider, blindPanel, blindResult, newRoundRehidden: true, explicitRevealShowsDiagnostics: true, partialSessionId: partial.id, candidateOrder: partialOrder, retryPreservesBlindOrder: true, nextRoundModelChangeDoesNotReplaceRetryIdentity: true, visibleFailure, otherCandidatesKept: true, retryOnlyRequestedProvider: true, otherCandidatesUnchanged: true, scoringRestored: true, callsBefore: beforeCalls, callsAfterFailure: partialCalls, callsAfterRecovery: { ...mocked.calls } };
}

async function openSettings(popup: BrowserWindow, getWorkspace: () => BrowserWindow | null): Promise<BrowserWindow> {
  await showPanel(popup);
  await evaluate(popup, () => {
    const button = document.querySelector<HTMLButtonElement>('.pe-panel-settings[aria-label="打开设置"]');
    if (!button?.checkVisibility()) throw new Error("Discoverable popup settings entry is missing");
    button.click();
  });
  await until("workspace creation", () => Boolean(getWorkspace() && !getWorkspace()!.isDestroyed()));
  const workspace = getWorkspace()!;
  await until("workspace settings", () => evaluate(workspace, () => Boolean(document.querySelector("#writer-model"))));
  return workspace;
}

async function configureAiHubMix(workspace: BrowserWindow): Promise<void> {
  await evaluate(workspace, async expectedModels => {
    const pause = () => new Promise(resolve => setTimeout(resolve, 80));
    const setInput = async (selector: string, value: string) => {
      const input = document.querySelector<HTMLInputElement>(selector);
      if (!input) throw new Error("Settings input missing: " + selector);
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await pause();
    };
    for (let i = 0; i < 3; i++) {
      document.querySelector<HTMLButtonElement>("#writer-tab-" + i)!.click(); await pause();
      document.querySelector<HTMLButtonElement>('[data-provider="aihubmix"]')!.click(); await pause();
      await setInput("#writer-model", i === 0 ? "Smoke-Custom-Model-X" : expectedModels[i]);
      if (document.querySelector("#writer-panel")?.getAttribute("data-protocol") !== "aihubmix" || document.querySelector<HTMLInputElement>("#writer-base")!.value !== "https://aihubmix.com/v1") throw new Error("AiHubMix per-slot selection did not update the intended slot");
      if (document.querySelector<HTMLInputElement>("#writer-key-" + i)!.value !== "") throw new Error("Smoke must not persist credentials");
    }
    document.querySelector<HTMLButtonElement>("#writer-tab-0")!.click(); await pause();
    if (document.querySelector<HTMLInputElement>("#writer-model")!.value !== "Smoke-Custom-Model-X") throw new Error("Model ID was normalized or per-slot draft was lost");
    await setInput("#writer-model", expectedModels[0]);
    if (document.querySelector<HTMLInputElement>("#judge-key")!.value !== "") throw new Error("Smoke judge key must remain empty");
    const save = document.querySelector<HTMLButtonElement>(".provider-model-save button");
    if (!save) throw new Error("Settings save action missing");
    save.click();
  }, AIHUBMIX_MODELS);
}

async function checkProviderSettings(workspace: BrowserWindow): Promise<Record<string, unknown>> {
  const checked = await evaluate(workspace, async keys => {
    const pause = () => new Promise(resolve => setTimeout(resolve, 80));
    const until = async (label: string, condition: () => boolean) => { const end = Date.now() + 8000; while (!condition()) { if (Date.now() > end) throw new Error(label); await pause(); } };
    const setInput = async (selector: string, value: string) => { const input = document.querySelector<HTMLInputElement>(selector)!; if (!input) throw new Error("Missing " + selector); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); await pause(); };
    const chooseProvider = async (id: string) => { document.querySelector<HTMLButtonElement>('[data-provider="' + id + '"]')!.click(); await pause(); };
    const getModels = () => { const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".provider-model-heading button")).find(element => element.textContent?.includes("获取模型列表")); if (!button || button.disabled) throw new Error("Model directory action unavailable"); button.click(); };
    const providers = Array.from(document.querySelectorAll(".provider-list [data-provider]")).map(element => element.getAttribute("data-provider"));
    if (providers.join(",") !== "aihubmix,deepseek,local-agent") throw new Error("Unexpected provider choices");
    document.querySelector<HTMLButtonElement>("#writer-tab-0")!.click(); await pause();
    const original = { model: document.querySelector<HTMLInputElement>("#writer-model")!.value, base: document.querySelector<HTMLInputElement>("#writer-base")!.value };
    await setInput("#writer-key-0", keys[0]);
    await setInput("#writer-model", "Smoke-Free-ID-MixedCase");
    await chooseProvider("deepseek");
    if (document.querySelector<HTMLInputElement>("#writer-key-0")!.value || document.querySelector<HTMLInputElement>("#writer-base")!.value !== "https://api.deepseek.com") throw new Error("Cross-provider key or URL was carried into DeepSeek");
    await setInput("#writer-key-0", keys[1]);
    getModels();
    try { await until("DeepSeek directory unavailable", () => document.querySelectorAll(".provider-model-catalog button").length === 2); }
    catch { throw new Error("DeepSeek directory unavailable: " + JSON.stringify({ protocol:document.querySelector("#writer-panel")?.getAttribute("data-protocol"), address:document.querySelector<HTMLInputElement>("#writer-base")?.value, catalogCount:document.querySelectorAll(".provider-model-catalog button").length, status:Array.from(document.querySelectorAll(".provider-status,.form-error")).map(element=>element.textContent), actions:Array.from(document.querySelectorAll<HTMLButtonElement>(".provider-model-heading button")).map(button=>({text:button.textContent,disabled:button.disabled})) })); }
    const deepseek = Array.from(document.querySelectorAll<HTMLButtonElement>(".provider-model-catalog button")).find(button => button.textContent?.includes("deepseek-v4-pro"));
    if (!deepseek) throw new Error("DeepSeek model missing"); deepseek.click(); await pause();
    if (document.querySelector<HTMLInputElement>("#writer-model")!.value !== "deepseek-v4-pro") throw new Error("Choosing directory model did not preserve exact ID");
    if (Array.from(document.querySelectorAll<HTMLElement>(".provider-model-catalog")).some(element => element.checkVisibility())) throw new Error("Selecting a DeepSeek model did not collapse its picker");
    await chooseProvider("aihubmix");
    if (document.querySelector<HTMLInputElement>("#writer-key-0")!.value !== keys[0] || document.querySelector<HTMLInputElement>("#writer-model")!.value !== "Smoke-Free-ID-MixedCase" || document.querySelector<HTMLInputElement>("#writer-base")!.value !== original.base) throw new Error("Returning to provider lost its independent draft");
    getModels();
    await until("AiHubMix directory unavailable", () => document.querySelectorAll(".provider-model-catalog button").length === 3);
    await setInput(".provider-model-search input", "claude");
    if (document.querySelectorAll(".provider-model-catalog button").length !== 1) throw new Error("Model search did not filter directory");
    document.querySelector<HTMLButtonElement>(".provider-model-catalog button")!.click(); await pause();
    if (document.querySelector<HTMLInputElement>("#writer-model")!.value !== "claude-opus-5-5") throw new Error("Filtered model selection mismatch");
    if (Array.from(document.querySelectorAll<HTMLElement>(".provider-model-catalog")).some(element => element.checkVisibility())) throw new Error("Selecting a filtered model did not collapse its picker");
    document.querySelector<HTMLButtonElement>("#writer-tab-1")!.click(); await pause();
    if (document.querySelector<HTMLInputElement>("#writer-key-1")!.value) throw new Error("A Key was copied into slot B");
    await setInput("#writer-key-1", keys[2]);
    document.querySelector<HTMLButtonElement>("#writer-tab-0")!.click(); await pause();
    if (document.querySelector<HTMLInputElement>("#writer-key-0")!.value !== keys[0]) throw new Error("B Key overwrote slot A");
    await chooseProvider("deepseek");
    if (document.querySelector<HTMLInputElement>("#writer-key-0")!.value !== keys[1] || document.querySelector<HTMLInputElement>("#writer-model")!.value !== "deepseek-v4-pro") throw new Error("DeepSeek independent draft was lost");
    await chooseProvider("local-agent");
    await until("Local detection did not settle", () => !Array.from(document.querySelectorAll<HTMLButtonElement>(".provider-model-heading button")).some(button => button.textContent?.includes("检测中")));
    const agents = await window.peDesktop!.listLocalAgents();
    if (!Array.isArray(agents) || agents.length !== 4 || new Set(agents.map(agent => agent.id)).size !== 4 || agents.some(agent => !["codex", "claude", "pi", "hermes"].includes(agent.id) || typeof agent.installed !== "boolean" || typeof agent.available !== "boolean" || typeof agent.status !== "string")) throw new Error("Local agent detection returned unexpected metadata");
    let localInvalidRejected = false;
    try { await window.peDesktop!.generateLocal("smoke-invalid", {} as Parameters<NonNullable<typeof window.peDesktop>["generateLocal"]>[1], { id: "writer-1", label: "invalid", protocol: "local-agent", model: "default", baseUrl: "local://invalid", apiKey: "" }); } catch { localInvalidRejected = true; }
    if (!localInvalidRejected) throw new Error("Invalid local generation was not rejected");
    await chooseProvider("aihubmix");
    await setInput("#writer-key-0", ""); await setInput("#writer-model", original.model);
    document.querySelector<HTMLButtonElement>("#writer-tab-1")!.click(); await pause(); await setInput("#writer-key-1", "");
    document.querySelector<HTMLButtonElement>("#writer-tab-0")!.click(); await pause();
    return { providers, crossProviderKeyIsolation: true, returningRestoresIndependentDraft: true, independentSlotKeys: true, directoryModelSelection: true, directorySelectionFillsFieldAndCollapses: true, directorySearch: true, freeModelIdPreserved: true, localDetectionMetadataOnly: true, localInvalidRejected, detectedAgents: agents.map(({ id, installed, available }) => ({ id, installed, available })) };
  }, PROVIDER_DRAFT_KEYS);
  return checked;
}

async function checkLateCatalogSelection(workspace: BrowserWindow, mocked: ReturnType<typeof mockModelTransport>): Promise<Record<string, unknown>> {
  const original = await evaluate(workspace, () => document.querySelector<HTMLInputElement>("#writer-model")!.value);
  const before = mocked.modelCatalogRequests.length;
  const release = mocked.delayNextCatalog();
  try {
    await evaluate(workspace, () => {
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".provider-model-heading button")).find(element => element.textContent?.includes("获取模型列表"));
      if (!button || button.disabled) throw new Error("Late-catalog request action missing");
      button.click();
    });
    await until("delayed catalog request started", () => mocked.modelCatalogRequests.length === before + 1);
    await evaluate(workspace, () => {
      const input = document.querySelector<HTMLInputElement>("#writer-model")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Smoke-Late-Selected-Model");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pause(100);
    release();
    await until("late model directory settled", () => evaluate(workspace, () => Array.from(document.querySelectorAll<HTMLButtonElement>(".provider-model-heading button")).some(element => !element.disabled && element.textContent?.includes("获取模型列表"))));
    await pause(150);
    if (await evaluate(workspace, () => document.querySelector<HTMLInputElement>("#writer-model")!.value) !== "Smoke-Late-Selected-Model") throw new Error("A late model directory response overwrote the user's newer model choice");
    await evaluate(workspace, value => {
      const input = document.querySelector<HTMLInputElement>("#writer-model")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, original);
    await pause(100);
    return { delayedDirectoryDoesNotOverwriteNewerModel: true, readOnlyCatalogRequest: true };
  } finally { release(); }
}

async function checkWorkspaceDraft(popup: BrowserWindow, workspace: BrowserWindow): Promise<Record<string, unknown>> {
  const original = await evaluate(workspace, () => document.querySelector<HTMLInputElement>("#writer-base")!.value);
  await evaluate(workspace, () => {
    const input = document.querySelector<HTMLInputElement>("#writer-base")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "https://smoke.example/v1-unsaved-draft");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await pause(100);
  await showPanel(popup);
  await until("returning to popup hides workspace", () => !workspace.isVisible() && popup.isVisible());
  const retainedWhileHidden = await evaluate(workspace, () => document.querySelector<HTMLInputElement>("#writer-base")?.value === "https://smoke.example/v1-unsaved-draft");
  if (!retainedWhileHidden) throw new Error("Returning to popup discarded settings draft");
  await evaluate(popup, () => window.peDesktop!.openWorkspace("settings"));
  await until("return to settings hides popup", () => workspace.isVisible() && !popup.isVisible());
  workspace.emit("blur");
  await pause(180);
  const retained = await evaluate(workspace, () => document.querySelector<HTMLInputElement>("#writer-base")?.value === "https://smoke.example/v1-unsaved-draft");
  if (!workspace.isVisible() || !retained) throw new Error("Workspace blur hid the window or discarded its draft");
  workspace.focus();
  await evaluate(workspace, value => {
    const input = document.querySelector<HTMLInputElement>("#writer-base")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, original);
  return { popupAndWorkspaceMutuallyExclusive: true, addressOnlyChangeDoesNotTriggerModelReminder: true, hiddenWorkspaceDraftRetained: true, returnToSettingsRestoresDraft: true, ordinaryWorkspaceBlurKeepsWindow: true };
}

async function checkSettingsModelGuard(popup: BrowserWindow, workspace: BrowserWindow): Promise<Record<string, unknown>> {
  const originalShowMessageBox = dialog.showMessageBox;
  const prompts: { buttons: string[]; defaultId?: number; cancelId?: number }[] = [];
  const cases: { trigger: string; choice: string; saved: boolean; draftRetained: boolean }[] = [];
  const originalModel = (await stateOf(popup)).config.writers[0].model;
  let response = 2;
  dialog.showMessageBox = (async (...args: unknown[]) => {
    const options = args.at(-1) as Electron.MessageBoxOptions;
    const buttons = options.buttons || [];
    if (buttons.join(",") !== "保存,放弃修改,继续编辑") throw new Error("Unexpected settings reminder choices: " + buttons.join(","));
    prompts.push({ buttons: [...buttons], defaultId: options.defaultId, cancelId: options.cancelId });
    return { response, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
  const settings = async () => {
    await evaluate(popup, () => window.peDesktop!.openWorkspace("settings"));
    await until("settings visible for model guard", () => workspace.isVisible() && evaluate(workspace, () => document.querySelector<HTMLInputElement>("#writer-model")?.checkVisibility() === true));
    await evaluate(workspace, () => document.querySelector<HTMLButtonElement>("#writer-tab-0")!.click());
    await pause(100);
  };
  const editModel = async (model: string) => {
    await evaluate(workspace, value => {
      const input = document.querySelector<HTMLInputElement>("#writer-model")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, model);
    await pause(150);
  };
  const activate = async (trigger: "navigate" | "close" | "panel") => {
    if (trigger === "close") workspace.close();
    else await evaluate(workspace, action => {
      const selector = action === "navigate" ? ".pe-workspace-sidebar nav button" : ".pe-workspace-bottom button";
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>(selector)).find(item => action === "navigate" ? item.textContent?.includes("历史与收藏") : true);
      if (!button) throw new Error("Settings leave control missing: " + action);
      button.click();
    }, trigger);
  };
  const atDestination = async (trigger: "navigate" | "close" | "panel") => {
    if (trigger === "navigate") return workspace.isVisible() && evaluate(workspace, () => document.querySelector('.pe-workspace-sidebar nav [aria-current="page"]')?.textContent?.includes("历史与收藏") === true);
    return !workspace.isVisible() && (trigger !== "panel" || popup.isVisible());
  };
  try {
    await settings();
    const nearbySave = await evaluate(workspace, () => {
      const model = document.querySelector<HTMLInputElement>("#writer-model")!;
      model.scrollIntoView({ block: "center" });
      const button = document.querySelector<HTMLButtonElement>(".provider-model-save button");
      if (!button) return false;
      const modelBox = model.getBoundingClientRect(); const buttonBox = button.getBoundingClientRect();
      return button.checkVisibility() && buttonBox.top >= modelBox.top - 20 && buttonBox.top - modelBox.bottom <= 120 && buttonBox.top >= 0 && buttonBox.bottom <= innerHeight;
    });
    if (!nearbySave) throw new Error("Model save action is not visible near the model field");
    for (const trigger of ["navigate", "close", "panel"] as const) {
      for (const [choiceIndex, choice] of ["保存", "放弃修改", "继续编辑"].entries()) {
        await settings();
        const before = (await stateOf(popup)).config.writers[0].model;
        const draft = "Smoke-Guard-" + trigger + "-" + choiceIndex;
        await editModel(draft);
        response = choiceIndex;
        const promptCount = prompts.length;
        await activate(trigger);
        await until("model reminder for " + trigger + "/" + choice, () => prompts.length === promptCount + 1);
        if (choiceIndex === 2) {
          await pause(150);
          const retained = await evaluate(workspace, model => document.querySelector<HTMLInputElement>("#writer-model")?.value === model && document.querySelector<HTMLInputElement>("#writer-model")?.checkVisibility() === true, draft);
          if (!workspace.isVisible() || !retained || (await stateOf(popup)).config.writers[0].model !== before) throw new Error("Continue editing lost the draft, saved it, or left settings");
          await editModel(before);
        } else {
          await until("settings leave completed after " + choice, () => atDestination(trigger));
          // The destination and the task owner's config update arrive on
          // separate renderer IPC channels; wait for both before comparing.
          const expectedModel = choiceIndex === 0 ? draft : before;
          await until("confirmed model synchronized after " + trigger + "/" + choice, async () => (await stateOf(popup)).config.writers[0].model === expectedModel);
          const saved = (await stateOf(popup)).config.writers[0].model;
          if (saved !== expectedModel) throw new Error("Settings reminder saved/discarded the wrong model");
          await settings();
          if (await evaluate(workspace, () => document.querySelector<HTMLInputElement>("#writer-model")!.value) !== saved) throw new Error("Settings field did not restore the confirmed model");
        }
        cases.push({ trigger, choice, saved: choiceIndex === 0, draftRetained: choiceIndex === 2 });
      }
    }
    await settings();
    const beforeFailure = (await stateOf(popup)).config.writers[0].model;
    await editModel("");
    response = 0;
    const failurePromptCount = prompts.length;
    await activate("panel");
    await until("failed-save reminder invoked", () => prompts.length === failurePromptCount + 1);
    await until("failed save stays in settings with validation", () => evaluate(workspace, () => Boolean(document.querySelector(".form-error")) && document.querySelector<HTMLInputElement>("#writer-model")?.value === ""));
    if (!workspace.isVisible() || popup.isVisible() || (await stateOf(popup)).config.writers[0].model !== beforeFailure) throw new Error("Invalid model save left settings or changed the confirmed model");
    await editModel(originalModel);
    await evaluate(workspace, () => document.querySelector<HTMLButtonElement>(".provider-model-save button")!.click());
    await until("original model restored after settings guard tests", async () => (await stateOf(popup)).config.writers[0].model === originalModel);
    await pause(200);
    const promptCount = prompts.length;
    await evaluate(workspace, () => {
      const input = document.querySelector<HTMLInputElement>("#writer-key-0")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "smoke-unsaved-key-only-placeholder");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pause(100);
    await activate("navigate");
    await until("key-only edit leaves without model reminder", () => atDestination("navigate"));
    if (prompts.length !== promptCount) throw new Error("A Key-only change triggered the model reminder");
    await settings();
    await evaluate(workspace, () => {
      const input = document.querySelector<HTMLInputElement>("#writer-key-0")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await pause(100);
    return { nearbySaveVisible: true, cases, allThreeTriggersAndChoices: cases.length === 9, failedSaveKeepsDraftAndLocation: true, keyOnlyChangeDoesNotRemind: true, dialogs: prompts };
  } finally { dialog.showMessageBox = originalShowMessageBox; }
}

async function checkSupplementPatch(popup: BrowserWindow, workspace: BrowserWindow): Promise<Record<string, unknown>> {
  const target = "Smoke target for next request";
  const input = "桌面自动测试：为独立咖啡店设计会员系统 MVP，不虚构经营数据。";
  await evaluate(popup, () => window.peDesktop!.openWorkspace("tasks"));
  await until("task supplements visible", () => evaluate(workspace, () => Boolean(document.querySelector<HTMLInputElement>("#workspace-target-model")?.checkVisibility())));
  await evaluate(workspace, value => {
    const field = document.querySelector<HTMLInputElement>("#workspace-target-model")!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }, target);
  await pause(100);
  if ((await stateOf(popup)).brief.targetModel === target) throw new Error("Unapplied task draft leaked into owner state");
  await showPanel(popup);
  await evaluate(popup, value => {
    const field = document.querySelector<HTMLTextAreaElement>("#prompt-input")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    const product = Array.from(document.querySelectorAll<HTMLButtonElement>(".pe-direction")).find(button => button.textContent?.includes("产品"));
    if (!product) throw new Error("Product direction missing");
    product.click();
  }, input);
  await until("new popup input and direction", async () => {
    const { brief } = await stateOf(popup);
    return brief.input === input && brief.direction === "product";
  });
  await evaluate(popup, () => window.peDesktop!.openWorkspace("tasks"));
  await evaluate(workspace, expected => {
    if (document.querySelector<HTMLInputElement>("#workspace-target-model")?.value !== expected) throw new Error("Task supplement draft was lost during owner updates");
    const apply = Array.from(document.querySelectorAll<HTMLButtonElement>(".pe-task-card footer button")).find(button => button.textContent?.includes("应用补充"));
    if (!apply || apply.disabled) throw new Error("Task supplement apply action unavailable");
    apply.click();
  }, target);
  await until("supplement patch applied", async () => (await stateOf(popup)).brief.targetModel === target);
  const { brief } = await stateOf(popup);
  if (brief.input !== input || brief.direction !== "product") throw new Error("Applying supplements overwrote newer popup input or direction");
  return { unappliedDraftKept: true, onlySupplementFieldsPatched: true, newerInputAndDirectionPreserved: true };
}

async function captureFullWorkspace(workspace: BrowserWindow, directory: string): Promise<{ width: number; height: number }> {
  // Capture the full settings document, including fields below the fold,
  // without resizing the user's display or persisting a zoom preference.
  const debug = workspace.webContents.debugger;
  debug.attach("1.3");
  try {
    const { cssContentSize } = await debug.sendCommand("Page.getLayoutMetrics") as { cssContentSize: { width: number; height: number } };
    const size = { width: Math.ceil(cssContentSize.width), height: Math.ceil(cssContentSize.height) };
    const screenshot = await debug.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, ...size, scale: 1 } }) as { data: string };
    await writeFile(join(directory, "workspace.png"), Buffer.from(screenshot.data, "base64"));
    return size;
  } finally { debug.detach(); }
}

const APPEARANCE_ATTRIBUTES = ["data-theme", "data-reduce-transparency", "data-reduce-motion", "data-increase-contrast"];

async function glassSceneSnapshot(target: BrowserWindow) {
  return evaluate(target, () => {
    const scene = document.querySelector<HTMLElement>(".pe-kit-scene") as (HTMLElement & { diagnostics?: { mode: string; source: string; error: string | null; sourceError: string | null; surfaces: number; renderer: Record<string, unknown> | null; materials: { name: string | null }[] } }) | null;
    const diagnostics = scene?.diagnostics;
    const renderer = diagnostics?.renderer;
    const root = document.documentElement;
    const expectedOpaque = root.dataset.reduceTransparency === "true" || root.dataset.increaseContrast === "true" || matchMedia("(prefers-reduced-transparency: reduce)").matches || matchMedia("(prefers-contrast: more)").matches || matchMedia("(forced-colors: active)").matches;
    const expectedDark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const lenses = Array.from(scene?.querySelectorAll<HTMLElement>(".pe-kit-lens") || []).filter(lens => lens.checkVisibility());
    const pixel = document.createElement("canvas"); pixel.width = pixel.height = 1;
    const context = pixel.getContext("2d");
    const rgba = (color: string): number[] => {
      if (!context) return [0, 0, 0, 0];
      context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const solid = (color: string) => rgba(color)[3] === 255;
    const composite = (foreground: number[], background: number[]) => foreground.slice(0, 3).map((channel, index) => channel * foreground[3] / 255 + background[index] * (1 - foreground[3] / 255));
    const luminance = (color: number[]) => color.reduce((result, channel, index) => {
      const value = channel / 255;
      return result + (value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][index];
    }, 0);
    const contrast = (foreground: number[], background: number[]) => {
      const first = luminance(foreground), second = luminance(background);
      return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
    };
    // The desktop's native backdrop cannot be sampled through DOM/Canvas.
    // Verify text against both extreme backings instead, using the actual
    // localized reading fills and foreground colors, never a mock wallpaper.
    // Transmission below measures only CSS reading layers over that native
    // backdrop; it does not claim to measure AppKit's optical transmission.
    const reading = Array.from(scene?.querySelectorAll<HTMLElement>("#prompt-input,.result-bubble-prompt>pre,.pe-detail-candidate pre,.pe-library-record,.settings-field input:not(:disabled),.settings-field select:not(:disabled),.shortcut-editor>input:not(:disabled)") || [])
      .filter(element => element.checkVisibility()).map(element => {
        const fills: number[][] = [];
        let ancestor: HTMLElement | null = element;
        let opacity = 1;
        while (ancestor && ancestor !== scene?.parentElement) {
          const style = getComputedStyle(ancestor);
          fills.push(rgba(style.backgroundColor));
          opacity *= Number(style.opacity);
          ancestor = ancestor.parentElement;
        }
        const textStyle = getComputedStyle(element);
        const color = rgba(textStyle.color);
        const ratios = [[0, 0, 0], [255, 255, 255]].map(backing => {
          const background = fills.reduceRight((result, fill) => composite(fill, result), backing);
          const text = composite(color, background);
          return contrast(text, background);
        });
        // Nested translucent fills compound: two 56% fills leave only 19.4%
        // visible, even though either individual layer looks translucent.
        const backgroundTransmission = fills.reduce((remaining, fill) => remaining * (1 - fill[3] / 255), 1);
        // Inspect the content node itself, not the scene's intentional entrance
        // animation. CSS filters/transforms on text would fake glass refraction
        // by distorting what the user is trying to read.
        const textGeometry = element.matches("input,select,textarea,pre") ? {
          transform: textStyle.transform, scale: textStyle.scale, rotate: textStyle.rotate, filter: textStyle.filter,
          undistorted: (textStyle.transform === "none" || new DOMMatrixReadOnly(textStyle.transform).isIdentity)
            && (textStyle.scale === "none" || textStyle.scale.split(/\s+/).every(value => Number(value) === 1))
            && (textStyle.rotate === "none" || Number.parseFloat(textStyle.rotate) === 0)
            && textStyle.filter === "none",
        } : null;
        return { element: element.id || element.className || element.tagName, opacity, minimumContrast: Math.min(...ratios), effectiveFillOpacity: 1 - backgroundTransmission, backgroundTransmission, backgroundFills: fills.filter(fill => fill[3] > 0), textColor: color, textGeometry };
      });
    const shellLenses = Array.from(scene?.querySelectorAll<HTMLElement>(":scope > .pe-kit-surface > .pe-kit-surface-lens") || []).filter(lens => lens.checkVisibility()).map(lens => {
      const style = getComputedStyle(lens), after = getComputedStyle(lens, "::after");
      return { backgroundAlpha: rgba(style.backgroundColor)[3] / 255, backgroundImage: style.backgroundImage, boxShadow: style.boxShadow, after: { content: after.content, backgroundImage: after.backgroundImage, boxShadow: after.boxShadow } };
    });
    const shell = scene?.querySelector<HTMLElement>(":scope > .pe-kit-surface");
    const shellGeometry = [scene, shell, shell?.querySelector<HTMLElement>(":scope > .pe-kit-surface-lens")].filter((element): element is HTMLElement => Boolean(element)).map(element => {
      const style = getComputedStyle(element);
      // Compare CSS layout radii, independent of temporary whole-window scale.
      // Every corner must stay circular and match the native effect geometry.
      return { element: element.className, cornerRadii: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius] };
    });
    return {
      backdrop: scene?.dataset.peKitBackdrop || null, sceneTag: scene?.tagName || null,
      canvasCount: (scene?.querySelectorAll("canvas").length || 0) + (scene?.shadowRoot?.querySelectorAll("canvas").length || 0),
      customOpticalElements: scene?.querySelectorAll("liquid-glass,liquid-glass-scene").length || 0,
      nativeSpanLenses: lenses.length > 0 && lenses.every(lens => lens.tagName === "SPAN"),
      transparentScene: Boolean(scene && rgba(getComputedStyle(scene).backgroundColor)[3] === 0 && getComputedStyle(scene).backgroundImage === "none"),
      transparentDocument: [root, document.body].every(element => rgba(getComputedStyle(element).backgroundColor)[3] === 0 && getComputedStyle(element).backgroundImage === "none"),
      reading, shellLenses, shellGeometry,
      mode: diagnostics?.mode || (scene?.dataset.peKitBackdrop === "native" ? "native" : "unregistered"), source: diagnostics?.source || (scene?.dataset.peKitBackdrop === "native" ? "behind-window" : null),
      error: diagnostics?.error || null, sourceError: diagnostics?.sourceError || null,
      kernel: typeof renderer?.backgroundKernel === "string" ? renderer.backgroundKernel : scene?.getAttribute("kernel") || null,
      renderedSurfaces: diagnostics?.mode === "webgl" && typeof renderer?.surfaces === "number" ? renderer.surfaces : 0,
      registeredSurfaces: diagnostics?.surfaces || 0,
      dpr: typeof renderer?.dpr === "number" ? renderer.dpr : null,
      materials: [...new Set(diagnostics?.materials.map(material => material.name).filter((name): name is string => Boolean(name)) || [])],
      expectedOpaque, expectedDark,
      opaque: scene?.dataset.peKitOpaque === "true", theme: scene?.dataset.peKitTheme || null,
      visibleLenses: lenses.length,
      sourcePixel: (() => { const source = scene?.shadowRoot?.querySelector<HTMLCanvasElement>("#source"); const ctx = source?.getContext("2d"); return ctx && source ? Array.from(ctx.getImageData(Math.floor(source.width / 2), Math.floor(source.height / 2), 1, 1).data) : null; })(),
      fallbackStyles: expectedOpaque ? lenses.map(lens => { const style = getComputedStyle(lens); return {className:lens.className,background:style.backgroundColor,blur:style.backdropFilter,webkit:style.getPropertyValue("-webkit-backdrop-filter"),solid:style.getPropertyValue("--pe-kit-solid")}; }) : [],
      solidFallback: lenses.length > 0 && lenses.every(lens => {
        const style = getComputedStyle(lens);
        return solid(style.backgroundColor) && style.backdropFilter === "none";
      }),
    };
  });
}

async function assertGlassScene(target: BrowserWindow, label: string) {
  let latest = await glassSceneSnapshot(target);
  try {
    await until(label + " glass first frame", async () => {
      latest = await glassSceneSnapshot(target);
      if (latest.error || latest.sourceError) throw new Error(`${label} Liquid Glass rendering failed; WebGL fallback is not a successful optical render: ${JSON.stringify(latest)}`);
      if (latest.backdrop === "native") {
        if (latest.sceneTag !== "DIV" || latest.canvasCount !== 0 || latest.customOpticalElements !== 0 || !latest.nativeSpanLenses || latest.opaque !== latest.expectedOpaque || latest.theme !== (latest.expectedDark ? "dark" : "light")) return false;
        if (!latest.reading.length || latest.reading.some(item => item.minimumContrast < 4.5 || item.opacity < .99 || item.textGeometry?.undistorted === false)) return false;
        if (latest.shellLenses.length !== 1 || latest.shellLenses.some(lens => lens.backgroundImage !== "none" || lens.boxShadow !== "none" || lens.after.backgroundImage !== "none" || lens.after.boxShadow !== "none")) return false;
        if (latest.expectedOpaque) return latest.solidFallback;
        if (latest.reading.some(item => item.effectiveFillOpacity > .70 || item.backgroundTransmission < .30)) return false;
        return latest.transparentScene && latest.transparentDocument && latest.shellLenses.every(lens => lens.backgroundAlpha === 0);
      }
      if (latest.source !== "paint" || latest.kernel !== "variable13" || !latest.registeredSurfaces || latest.opaque !== latest.expectedOpaque || latest.theme !== (latest.expectedDark ? "dark" : "light")) return false;
      if (latest.expectedOpaque) return latest.mode === "css" && latest.solidFallback;
      if (!latest.sourcePixel || (latest.expectedDark ? latest.sourcePixel[0] >= 128 : latest.sourcePixel[0] <= 128)) return false;
      const expectedMaterial = latest.expectedDark ? "clearActiveDark" : "clearActive";
      return latest.mode === "webgl" && latest.renderedSurfaces > 0 && latest.dpr !== null && latest.dpr >= 1 && latest.dpr <= 2 && latest.materials.length > 0 && latest.materials.every(name => name === expectedMaterial);
    });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : label + " glass verification failed"}; last diagnostics: ${JSON.stringify(latest)}`);
  }
  const native = nativeGlassStatus(target);
  if (latest.backdrop === "native" && native.enabled && native.style !== "clear") throw new Error(`${label} uses the wrong native glass style: ${JSON.stringify(native)}`);
  if (latest.backdrop === "native" && native.enabled && (native.cornerRadius !== 40 || latest.shellGeometry.length !== 3 || latest.shellGeometry.some(element => element.cornerRadii.some(radius => radius !== `${native.cornerRadius}px`)))) throw new Error(`${label} CSS shell corners do not match the 40 pt native glass geometry: ${JSON.stringify({ native, shellGeometry: latest.shellGeometry })}`);
  return { ...latest, native };
}

async function assertReducedGlassMotion(target: BrowserWindow) {
  const result = await evaluate(target, async () => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".pe-kit-scene button.pe-kit-button:not(:disabled)")).find(element => element.checkVisibility());
    if (!button) throw new Error("No visible enabled glass button to verify reduced motion");
    const read = () => {
      const style = getComputedStyle(button), bounds = button.getBoundingClientRect();
      return { scale: style.scale, transform: style.transform, width: bounds.width, height: bounds.height };
    };
    const event = (name: string) => new PointerEvent(name, { bubbles: true, pointerType: "mouse", pointerId: 991, isPrimary: true, button: 0 });
    const before = read();
    let hover, press;
    try {
      button.dispatchEvent(event("pointerenter"));
      await new Promise(resolve => setTimeout(resolve, 100)); hover = read();
      button.dispatchEvent(event("pointerdown"));
      await new Promise(resolve => setTimeout(resolve, 100)); press = read();
    } finally { window.dispatchEvent(event("pointerup")); button.dispatchEvent(event("pointerleave")); }
    const unchanged = [hover, press].every(value => value && (value.scale === "none" || Number(value.scale) === 1) && (value.transform === "none" || new DOMMatrixReadOnly(value.transform).isIdentity) && Math.abs(value.width - before.width) < .1 && Math.abs(value.height - before.height) < .1);
    return { unchanged, before, hover, press };
  });
  if (!result.unchanged) throw new Error("Reduced-motion glass button changed shape on hover or press: " + JSON.stringify(result));
  return result;
}

async function captureGlassVariants(target: BrowserWindow, name: string, directory: string) {
  const attributes = await evaluate(target, names => Object.fromEntries(names.map(attribute => [attribute, document.documentElement.getAttribute(attribute)])), APPEARANCE_ATTRIBUTES);
  const results: Record<string, unknown> = {};
  try {
    for (const variant of ["light", "dark", "reduced-transparency", "increased-contrast", "reduced"] as const) {
      await evaluate(target, value => {
        document.documentElement.dataset.theme = value === "dark" ? "dark" : "light";
        document.documentElement.dataset.reduceTransparency = String(value === "reduced-transparency" || value === "reduced");
        document.documentElement.dataset.reduceMotion = String(value === "reduced");
        document.documentElement.dataset.increaseContrast = String(value === "increased-contrast" || value === "reduced");
      }, variant);
      const diagnostics = await assertGlassScene(target, `${name}-${variant}`);
      if ((variant === "light" || variant === "dark") && diagnostics.expectedOpaque) throw new Error(`${name}-${variant} requires normal transparency; a system accessibility preference still requests an opaque fallback: ${JSON.stringify(diagnostics)}`);
      if (variant === "reduced") results.reducedMotion = await assertReducedGlassMotion(target);
      // Native capture may otherwise return a cached compositor frame while the
      // DOM/Canvas already report the next theme or the entrance is still open.
      await until(name + " entrance settled", () => evaluate(target, () => Array.from(document.querySelector(".pe-kit-scene")?.getAnimations() || []).every(animation => animation.playState === "finished" || animation.playState === "idle")));
      await pause(180);
      results[variant] = diagnostics;
      await writeFile(join(directory, `${name}-${variant}.png`), (await target.webContents.capturePage()).toPNG());
    }
    return results;
  } finally {
    await evaluate(target, saved => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === null) document.documentElement.removeAttribute(name); else document.documentElement.setAttribute(name, value);
      }
    }, attributes);
    await assertGlassScene(target, name + " restored appearance");
  }
}

async function captureAppearanceVariants(popup: BrowserWindow, bubble: BrowserWindow, directory: string): Promise<Record<string, unknown>> {
  const windows = [{ window: popup, name: "panel", root: ".pe-panel", controls: ".pe-direction,.compact-results-tab,.generate-button,#prompt-input" }, { window: bubble, name: "result", root: ".pe-result-bubble", controls: ".result-bubble-close,.result-bubble-copy,.result-bubble-retry,.result-bubble-prompt" }];
  const saved = await Promise.all(windows.map(async item => ({ attributes: await evaluate(item.window, names => Object.fromEntries(names.map(name => [name, document.documentElement.getAttribute(name)])), APPEARANCE_ATTRIBUTES), zoom: item.window.webContents.getZoomFactor() })));
  const variants: Record<string, unknown> = {};
  try {
    // Renderer-only overrides never change the user's macOS preferences.
    for (const item of windows) {
      const glass = await captureGlassVariants(item.window, item.name, directory);
      await evaluate(item.window, () => {
        document.documentElement.dataset.theme = "light";
        document.documentElement.dataset.reduceTransparency = "true";
        document.documentElement.dataset.reduceMotion = "true";
        document.documentElement.dataset.increaseContrast = "true";
      });
      await assertGlassScene(item.window, item.name + " zoom fallback");
      const reduced = await evaluate(item.window, selector => {
        const style = getComputedStyle(document.querySelector(selector)!);
        return { background: style.backgroundColor, backdropFilter: style.backdropFilter };
      }, item.root);
      item.window.webContents.setZoomFactor(2);
      await pause(300);
      const zoom = await evaluate(item.window, selectors => {
      const panel = document.querySelector<HTMLElement>(selectors.root)!;
      const documentScroller = document.scrollingElement!;
      const inaccessible: string[] = [];
      const controls = Array.from(document.querySelectorAll<HTMLElement>(selectors.controls)).filter(element => element.checkVisibility());
      for (const control of controls) {
        control.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        const box = control.getBoundingClientRect();
        const viewport = panel.getBoundingClientRect();
        const left = viewport.left + panel.clientLeft;
        const top = viewport.top + panel.clientTop;
        if (box.left < left - 2 || box.right > left + panel.clientWidth + 2 || box.top < top - 2 || box.bottom > top + panel.clientHeight + 2) inaccessible.push(control.getAttribute("aria-label") || control.id || control.textContent || control.className);
      }
      const value = {
        factor: 2, viewport: { width: innerWidth, height: innerHeight }, checkedControls: controls.length,
        outerScrollWidth: documentScroller.scrollWidth, outerClientWidth: documentScroller.clientWidth,
        outerScrollHeight: documentScroller.scrollHeight, outerClientHeight: documentScroller.clientHeight,
        outerScrollTop: documentScroller.scrollTop, outerScrollLeft: documentScroller.scrollLeft,
        panelScrollWidth: panel.scrollWidth, panelClientWidth: panel.clientWidth,
        internalVerticalScrollAvailable: panel.scrollHeight > panel.clientHeight, inaccessible,
      };
      panel.scrollTop = 0;
      return value;
      }, { root: item.root, controls: item.controls });
      await pause(150);
      await writeFile(join(directory, `${item.name}-zoom200.png`), (await item.window.webContents.capturePage()).toPNG());
      if (!zoom.checkedControls || zoom.inaccessible.length || zoom.outerScrollWidth > zoom.outerClientWidth + 2 || zoom.outerScrollHeight > zoom.outerClientHeight + 2 || zoom.outerScrollTop || zoom.outerScrollLeft || zoom.panelScrollWidth > zoom.panelClientWidth + 2) throw new Error(`${item.name} 200% zoom clipped controls or introduced outer scrolling: ` + JSON.stringify(zoom));
      variants[item.name] = { glass, reduced, zoom };
      item.window.webContents.setZoomFactor(saved[windows.indexOf(item)].zoom);
    }
    return { rendererOnlyOverrides: true, ...variants };
  } finally {
    for (const [index, item] of windows.entries()) {
      item.window.webContents.setZoomFactor(saved[index].zoom);
      await evaluate(item.window, attributes => {
        for (const [name, value] of Object.entries(attributes)) {
          if (value === null) document.documentElement.removeAttribute(name); else document.documentElement.setAttribute(name, value);
        }
      }, saved[index].attributes);
    }
  }
}

/** Explicitly enabled in unpackaged development only. No keys or paid calls. */
export async function runDesktopSmoke(
  popup: BrowserWindow,
  directory: string,
  handler: (request: Request) => Promise<Response>,
  getWorkspace?: () => BrowserWindow | null,
): Promise<number> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const aihubmix = process.env.PE_STUDIO_SMOKE_PROVIDER === "aihubmix";
  const report: Record<string, unknown> = { electron: process.versions.electron, provider: aihubmix ? "aihubmix" : "official" };
  const mocked = mockModelTransport(aihubmix);
  const originalCopy = clipboard.writeText;
  let copiedText: string | null = null;
  let generationStarted = false;
  let complete = false;
  // Capture only this test's copy operation, without reading or replacing the
  // user's actual clipboard. Production still takes the real narrow IPC path.
  clipboard.writeText = async (text: string) => { copiedText = text; };
  try {
    if (!getWorkspace) throw new Error("Dual-window smoke requires the workspace getter");
    await reloadRenderer(popup);
    await waitForPanel(popup);
    const initial = await evaluate(popup, async () => {
      const bridge = window.peDesktop!;
      const configResponse = await fetch("/api/config");
      const config = await configResponse.json() as { configured: Record<string, unknown> };
      const invalid = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const shortcut = await bridge.getShortcut();
      const invalidShortcut = await bridge.setShortcut("Q");
      const credentials = await bridge.getCredentials();
      const invalidCredentials = await bridge.saveCredentials({ writers: [], jev: "" } as unknown as Parameters<typeof bridge.saveCredentials>[0]);
      const appearance = await bridge.getAppearance();
      return {
        origin: location.origin, bridgeMethods: Object.keys(bridge).sort(),
        apiConfigStatus: configResponse.status, configContainsOnlyBooleans: Object.values(config.configured).every(value => typeof value === "boolean"),
        invalidGenerationStatus: invalid.status, shortcut, invalidShortcutRejected: !invalidShortcut.ok,
        emptyCredentialStore: !Object.values(credentials.writers).some(Boolean) && !credentials.jev,
        invalidCredentialsRejected: !invalidCredentials.ok, appearance,
      };
    });
    report.renderer = initial;
    if (initial.origin !== APP_ORIGIN || initial.apiConfigStatus !== 200 || !initial.configContainsOnlyBooleans || initial.invalidGenerationStatus !== 400 || !initial.shortcut.registered || !initial.invalidShortcutRejected || !initial.emptyCredentialStore || !initial.invalidCredentialsRejected) throw new Error("Desktop bridge/API checks failed");
    if (Object.values(initial.appearance).some(value => typeof value !== "boolean")) throw new Error("Invalid appearance state");
    const inputBounds = popup.getBounds();
    await pause(300);
    const inputViewport = { ...await evaluate(popup, async () => ({ width: innerWidth, height: innerHeight, appearance: await window.peDesktop!.getAppearance() })), glass: await assertGlassScene(popup, "panel") };
    if (inputViewport.width !== inputBounds.width || inputViewport.height !== inputBounds.height) throw new Error("Native material changed the input renderer viewport: " + JSON.stringify({ viewport: inputViewport, bounds: inputBounds, currentBounds: popup.getBounds() }));
    report.inputViewport = inputViewport;
    const inputArea = screen.getDisplayMatching(inputBounds).workArea;
    if (popup.isAlwaysOnTop() || inputBounds.width !== Math.min(400, inputArea.width) || inputBounds.height !== Math.min(280, inputArea.height)) throw new Error("Compact panel size or stacking is incorrect");
    report.inputWindow = { bounds: inputBounds, alwaysOnTop: popup.isAlwaysOnTop(), appearance: initial.appearance };
    if (process.env.PE_STUDIO_SMOKE_SET_SHORTCUT) {
      const desired = process.env.PE_STUDIO_SMOKE_SET_SHORTCUT;
      const changed = await evaluate(popup, value => window.peDesktop!.setShortcut(value), desired);
      if (!changed.ok || changed.accelerator !== desired) throw new Error("Smoke shortcut change failed");
      report.shortcutChange = changed;
    }

    const workspace = await openSettings(popup, getWorkspace);
    if (workspace.isAlwaysOnTop() || workspace === popup) throw new Error("Workspace is not an independent standard window");
    await pause(300);
    const workspaceContentBounds = workspace.getContentBounds();
    const workspaceViewport = { ...await evaluate(workspace, async () => ({ width: innerWidth, height: innerHeight, appearance: await window.peDesktop!.getAppearance() })), glass: await assertGlassScene(workspace, "workspace") };
    if (workspaceViewport.width !== workspaceContentBounds.width || workspaceViewport.height !== workspaceContentBounds.height) throw new Error("Native material changed the workspace renderer viewport: " + JSON.stringify({ viewport: workspaceViewport, contentBounds: workspaceContentBounds, bounds: workspace.getBounds() }));
    if (inputViewport.appearance.nativeGlass && !inputViewport.appearance.reduceTransparency && !workspaceViewport.appearance.nativeGlass) throw new Error("Workspace did not receive the same native glass material");
    report.workspaceWindow = { bounds: workspace.getBounds(), contentBounds: workspaceContentBounds, alwaysOnTop: workspace.isAlwaysOnTop(), settingsOpenedFromVisibleEntry: true };
    report.workspaceViewport = workspaceViewport;
    const workspaceErrors: string[] = [];
    workspace.webContents.on("console-message", details => { if (details.level === "error" && workspaceErrors.length < 10) workspaceErrors.push(details.message); });
    report.workspaceRendererErrors = workspaceErrors;
    report.workspaceGlassVariants = await captureGlassVariants(workspace, "workspace", directory);
    report.providerSettings = await checkProviderSettings(workspace);
    if (mocked.modelCatalogRequests.length !== 2 || mocked.modelCatalogRequests.some(request => request.method !== "GET" || !request.authenticated) || Object.values(mocked.calls).some(Boolean)) throw new Error("Provider settings performed an unexpected or paid request");
    report.lateCatalogSelection = await checkLateCatalogSelection(workspace, mocked);
    report.settingsModelGuard = await checkSettingsModelGuard(popup, workspace);
    if (Number(mocked.modelCatalogRequests.length) !== 3 || Object.values(mocked.calls).some(Boolean)) throw new Error("Settings guard started an unexpected model generation");
    report.modelDirectoryRequests = [...mocked.modelCatalogRequests];
    if (aihubmix) {
      await configureAiHubMix(workspace);
      await until("AiHubMix public configuration", async () => {
        const state = await stateOf(popup);
        return state.config.writers.length === 3 && state.config.writers.every((writer, i) => writer.protocol === "aihubmix" && writer.model === AIHUBMIX_MODELS[i] && writer.baseUrl === "https://aihubmix.com/v1");
      });
      // Embedded settings deliberately remain open after saving. Wait for its
      // documented remount before editing a new unsaved draft.
      await pause(300);
      report.aihubmixSettings = { freeModelIdPreserved: true, saved: true };
    }
    report.workspaceDraft = await checkWorkspaceDraft(popup, workspace);
    await evaluate(popup, () => window.peDesktop!.openWorkspace("settings"));
    await evaluate(workspace, () => {
      document.querySelector<HTMLButtonElement>("#writer-tab-0")!.click();
      window.scrollTo(0, 0);
    });
    await pause(300);
    report.workspaceScreenshot = await captureFullWorkspace(workspace, directory);
    report.supplementPatch = await checkSupplementPatch(popup, workspace);
    const snapshotBoundary = await evaluate(workspace, async () => {
      const state = await window.peDesktop!.getState();
      if (!state) throw new Error("Workspace did not receive a state snapshot");
      const deniedPublish = await window.peDesktop!.publishState(state);
      const configResponse = await fetch("/api/config");
      const config = await configResponse.json() as { configured: Record<string, unknown> };
      return {
        workspaceCannotPublish: !deniedPublish.ok,
        safeConfig: state.config.writers.every(writer => !("apiKey" in writer)) && !("apiKey" in state.config.judge),
        workspaceApiStatus: configResponse.status,
        workspaceConfigOnlyBooleans: Object.values(config.configured).every(value => typeof value === "boolean"),
      };
    });
    if (!snapshotBoundary.workspaceCannotPublish || !snapshotBoundary.safeConfig || snapshotBoundary.workspaceApiStatus !== 200 || !snapshotBoundary.workspaceConfigOnlyBooleans) throw new Error("Workspace state ownership/API boundary failed");
    report.snapshotBoundary = snapshotBoundary;
    const keyFieldRejected = await evaluate(popup, async marker => {
      const state = await window.peDesktop!.getState();
      if (!state) throw new Error("Owner state was unavailable");
      const invalid = { ...state, config: { ...state.config, writers: state.config.writers.map(writer => ({ ...writer, apiKey: marker })) } };
      const invalidRun = { ...state, runConnections: state.config.writers.map(writer => ({ ...writer, apiKey: marker })) };
      return !(await window.peDesktop!.publishState(invalid)).ok && !(await window.peDesktop!.publishState(invalidRun)).ok;
    }, SMOKE_KEY);
    if (!keyFieldRejected) throw new Error("Public state schema accepted a credential field");
    report.publicKeyFieldRejected = true;
    const runConfig = (await stateOf(popup)).config;
    workspace.hide();
    await showPanel(popup);
    generationStarted = true;
    await evaluate(popup, async () => {
      const input = document.querySelector<HTMLTextAreaElement>("#prompt-input");
      if (!input) throw new Error("Prompt input missing");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "桌面自动测试：为咖啡店写 300 字介绍，不虚构价格。");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 100));
      const originalRandom = Math.random;
      // A deterministic non-identity permutation exercises the exact path that
      // used to confuse fixed backend indices with visible A/B/C positions.
      // This override exists only in the isolated smoke renderer.
      try { Math.random = () => 0; document.querySelector<HTMLButtonElement>(".generate-button")!.click(); }
      finally { Math.random = originalRandom; }
    });
    await until("three writer requests", () => PROVIDERS.every(name => mocked.calls[name] === 1));
    const firstRoundOrder = ["writer-2", "writer-3", "writer-1"];
    await assertRoundOrder(popup, firstRoundOrder);
    report.randomizedRound = { deterministicTestSourceOnly: true, candidateOrder: firstRoundOrder, backendRequestOrderUnchanged: true };
    await evaluate(popup, () => window.peDesktop!.hide());
    await until("panel hidden while writers are pending", () => !popup.isVisible());
    if (!(await stateOf(popup)).running) throw new Error("Hiding stopped the active task");
    const nextConfig = {
      writers: runConfig.writers.map(writer => ({ ...writer, label: writer.label + " · next run" })),
      judge: { ...runConfig.judge, model: "smoke-next-run-judge" },
    };
    const changedDuringRun = await evaluate(workspace, async ({ config, key }) => {
      const saved = await window.peDesktop!.saveCredentials({ writers: Object.fromEntries(config.writers.map(writer => [writer.id, key])), jev: key }, true);
      const command = await window.peDesktop!.sendCommand({ type: "config-updated", config });
      return { applied: saved.applied, persisted: saved.persisted, commandAccepted: command.ok };
    }, { config: nextConfig, key: NEXT_SMOKE_KEY });
    if (!changedDuringRun.applied || changedDuringRun.persisted || !changedDuringRun.commandAccepted) throw new Error("Could not apply session-only configuration during generation");
    await until("next-run configuration synchronized during active request", async () => {
      const state = await stateOf(popup);
      return state.running && state.config.judge.model === nextConfig.judge.model && state.config.writers.every((writer, index) => writer.label === nextConfig.writers[index].label);
    });
    mocked.releaseWriters();
    await until("writers complete while hidden", async () => {
      const state = await stateOf(popup);
      return mocked.calls.jev === 1 && state.session?.candidates.filter(candidate => candidate.status === "success").length === 3;
    });
    if (popup.isVisible()) throw new Error("Writer completion unexpectedly opened the panel");
    const inFlight = await stateOf(popup);
    if (mocked.judgeRequests.length !== 1 || mocked.judgeRequests[0].model !== runConfig.judge.model || !mocked.judgeRequests[0].originalKeyUsed || inFlight.session?.candidates.some(candidate => candidate.provider !== runConfig.writers.find(writer => writer.id === candidate.id)?.label) || JSON.stringify(inFlight.runConnections) !== JSON.stringify(runConfig.writers)) throw new Error("In-flight generation or delayed review used newer configuration/credentials");
    report.hiddenGenerationContinued = true;
    report.runConfigurationSnapshot = { changedWhileRunning: true, newKeysAppliedOnlyToMemory: true, originalWriterLabelsKept: true, delayedJudgeUsedOriginalModelAndKey: true };

    await showPanel(popup);
    await until("three compact model controls", () => evaluate(popup, () => document.querySelectorAll(".compact-results-tab").length === 3 && Boolean(document.querySelector('.compact-results [role="toolbar"]'))));
    await assertResultsCollapsed(popup);
    report.generationDefaultsCollapsed = true;
    report.initialBlindControls = await assertBlindUi(popup, "panel");
    let bubble = await openResult(popup, "writer-2");
    report.initialBlindResult = await assertBlindUi(bubble, "result");
    await until("complete result prompt", () => evaluate(bubble, expected => document.querySelector(".result-bubble-prompt > pre")?.textContent === expected, mocked.prompts.anthropic));
    const beforeJudge = await evaluate(bubble, () => {
      const prompt = document.querySelector<HTMLElement>(".result-bubble-prompt")!;
      prompt.scrollTop = 90;
      prompt.dispatchEvent(new Event("scroll", { bubbles: true }));
      return { id: new URL(location.href).searchParams.get("result"), text: prompt.querySelector("pre")?.textContent, scrollTop: prompt.scrollTop };
    });
    if (beforeJudge.id !== "writer-2" || beforeJudge.text !== mocked.prompts.anthropic || beforeJudge.scrollTop <= 0) throw new Error("Could not read and scroll the complete second result");
    await clickResultControl(popup, await resultPosition(popup, "writer-2"));
    await assertResultVisibility(popup, "writer-2", false);
    if (!popup.isVisible()) throw new Error("Clicking the model name to collapse dismissed the input panel");
    bubble = await openResult(popup, "writer-2");
    if (await evaluate(bubble, () => document.querySelector<HTMLElement>(".result-bubble-prompt")?.scrollTop) !== beforeJudge.scrollTop) throw new Error("Toggling a result lost its reading position");
    report.modelClickToggle = { firstClickOpens: true, secondClickCollapses: true, disclosureTracksNativeVisibility: true, reopeningPreservesScroll: true };
    report.resultBoundary = await checkResultBoundary(bubble);
    await evaluate(popup, () => window.peDesktop!.hide());
    await until("group hidden before late review", () => !popup.isVisible() && !bubble.isVisible());
    mocked.releaseJudge();
    await until("complete review persisted while hidden", async () => {
      const state = await stateOf(popup);
      return !state.running && state.session?.judge?.status === "complete" && state.history.some(record => record.id === state.session?.id);
    });
    const finished = await stateOf(popup);
    const result = finished.session!;
    await assertRoundOrder(popup, firstRoundOrder);
    await assertDisplayedAssociations(popup, false);
    if (popup.isVisible() || bubble.isVisible() || resultWindow("writer-1")?.isVisible() || result.judge?.recommendedId !== "writer-1" || PROVIDERS.some(name => mocked.calls[name] !== 1) || mocked.calls.jev !== 1) throw new Error("Hidden completion, recommendation or request count was incorrect");
    await showPanel(popup);
    await until("second result restored", () => bubble.isVisible());
    const afterJudge = await evaluate(bubble, () => ({
      id: new URL(location.href).searchParams.get("result"),
      text: document.querySelector(".result-bubble-prompt > pre")?.textContent,
      scrollTop: document.querySelector<HTMLElement>(".result-bubble-prompt")?.scrollTop,
    }));
    const modelControls = await evaluate(popup, () => Array.from(document.querySelectorAll(".compact-results-tab")).map(button => ({ label: button.getAttribute("aria-label"), selected: button.getAttribute("aria-pressed") === "true" })));
    if (afterJudge.id !== "writer-2" || afterJudge.text !== beforeJudge.text || afterJudge.scrollTop !== beforeJudge.scrollTop || !modelControls[firstRoundOrder.indexOf("writer-2")]?.selected || !modelControls[firstRoundOrder.indexOf("writer-1")]?.label?.includes("推荐")) throw new Error("Late recommendation disturbed the active reader or used a backend slot as the blind position");
    const secondScore = result.judge?.candidates.find(candidate => candidate.candidateId === "writer-2");
    if (!secondScore || secondScore.eligible || secondScore.score <= 80) throw new Error("The qualification fixture must keep an honest high score without recommendation");
    await assertNoQualificationLabels(popup);
    await assertNoQualificationLabels(bubble);
    await evaluate(bubble, () => document.querySelector<HTMLButtonElement>(".result-bubble-copy")!.click());
    await until("complete clipboard copy", () => copiedText !== null);
    if (copiedText !== mocked.prompts.anthropic) throw new Error("Copy did not contain the full selected prompt");
    // The group reveal temporarily disables native material during its 220 ms
    // entrance animation. Verify the stable native surface, not that transition.
    await pause(300);
    const resultBounds = bubble.getBounds();
    const resultViewport = { ...await evaluate(bubble, async () => ({ width: innerWidth, height: innerHeight, appearance: await window.peDesktop!.getAppearance() })), glass: await assertGlassScene(bubble, "result") };
    if (resultViewport.width !== resultBounds.width || resultViewport.height !== resultBounds.height) throw new Error("Native material changed the result renderer viewport");
    if (inputViewport.appearance.nativeGlass && !inputViewport.appearance.reduceTransparency && !resultViewport.appearance.nativeGlass) throw new Error("Result native glass did not recover after its reveal animation");
    report.resultViewport = resultViewport;
    const resultArea = screen.getDisplayMatching(resultBounds).workArea;
    if (resultBounds.width !== Math.min(360, resultArea.width) || resultBounds.height !== Math.min(420, resultArea.height) || bubble.isAlwaysOnTop() || popup.getBounds().width !== inputBounds.width || popup.getBounds().height !== inputBounds.height) throw new Error("Independent result size/stacking or main panel size is incorrect");
    const beforeReveal = await stateOf(popup);
    await revealModels(popup);
    report.panelModelMarks = await checkModelMarks(popup, ".compact-results-brand > .model-logo", 3);
    report.resultModelMark = await checkModelMarks(bubble, ".result-bubble-identity strong > .model-logo", 1);
    const afterReveal = await stateOf(popup);
    await assertRoundOrder(popup, firstRoundOrder);
    await assertDisplayedAssociations(popup, true);
    if (!afterReveal.modelsRevealed || JSON.stringify(beforeReveal.session?.judge) !== JSON.stringify(afterReveal.session?.judge) || JSON.stringify(beforeReveal.runConnections) !== JSON.stringify(afterReveal.runConnections)) throw new Error("Revealing models changed score/model associations");
    report.blindReveal = { revealsAllThree: true, shuffledScoreAndModelAssociationsCorrect: true, scoreAndModelAssociationsUnchanged: true };
    report.singleResultSwitching = await checkSingleResultSwitching(popup);
    bubble = await openResult(popup, "writer-2");
    report.groupWindows = await checkGroupWindows(popup, bubble, workspace);
    if (await evaluate(bubble, () => document.querySelector<HTMLElement>(".result-bubble-prompt")?.scrollTop) !== beforeJudge.scrollTop) throw new Error("Group focus or movement reset result reading position");
    await evaluate(bubble, () => document.querySelector<HTMLButtonElement>(".result-bubble-close")!.click());
    await until("closing one result", () => !bubble.isVisible());
    await assertResultVisibility(popup, "writer-2", false);
    if (!popup.isVisible()) throw new Error("Closing a result dismissed the input panel");
    bubble = await openResult(popup, "writer-2");
    if (await evaluate(bubble, () => document.querySelector<HTMLElement>(".result-bubble-prompt")?.scrollTop) !== beforeJudge.scrollTop) throw new Error("Reopening the same result lost its scroll position");
    report.fullChain = {
      sessionId: result.id, successfulCandidates: result.candidates.filter(candidate => candidate.status === "success").length,
      scoredCandidates: result.judge?.candidates.length, recommendedId: result.judge?.recommendedId,
      hiddenCompletionDidNotShow: true, lateReviewKeptSelectedCandidate: true, selectedStableId: "writer-2", selectedLetter: "A", readingScrollPreserved: true, fullPromptCopied: true,
      resultBounds, modelControls, singleCloseKeepsPanel: true, highScoreWithoutQualificationBadge: true,
    };
    // Keep the first chain's exact four calls stable when later recovery tests run.
    report.mockUpstreamCalls = { ...mocked.calls };
    if (aihubmix) report.aihubmixRequests = mocked.writerRequests.map(request => ({ ...request }));
    const restored = await evaluate(workspace, async config => {
      const saved = await window.peDesktop!.saveCredentials({ writers: Object.fromEntries(config.writers.map(writer => [writer.id, ""])), jev: "" }, true);
      const command = await window.peDesktop!.sendCommand({ type: "config-updated", config });
      return saved.applied && !saved.persisted && command.ok;
    }, runConfig);
    if (!restored) throw new Error("Could not restore smoke's original empty credential configuration");
    await until("original configuration restored", async () => JSON.stringify((await stateOf(popup)).config) === JSON.stringify(runConfig));
    const safeStorage = await evaluate(popup, markers => !Object.values(localStorage).some(value => markers.some(marker => value.includes(marker)) || /"apiKey"\s*:/.test(value)), [SMOKE_KEY, NEXT_SMOKE_KEY, ...PROVIDER_DRAFT_KEYS]);
    if (!safeStorage) throw new Error("Credential entered renderer storage");
    report.publicStateAndStorageExcludeKeys = true;
    await pause(300);
    await writeFile(join(directory, "results.png"), (await bubble.webContents.capturePage()).toPNG());
    await writeFile(join(directory, "panel-results.png"), (await popup.webContents.capturePage()).toPNG());
    await evaluate(popup, () => window.peDesktop!.openWorkspace("library"));
    await until("history candidate details", () => evaluate(workspace, () => Array.from(document.querySelectorAll(".pe-detail-candidate")).filter(element => element.checkVisibility()).length === 3));
    await assertNoQualificationLabels(workspace);
    const historyOrder = await evaluate(workspace, ({ order, candidates }) => {
      const cards = Array.from(document.querySelectorAll<HTMLElement>(".pe-detail-candidate")).filter(element => element.checkVisibility());
      const blindLetters = cards.map(card => card.querySelector("header strong")?.textContent?.trim()).join(",");
      const reveal = Array.from(document.querySelectorAll<HTMLButtonElement>(".pe-history-tools button")).find(button => button.textContent === "显示模型");
      if (!reveal || blindLetters !== "A,B,C") return { blindLetters, revealAvailable: Boolean(reveal), expectedModels: [] as string[] };
      reveal.click();
      return { blindLetters, revealAvailable: true, expectedModels: order.map(id => candidates.find(candidate => candidate.id === id)!.model) };
    }, { order: firstRoundOrder, candidates: result.candidates });
    if (historyOrder.blindLetters !== "A,B,C" || !historyOrder.revealAvailable) throw new Error("Saved history lost the round's blind labels");
    await until("history reveal preserves shuffled identities", () => evaluate(workspace, expected => Array.from(document.querySelectorAll<HTMLElement>(".pe-detail-candidate")).filter(element => element.checkVisibility()).map(card => card.querySelector("header strong")?.getAttribute("title")).join(",") === expected.join(","), historyOrder.expectedModels));
    report.historyBlindOrder = { lettersInSavedRoundOrder: true, revealedModelsCorrect: true };
    report.historyQualificationLabelsRemoved = true;
    report.historyGlassVariants = await captureGlassVariants(workspace, "history", directory);
    await showPanel(popup);
    bubble = await openResult(popup, "writer-2");
    report.appearanceVariants = await captureAppearanceVariants(popup, bubble, directory);
    await reloadRenderer(popup);
    await waitForPanel(popup);
    const reloaded = await stateOf(popup);
    if (!reloaded.history.some(record => record.id === result.id && record.judge?.status === "complete" && JSON.stringify(record.candidateOrder) === JSON.stringify(firstRoundOrder))) throw new Error("History or its blind order did not survive reload");
    const persistedHistory = await evaluate(popup, ({ id, order }) => {
      const history = JSON.parse(localStorage.getItem("pe-studio.sessions.v1") || "[]") as { id: string; judge?: { status: string }; candidateOrder?: string[] }[];
      return history.some(record => record.id === id && record.judge?.status === "complete" && JSON.stringify(record.candidateOrder) === JSON.stringify(order));
    }, { id: result.id, order: firstRoundOrder });
    if (!persistedHistory) throw new Error("Completed history was missing from persistent renderer storage");
    if (aihubmix && reloaded.config.writers.some((writer, i) => writer.protocol !== "aihubmix" || writer.model !== AIHUBMIX_MODELS[i])) throw new Error("AiHubMix settings did not survive reload");
    report.historySurvivedReload = true;
    await evaluate(workspace, id => window.peDesktop!.sendCommand({ type: "restore-session", id }), result.id);
    await until("saved round restored after reload", async () => (await stateOf(popup)).session?.id === result.id);
    await assertRoundOrder(popup, firstRoundOrder);
    if ((await stateOf(popup)).modelsRevealed) throw new Error("Restoring a round after reload revealed model identities automatically");
    report.blindOrderSurvivedReloadAndRestore = true;
    report.aihubmixSettingsSurvivedReload = aihubmix || undefined;
    report.writerFailureRetry = await checkWriterFailureRetry(popup, workspace, mocked, directory);
    if (aihubmix) report.claudeFailureRetry = await checkWriterFailureRetry(popup, workspace, mocked, directory, "anthropic");
    if (!await evaluate(popup, markers => !Object.values(localStorage).some(value => markers.some(marker => value.includes(marker)) || /"apiKey"\s*:/.test(value)), [SMOKE_KEY, NEXT_SMOKE_KEY, ...PROVIDER_DRAFT_KEYS])) throw new Error("Failure recovery persisted a credential");
    const unauthorized = await handler(new Request(APP_ORIGIN + "/api/config"));
    if (unauthorized.status !== 403) throw new Error("Unauthorized API access was accepted");
    report.unauthorizedApiStatus = unauthorized.status;
    popup.close();
    await until("closing panel hides without destruction", () => !popup.isVisible());
    if (popup.isDestroyed()) throw new Error("Close destroyed the persistent task owner");
    report.closeHidesWithoutDestroy = true;
    await showPanel(popup);
    await pause(300);
    await writeFile(join(directory, "window.png"), (await popup.webContents.capturePage()).toPNG());
    if (workspaceErrors.length) throw new Error("Unexpected workspace renderer errors: " + workspaceErrors.join("; "));
    report.ok = true;
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
    complete = true;
    return 0;
  } catch (error) {
    report.ok = false;
    report.error = error instanceof Error ? error.message : "Desktop smoke failed";
    const workspace = getWorkspace?.();
    if (workspace && !workspace.isDestroyed()) {
      report.workspaceFailure = await evaluate(workspace, () => ({ rootChildren:document.querySelector("#root")?.childElementCount, bodyText:document.body.innerText.slice(0,1000), readyState:document.readyState })).catch(() => null);
    }
    report.catalogRequestsBeforeFailure = mocked.modelCatalogRequests;
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
    return 1;
  } finally {
    clipboard.writeText = originalCopy;
    mocked.close();
    // Main exits this isolated process after smoke returns. On a mid-run error,
    // keep a fail-closed transport until exit: late renderer work must never use
    // a restored real fetch. Restore the original transport only when idle.
    mocked.restore(!generationStarted || complete);
  }
}
