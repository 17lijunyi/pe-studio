"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { ArrowDown, ArrowRight, Check, ChevronDown, CircleHelp, Clock3, Command, Film, History, ImageIcon, Layers3, Plus, Settings2, ShieldCheck, Sparkles, Square, Star, Trash2, WandSparkles, X } from "lucide-react";
import { DEFAULT_CONNECTIONS, DEFAULT_JUDGE, DIRECTION_LABELS, type Brief, type Candidate, type CandidateScore, type Connection, type Direction, type JudgeConnection, type JudgeReport, type SessionRecord } from "@/lib/types";
import { DIRECTION_PRESETS } from "@/lib/prompts";
import { createCandidateOrder } from "@/lib/blind-order";
import { DEMO_SESSION } from "@/lib/demo";
import { AIHUBMIX_BASE_URL, normalizeAiHubMixBase } from "@/lib/aihubmix";
import { SettingsDialog, type ServerConfig } from "@/components/studio/settings-dialog";
import { CompactResults, Results } from "@/components/studio/results";

import type { PublicStudioState, WorkspaceCommand } from "@/desktop/workspace-contract";
import { useDesktopAppearance } from "@/components/studio/use-desktop-appearance";

const EMPTY_BRIEF: Brief = { direction: "general", input: "", targetModel: "", context: "", constraints: "", intensity: "balanced", outputLanguage: "zh" };
const STORAGE_KEY = "pe-studio.sessions.v1";
const CONFIG_KEY = "pe-studio.config.v1";
const directions = [
  { id: "general" as Direction, icon: Sparkles, subtitle: "清楚表达，让回答更到位", number: "01" },
  { id: "image" as Direction, icon: ImageIcon, subtitle: "把脑海里的画面说具体", number: "02" },
  { id: "video" as Direction, icon: Film, subtitle: "从一个想法，到一段镜头", number: "03" },
  { id: "product" as Direction, icon: Layers3, subtitle: "让产品想法具备可执行性", number: "04" },
];
const createId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "请求未完成，请稍后重试。";
const dateLabel = (date: string) => new Date(date).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function parseCandidate(value: unknown): Candidate {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.provider !== "string" || typeof value.model !== "string" || typeof value.prompt !== "string" || !isStrings(value.changes) || !isStrings(value.assumptions) || !["success", "error"].includes(String(value.status)) || !isFiniteNumber(value.latencyMs)) throw new Error("模型返回格式不完整，请重试。");
  return { id: value.id, provider: value.provider, model: value.model, prompt: value.prompt, changes: value.changes, assumptions: value.assumptions, status: value.status === "success" ? "success" : "error", error: typeof value.error === "string" ? value.error : undefined, latencyMs: value.latencyMs };
}
function parseJudge(value: unknown): JudgeReport {
  if (!isRecord(value) || (value.status !== "complete" && value.status !== "unavailable") || !Array.isArray(value.candidates) || (value.recommendedId !== null && typeof value.recommendedId !== "string") || !isStrings(value.tiedIds) || typeof value.summary !== "string" || typeof value.evaluatedAt !== "string") throw new Error("评审返回格式不完整，当前结果未评分。");
  const candidates: CandidateScore[] = value.candidates.map(raw => {
    if (!isRecord(raw) || typeof raw.candidateId !== "string" || !isFiniteNumber(raw.score) || !Array.isArray(raw.dimensions) || typeof raw.eligible !== "boolean" || !isStrings(raw.violations)) throw new Error("候选评分格式不完整，请重新评审。");
    const dimensions = raw.dimensions.map(d => {
      if (!isRecord(d) || typeof d.id !== "string" || typeof d.label !== "string" || !isFiniteNumber(d.score) || !isFiniteNumber(d.confidence)) throw new Error("评分维度格式不完整，请重新评审。");
      return { id: d.id, label: d.label, score: d.score, confidence: d.confidence };
    });
    return { candidateId: raw.candidateId, score: raw.score, dimensions, eligible: raw.eligible, violations: raw.violations };
  });
  return { status: value.status, candidates, recommendedId: value.recommendedId, tiedIds: value.tiedIds, summary: value.summary, evaluatedAt: value.evaluatedAt, model: typeof value.model === "string" ? value.model : undefined };
}

// Explicit persistence schema: credentials can never enter a session record.
function cleanRecord(record: SessionRecord): SessionRecord {
  return {
    id: record.id, createdAt: record.createdAt,
    ...(Array.isArray(record.candidateOrder) && record.candidateOrder.length > 0 && record.candidateOrder.length <= 3 && new Set(record.candidateOrder).size === record.candidateOrder.length && record.candidateOrder.every(id => /^(?:writer-[123]|demo-[abc])$/.test(id)) ? { candidateOrder: [...record.candidateOrder] } : {}),
    brief: { direction: record.brief.direction, input: record.brief.input, targetModel: record.brief.targetModel, context: record.brief.context, constraints: record.brief.constraints, intensity: record.brief.intensity, outputLanguage: record.brief.outputLanguage },
    ...(Array.isArray(record.connectionSnapshot) && record.connectionSnapshot.length <= 3 ? { connectionSnapshot: record.connectionSnapshot.map(({ id, label, protocol, model, baseUrl }) => ({ id, label, protocol, model, baseUrl })) } : {}),
    candidates: record.candidates.map(c => ({ id: c.id, provider: c.provider, model: c.model, prompt: c.prompt, changes: c.changes, assumptions: c.assumptions, status: c.status, error: c.error, latencyMs: c.latencyMs })),
    judge: record.judge ? { status: record.judge.status, candidates: record.judge.candidates.map(c => ({ candidateId: c.candidateId, score: c.score, dimensions: c.dimensions.map(d => ({ id: d.id, label: d.label, score: d.score, confidence: d.confidence })), eligible: c.eligible, violations: c.violations })), recommendedId: record.judge.recommendedId, tiedIds: record.judge.tiedIds, summary: record.judge.summary, model: record.judge.model, evaluatedAt: record.judge.evaluatedAt } : null,
    demo: Boolean(record.demo), favorite: Boolean(record.favorite),
  };
}
function readRecords(): SessionRecord[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(r => r && typeof r.id === "string" && typeof r.createdAt === "string" && r.brief && typeof r.brief.input === "string" && directions.some(d => d.id === r.brief.direction) && Array.isArray(r.candidates) && r.candidates.every((c: Candidate) => c && typeof c.id === "string" && typeof c.prompt === "string" && Array.isArray(c.changes) && Array.isArray(c.assumptions))).slice(0, 20).flatMap(r => { try { return [cleanRecord(r)]; } catch { return []; } });
  } catch { return []; }
}

export default function Home() {
  const appearance = useDesktopAppearance();
  const panelRef = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const runConnectionsRef = useRef<Connection[]>([]);
  const runConnectionsSessionRef = useRef<string | null>(null);
  const [modelsRevealed, setModelsRevealed] = useState(false);
  const [activeResult, setActiveResult] = useState<{ sessionId: string; id: string } | null>(null);
  const [resultVisibility, setResultVisibility] = useState<{ sessionId: string | null; visibleIds: string[] }>({ sessionId: null, visibleIds: [] });
  const [configSyncing, setConfigSyncing] = useState(false);
  const configSyncRef = useRef({ sequence: 0, syncing: false });
  const [runConnections, setRunConnections] = useState<Connection[]>([]);
  const [brief, setBrief] = useState<Brief>(EMPTY_BRIEF);
  const [connections, setConnections] = useState<Connection[]>(DEFAULT_CONNECTIONS.map(c => ({ ...c })));
  const [judgeConnection, setJudgeConnection] = useState<JudgeConnection>({ ...DEFAULT_JUDGE });
  const [serverConfig, setServerConfig] = useState<ServerConfig>({});
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState<"history" | "favorites" | null>(null);
  const [history, setHistory] = useState<SessionRecord[]>([]);
  const [session, setSession] = useState<SessionRecord | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [judging, setJudging] = useState(false);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [contextOpen, setContextOpen] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== "undefined" && Boolean(window.peDesktop?.isDesktop));
  const [shortcut, setShortcut] = useState("Control+Q");
  const [credentialsStatus, setCredentialsStatus] = useState<"loading" | "ready" | "failed">("ready");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const requestRef = useRef<{ token: number; controller: AbortController | null }>({ token: 0, controller: null });
  const sessionRef = useRef<SessionRecord | null>(null);
  const updateSession = useCallback((value: SessionRecord | null) => { sessionRef.current = value; setSession(value); }, []);
  const updateBrief = <K extends keyof Brief>(key: K, value: Brief[K]) => setBrief(old => ({ ...old, [key]: value }));

  useEffect(() => {
    // Browser-owned storage is hydrated after mount; it is unavailable during SSR.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory(readRecords());
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) || "null");
      if (saved && Array.isArray(saved.writers)) setConnections(DEFAULT_CONNECTIONS.map((fallback, i) => {
        const c = saved.writers[i];
        if (!c || !["openai-responses", "openai-compatible", "anthropic", "gemini", "aihubmix", "deepseek", "local-agent"].includes(c.protocol)) return { ...fallback };
        return { id: fallback.id, label: typeof c.label === "string" ? c.label : fallback.label, protocol: c.protocol, model: typeof c.model === "string" ? c.model : fallback.model, baseUrl: typeof c.baseUrl === "string" ? c.baseUrl : fallback.baseUrl, apiKey: "" };
      }));
      if (saved?.judge && typeof saved.judge.model === "string" && typeof saved.judge.baseUrl === "string") setJudgeConnection({ model: saved.judge.model, baseUrl: saved.judge.baseUrl, apiKey: "" });
    } catch { /* Invalid preferences fall back to defaults. */ }
    setStorageReady(true);
    const controller = new AbortController();
    fetch("/api/config", { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(data => { if (isRecord(data) && isRecord(data.configured)) setServerConfig({ openai: data.configured.openai === true, anthropic: data.configured.anthropic === true, gemini: data.configured.gemini === true, deepseek: data.configured.deepseek === true, aihubmix: data.configured.aihubmix === true, jev: data.configured.jev === true }); }).catch(() => {});
    const desktop = window.peDesktop;
    let removeShow: (() => void) | undefined;
    let removeSettings: (() => void) | undefined;
    let removeVisibility: (() => void) | undefined;
    if (desktop?.isDesktop) {
      setIsDesktop(true);
      setCredentialsStatus("loading");
      desktop.getCredentials().then(keys => {
        if (controller.signal.aborted) return;
        setConnections(old => old.map(c => ({ ...c, apiKey: keys.writers[c.id] || "" })));
        setJudgeConnection(old => ({ ...old, apiKey: keys.jev || "" }));
        setCredentialsStatus("ready");
      }).catch(() => { if (!controller.signal.aborted) { setCredentialsStatus("failed"); setNotice("未能读取已保存的密钥。本次修改只用于当前会话，不会覆盖原有密钥。"); } });
      desktop.getShortcut().then(result => { if (!controller.signal.aborted) setShortcut(result.accelerator); }).catch(() => {});
      // The native windows own visibility, including closes caused by dragging
      // or focus changes. An older initial snapshot must not replace an event.
      let receivedVisibility = false;
      removeVisibility = desktop.onResultVisibilityChanged(value => {
        receivedVisibility = true;
        if (!controller.signal.aborted) setResultVisibility(value);
      });
      desktop.getResultVisibility().then(value => {
        if (!receivedVisibility && !controller.signal.aborted) setResultVisibility(value);
      }).catch(() => {});
      removeShow = desktop.onShow(() => {
        setClosing(false);
        if (panelRef.current) {
          panelRef.current.style.animation = "none";
          requestAnimationFrame(() => { if (panelRef.current) panelRef.current.style.animation = ""; });
        }
        textareaRef.current?.focus({ preventScroll: true });
      });
      removeSettings = desktop.onHide(() => setClosing(true));
    }
    return () => { controller.abort(); requestRef.current.controller?.abort(); removeShow?.(); removeSettings?.(); removeVisibility?.(); };
  }, []);
  useEffect(() => {
    if (!storageReady) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history.map(cleanRecord).slice(0, 20))); }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    catch { setStorageError("浏览器存储不可用，本次结果仍可复制或导出。"); }
  }, [history, storageReady]);
  useEffect(() => {
    if (!storageReady) return;
    const safe = { writers: connections.map(({ id, label, protocol, model, baseUrl }) => ({ id, label, protocol, model, baseUrl })), judge: { model: judgeConnection.model, baseUrl: judgeConnection.baseUrl } };
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(safe)); } catch { /* Preferences remain in memory. */ }
  }, [connections, judgeConnection.model, judgeConnection.baseUrl, storageReady]);
  useEffect(() => {
    if (!session || session.demo || running || session.candidates.length === 0) return;
    // Persist one completed record for retries and favorite updates.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory(old => [cleanRecord(session), ...old.filter(s => s.id !== session.id)].slice(0, 20));
  }, [session, running]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 4800); return () => clearTimeout(timer); }, [notice]);

  function connectionReady(c: Connection) {
    if (c.protocol === "local-agent") return Boolean(window.peDesktop && /^local:\/\/(codex|claude|pi|hermes)$/.test(c.baseUrl));
    if (c.apiKey.trim()) return true;
    if (c.protocol === "aihubmix") {
      try { return normalizeAiHubMixBase(c.baseUrl) === AIHUBMIX_BASE_URL && Boolean(serverConfig.aihubmix); }
      catch { return false; }
    }
    if (c.protocol === "deepseek") return /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(c.baseUrl) && Boolean(serverConfig.deepseek);
    const legacyBase = c.protocol === "anthropic" ? "https://api.anthropic.com/v1" : c.protocol === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.openai.com/v1";
    return c.baseUrl.replace(/\/$/, "") === legacyBase && Boolean(serverConfig[c.protocol === "anthropic" ? "anthropic" : c.protocol === "gemini" ? "gemini" : "openai"]);
  }
  function beginRequest() {
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    const token = requestRef.current.token + 1;
    requestRef.current = { token, controller };
    return { token, controller };
  }
  function isCurrent(token: number) { return token === requestRef.current.token && !requestRef.current.controller?.signal.aborted; }
  function stopRun(showNotice = true) {
    requestRef.current.controller?.abort(); requestRef.current.token += 1;
    const current = sessionRef.current;
    let stopped = current;
    if (current && pending.length) {
      const canceled = pending.filter(id => !current.candidates.some(c => c.id === id)).map(id => {
        const activeConnections = runConnectionsRef.current.length ? runConnectionsRef.current : connections;
        const c = activeConnections.find(c => c.id === id) || activeConnections[0];
        return { id, provider: c.label, model: c.model, prompt: "", changes: [], assumptions: [], status: "error" as const, error: "已取消，可单独重试。", latencyMs: 0 };
      });
      stopped = { ...current, candidates: [...current.candidates, ...canceled] };
      updateSession(stopped);
    }
    if (stopped && !stopped.demo && stopped.candidates.length) {
      const record = cleanRecord(stopped);
      setHistory(old => [record, ...old.filter(s => s.id !== record.id)].slice(0, 20));
    }
    setRunning(false); setJudging(false); setPending([]);
    if (showNotice) setNotice("已停止等待，完成的结果已保留。上游请求可能已经产生费用。");
  }
  async function generateOne(currentBrief: Brief, connection: Connection, signal: AbortSignal): Promise<Candidate> {
    const start = Date.now();
    try {
      if (connection.protocol === "local-agent") {
        const desktop = window.peDesktop;
        if (!desktop) throw new Error("本地 Agent 仅在 macOS App 中可用。");
        const requestId = createId();
        const cancel = () => { void desktop.cancelLocal(requestId); };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          if (signal.aborted) throw new Error("已取消。");
          return parseCandidate(await desktop.generateLocal(requestId, currentBrief, connection));
        } finally { signal.removeEventListener("abort", cancel); }
      }
      const response = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief: currentBrief, connection }), signal });
      const data = await response.json();
      if (!response.ok) throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : `生成请求失败（${response.status}）`);
      return { ...parseCandidate(data), id: connection.id };
    } catch (error) {
      if (signal.aborted) throw error;
      return { id: connection.id, provider: connection.label, model: connection.model, prompt: "", changes: [], assumptions: [], status: "error", error: errorMessage(error), latencyMs: Date.now() - start };
    }
  }
  async function judgeCandidates(current: SessionRecord, token: number, signal: AbortSignal) {
    if (!isCurrent(token)) return;
    const successful = current.candidates.filter(c => c.status === "success");
    if (successful.length < 1) {
      updateSession({ ...current, judge: { status: "unavailable", candidates: [], recommendedId: null, tiedIds: [], summary: "尚无成功的候选提示词。重试失败的模型后即可评审；单份候选可评分，但不比较推荐。", evaluatedAt: new Date().toISOString() } });
      return;
    }
    setJudging(true);
    try {
      const response = await fetch("/api/judge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief: current.brief, candidates: successful, connection: judgeConnection }), signal });
      const data = await response.json();
      if (!response.ok) throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : `评审请求失败（${response.status}）`);
      const report = parseJudge(data);
      if (isCurrent(token)) updateSession({ ...current, judge: report });
    } catch (error) {
      if (isCurrent(token)) updateSession({ ...current, judge: { status: "unavailable", candidates: [], recommendedId: null, tiedIds: [], summary: errorMessage(error), evaluatedAt: new Date().toISOString() } });
    } finally { if (isCurrent(token)) setJudging(false); }
  }
  async function startGeneration() {
    if (configSyncRef.current.syncing || credentialsStatus === "loading") return;
    if (!brief.input.trim()) { textareaRef.current?.focus(); setNotice("先写下你想完成的事，随手一句也可以。"); return; }
    if (!connections.some(connectionReady)) { openModelSettings(); setNotice("连接至少一个生成模型后，就可以开始。"); return; }
    const { token, controller } = beginRequest();
    setModelsRevealed(false);
    runConnectionsRef.current = connections.map(c => ({ ...c }));
    setRunConnections(runConnectionsRef.current);
    const current: SessionRecord = { candidateOrder: createCandidateOrder(connections.map(c => c.id)), connectionSnapshot: connections.map(({ id, label, protocol, model, baseUrl }) => ({ id, label, protocol, model, baseUrl })), id: createId(), createdAt: new Date().toISOString(), brief: { ...brief, input: brief.input.trim() }, candidates: [], judge: null, demo: false, favorite: false };
    runConnectionsSessionRef.current = current.id;
    updateSession(current); setPending(connections.map(c => c.id)); setRunning(true); setJudging(false); setNotice("");
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    try {
      const candidates = await Promise.all(connections.map(async connection => {
        const candidate = await generateOne(current.brief, connection, controller.signal);
        if (isCurrent(token)) {
          const latest = sessionRef.current || current;
          updateSession({ ...latest, candidates: [...latest.candidates.filter(c => c.id !== candidate.id), candidate] });
          setPending(ids => ids.filter(id => id !== connection.id));
        }
        return candidate;
      }));
      if (isCurrent(token)) await judgeCandidates({ ...current, candidates }, token, controller.signal);
    } catch { /* Cancellation is handled by stopRun. */ }
    finally { if (isCurrent(token)) { setPending([]); setRunning(false); setJudging(false); } }
  }
  async function retryCandidate(id: string) {
    const current = sessionRef.current;
    if (!current || current.demo || running) return;
    const configured = connections.find(c => c.id === id);
    const original = current.connectionSnapshot?.find(c => c.id === id)
      || (runConnectionsSessionRef.current === current.id ? runConnectionsRef.current.find(c => c.id === id) : undefined);
    if (!original) { setNotice("这条旧记录未保存原连接信息，请开启新一轮生成；已有提示词仍保留。"); return; }
    const sameTuple = (a: Pick<Connection, "protocol" | "model" | "baseUrl">, b: Pick<Connection, "protocol" | "model" | "baseUrl">) => a.protocol === b.protocol && a.model === b.model && a.baseUrl.replace(/\/$/, "") === b.baseUrl.replace(/\/$/, "");
    const live = runConnectionsSessionRef.current === current.id ? runConnectionsRef.current.find(c => c.id === id) : undefined;
    const keySource = original ? [configured, live].find(c => c && sameTuple(c, original)) : undefined;
    const connection: Connection | undefined = original && keySource ? { ...original, apiKey: keySource.apiKey } : undefined;
    if (!connection || !connectionReady(connection)) { openModelSettings(); setNotice("请先配置与本轮结果相同的模型连接，或开启新一轮生成。"); return; }
    const { token, controller } = beginRequest();
    // Retry the original model tuple; a settings change applies to a new round.
    // Only a key for that exact tuple may be refreshed, never another provider's key.
    const snapshot = current.connectionSnapshot || (runConnectionsSessionRef.current === current.id ? runConnectionsRef.current : connections);
    runConnectionsRef.current = snapshot.map(c => c.id === id ? { ...connection } : { ...c, apiKey: runConnectionsRef.current.find(old => old.id === c.id && sameTuple(old, c))?.apiKey || "" });
    runConnectionsSessionRef.current = current.id;
    setRunConnections(runConnectionsRef.current);
    setRunning(true); setPending([id]); updateSession({ ...current, judge: null });
    try {
      const candidate = await generateOne(current.brief, connection, controller.signal);
      if (!isCurrent(token)) return;
      const next = { ...current, candidates: [...current.candidates.filter(c => c.id !== id), candidate], judge: null };
      setPending([]); updateSession(next); await judgeCandidates(next, token, controller.signal);
    } catch { /* Cancellation is handled by stopRun. */ }
    finally { if (isCurrent(token)) { setPending([]); setRunning(false); setJudging(false); } }
  }
  async function retryJudge() {
    const current = sessionRef.current;
    if (!current || running || current.demo) return;
    const { token, controller } = beginRequest();
    setRunning(true); updateSession({ ...current, judge: null });
    try { await judgeCandidates(current, token, controller.signal); }
    finally { if (isCurrent(token)) { setRunning(false); setJudging(false); } }
  }
  function openDemo() {
    stopRun(false); const example = cleanRecord({ ...DEMO_SESSION, id: `demo-${createId()}`, demo: true });
    setModelsRevealed(false); updateSession(example); setBrief(example.brief); setHistoryOpen(null);
    setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }
  function newSession() { stopRun(false); setModelsRevealed(false); updateSession(null); setBrief({ ...EMPTY_BRIEF }); setContextOpen(false); setHistoryOpen(null); window.scrollTo({ top: 0, behavior: "smooth" }); setTimeout(() => textareaRef.current?.focus(), 100); }
  function restoreSession(record: SessionRecord) { stopRun(false); setModelsRevealed(false);
    if (runConnectionsSessionRef.current !== record.id) {
      runConnectionsRef.current = (record.connectionSnapshot || []).map(c => ({ ...c, apiKey: "" }));
      runConnectionsSessionRef.current = record.id; setRunConnections(runConnectionsRef.current);
    }
    updateSession(record); setBrief(record.brief); setHistoryOpen(null); setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50); }
  function toggleFavorite(record: SessionRecord) {
    if (record.demo) return;
    const next = { ...record, favorite: !record.favorite };
    if (session?.id === record.id) updateSession(next);
    setHistory(old => old.map(s => s.id === record.id ? next : s));
    setNotice(next.favorite ? isDesktop ? "已收藏，可在后台的历史与收藏中查看。" : "已收藏，可在左侧收藏夹中找到。" : "已取消收藏。");
  }
  async function saveSettings(writers: Connection[], judge: JudgeConnection): Promise<boolean> {
    if (window.peDesktop?.isDesktop) {
      if (credentialsStatus !== "ready") { setNotice("尚未读取原有密钥，设置未保存；请稍后重试。"); return false; }
      try {
        const result = await window.peDesktop.saveCredentials({ writers: Object.fromEntries(writers.map(c => [c.id, c.apiKey])), jev: judge.apiKey });
        if (!result.ok || !result.persisted) { setNotice(result.error || "设置尚未保存，请重试。"); return false; }
      } catch { setNotice("设置尚未保存，草稿已保留，请重试。"); return false; }
    }
    setConnections(writers); setJudgeConnection(judge); setSettingsOpen(false);
    setNotice(isDesktop ? "设置已保存，API Key 已通过 macOS 钥匙串加密保护。" : "设置已更新。密钥仅用于本次页面会话。");
    return true;
  }
  function openModelSettings() {
    if (window.peDesktop) void window.peDesktop.openWorkspace("settings");
    else setSettingsOpen(true);
  }
  const handleWorkspaceCommand = useEffectEvent(async (command: WorkspaceCommand) => {
    switch (command.type) {
      case "update-brief": setBrief(old => ({ ...old, ...command.patch })); break;
      case "new-session": newSession(); break;
      case "restore-session": { const record = history.find(item => item.id === command.id); if (record) restoreSession(record); break; }
      case "delete-session": setHistory(old => old.filter(item => item.id !== command.id)); if (sessionRef.current?.id === command.id && !running) updateSession(null); break;
      case "toggle-favorite": { const record = sessionRef.current?.id === command.id ? sessionRef.current : history.find(item => item.id === command.id); if (record && !running) toggleFavorite(record); break; }
      case "open-demo": openDemo(); break;
      case "retry-candidate": void retryCandidate(command.id); break;
      case "retry-judge": void retryJudge(); break;
      case "reveal-models": setModelsRevealed(true); break;
      case "config-updated":
      case "credentials-changed": {
        const sequence = ++configSyncRef.current.sequence;
        configSyncRef.current.syncing = true; setConfigSyncing(true);
        try {
          const keys = await window.peDesktop!.getCredentials();
          if (sequence !== configSyncRef.current.sequence) break;
          if (command.type === "config-updated") {
            setConnections(command.config.writers.map(c => ({ ...c, apiKey: keys.writers[c.id] || "" })));
            setJudgeConnection({ ...command.config.judge, apiKey: keys.jev || "" });
          } else {
            setConnections(old => old.map(c => ({ ...c, apiKey: keys.writers[c.id] || "" })));
            setJudgeConnection(old => ({ ...old, apiKey: keys.jev || "" }));
          }
        } catch { setNotice("模型配置尚未同步，请在后台重新保存。原配置仍然保留。"); }
        finally { if (sequence === configSyncRef.current.sequence) { configSyncRef.current.syncing = false; setConfigSyncing(false); } }
        break;
      }
    }
  });
  useEffect(() => window.peDesktop?.onCommand(command => void handleWorkspaceCommand(command)), []);
  useEffect(() => {
    if (!isDesktop || !storageReady) return;
    const state: PublicStudioState = {
      brief,
      config: { writers: connections.map(({ id, label, protocol, model, baseUrl }) => ({ id, label, protocol, model, baseUrl })), judge: { model: judgeConnection.model, baseUrl: judgeConnection.baseUrl } },
      runConnections: runConnections.map(({ id, label, protocol, model, baseUrl }) => ({ id, label, protocol, model, baseUrl })),
      history: history.map(cleanRecord), session: session ? cleanRecord(session) : null,
      pending, judging, running, credentialsStatus, modelsRevealed,
    };
    // Result windows receive task updates without opening themselves. The user
    // decides when to reveal them with the model controls.
    void window.peDesktop?.publishState(state).catch(() => {});
  }, [isDesktop, storageReady, brief, connections, runConnections, judgeConnection, history, session, pending, judging, running, credentialsStatus, modelsRevealed]);
  const showCompactResults = Boolean(session);
  useEffect(() => { if (isDesktop) void window.peDesktop?.setPanelMode("input"); }, [isDesktop]);
  function openCandidate(id: string, focus = true) {
    if (!session) return;
    setActiveResult({ sessionId: session.id, id });
    const desktop = window.peDesktop;
    if (!desktop) return;
    const operation = focus ? desktop.toggleResult(id, true) : desktop.openResult(id, false);
    void operation.then(result => {
      if (!result.ok && result.error) setNotice(result.error);
    }).catch(() => setNotice("结果尚未打开，请重试。"));
  }
  const configuredCount = connections.filter(connectionReady).length;
  const preset = DIRECTION_PRESETS[brief.direction];
  const visibleHistory = history.filter(s => historyOpen !== "favorites" || s.favorite);

  if (isDesktop) return <div ref={panelRef} className={`pe-panel ${showCompactResults ? "has-results" : ""} ${closing ? "is-closing" : ""}`} data-reduce-motion={appearance.reduceMotion}>
    <div className="pe-directions" role="group" aria-label="提示词方向">{directions.map(({ id, icon: Icon }) => <button key={id} className={`pe-direction ${brief.direction === id ? "is-selected" : ""}`} aria-pressed={brief.direction === id} onClick={() => updateBrief("direction", id)}><Icon size={15} /><span>{({ general: "普通", image: "生图", video: "视频", product: "产品" })[id]}</span></button>)}</div>
    <div className="pe-input-surface"><label className="sr-only" htmlFor="prompt-input">输入你的想法</label><textarea ref={textareaRef} id="prompt-input" placeholder={preset.placeholder} value={brief.input} maxLength={12000} onChange={e => updateBrief("input", e.target.value)} onKeyDown={e => { if (!e.nativeEvent.isComposing && (e.metaKey || e.ctrlKey) && e.key === "Enter" && !running) { e.preventDefault(); void startGeneration(); } }} />{brief.input.length > 10000 && <span className="pe-count">{brief.input.length.toLocaleString()} / 12,000</span>}</div>
    {showCompactResults && session && <CompactResults modelsRevealed={modelsRevealed} onRevealModels={() => setModelsRevealed(true)} session={session} connections={runConnections.length ? runConnections : connections} generatingIds={pending} busy={running} judging={judging} activeCandidateId={activeResult?.sessionId === session.id ? activeResult.id : undefined} openedCandidateIds={resultVisibility.sessionId === session.id ? resultVisibility.visibleIds : []} onOpenCandidate={openCandidate} onRetryJudge={() => void retryJudge()} />}
    <footer className="pe-footer"><div className="pe-panel-footer-start"><button type="button" className="pe-panel-settings" aria-label="打开设置" title="设置 · ⌘ ," onClick={openModelSettings}><Settings2 size={14} /><span>设置</span></button><div className="pe-run-status" role="status">{running ? <><span className="pe-working" />{judging ? "Jev 正在评审" : `${connections.length - pending.length}/${connections.length} 已完成`}</> : credentialsStatus === "loading" ? "正在读取模型连接…" : configuredCount === 0 ? <button onClick={openModelSettings}>连接模型</button> : <span className="pe-key-hint">⌘ ↵</span>}</div></div>{running ? <button className="pe-glass-button pe-stop" onClick={() => stopRun()}><Square size={12} />停止</button> : <button className="pe-glass-button pe-primary generate-button" disabled={configSyncing || credentialsStatus === "loading" || !brief.input.trim()} onClick={() => void startGeneration()}><WandSparkles size={16} />优化提示词</button>}</footer>
    {storageError && <p className="pe-inline-warning" role="status">{storageError}</p>}
    {notice && <div className="pe-notice" role="status" onClick={() => setNotice("")}>{notice}</div>}
  </div>;
  return <div className={`studio-shell ${isDesktop ? "desktop-mode" : ""}`}>
    <aside className="sidebar" aria-label="主导航">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); newSession(); }} aria-label="PE Studio 首页"><span className="brand-mark"><Command size={22} strokeWidth={1.7} /></span><span>PE<span className="brand-light"> Studio</span><small>PROMPT, PERFECTED.</small></span></a>
      <button className="new-button" onClick={newSession}><Plus size={17} />新建提示词<span className="shortcut">↗</span></button>
      <nav className="nav-list"><button className={!historyOpen ? "nav-item active" : "nav-item"} onClick={() => setHistoryOpen(null)}><WandSparkles size={17} />提示词工作台<span className="nav-dot" /></button><button className={historyOpen === "history" ? "nav-item active" : "nav-item"} onClick={() => setHistoryOpen("history")}><History size={17} />历史记录<span className="nav-count">{history.length}</span></button><button className={historyOpen === "favorites" ? "nav-item active" : "nav-item"} onClick={() => setHistoryOpen("favorites")}><Star size={17} />我的收藏<span className="nav-count">{history.filter(s => s.favorite).length}</span></button></nav>
      <div className="sidebar-recent"><p className="sidebar-caption">最近的灵感</p>{history.length ? history.slice(0, 3).map(record => <button key={record.id} onClick={() => restoreSession(record)}><span />{record.brief.input}</button>) : <p className="recent-empty">每个好提示词，<br />都从一个小想法开始。</p>}</div>
      <div className="sidebar-bottom"><div className="sidebar-note"><span className="small-spark"><Sparkles size={18} /></span><strong>一个想法，三种可能</strong><p>多模型探索，Jev 帮你比较。</p><button onClick={openDemo}>先看看示例 <ArrowRight size={14} /></button></div><button className="nav-item settings-nav" onClick={() => setSettingsOpen(true)}><Settings2 size={17} />模型与 API 设置<span className={configuredCount ? "status-dot connected" : "status-dot"} /></button><div className="local-status"><ShieldCheck size={13} />历史保存在此浏览器<span>V1.0</span></div></div>
    </aside>
    <div className="workspace">
      {isDesktop && <header className="desktop-header"><div><span className="brand-mark"><Command size={18} /></span><strong>PE Studio</strong><small>{shortcut.replace("CommandOrControl", "⌘").replace("Control", "⌃").replace("Command", "⌘").replace("Shift", "⇧").replace("Alt", "⌥").replaceAll("+", " ")}</small></div><div><button className="icon-button" aria-label="新建提示词" onClick={newSession}><Plus size={17} /></button><button className="icon-button" aria-label="历史记录" onClick={() => setHistoryOpen(historyOpen ? null : "history")}><History size={17} /></button><button className="icon-button" aria-label="我的收藏" onClick={() => setHistoryOpen(historyOpen === "favorites" ? null : "favorites")}><Star size={17} /></button><button className="icon-button" aria-label="模型与快捷键设置" onClick={() => setSettingsOpen(true)}><Settings2 size={17} /></button><button className="icon-button" aria-label="隐藏小窗" onClick={() => void window.peDesktop?.hide()}><X size={17} /></button></div></header>}
      <header className="topbar"><div className="breadcrumb">工作空间 <span>/</span> <strong>{historyOpen === "history" ? "历史记录" : historyOpen === "favorites" ? "我的收藏" : "提示词工作台"}</strong></div><div className="topbar-right"><span className="private-badge"><span />个人工作台</span><button className="icon-button mobile-settings" aria-label="模型与 API 设置" onClick={() => setSettingsOpen(true)}><Settings2 size={18} /></button><span className="avatar">PE</span></div></header>
      {historyOpen ? <main className="main-content history-content"><div className="page-eyebrow"><span /> YOUR PROMPT LIBRARY</div><div className="library-heading"><div><h1>{historyOpen === "favorites" ? "值得留下的好提示词。" : "让每一次灵感，都有迹可循。"}</h1><p>{isDesktop ? "记录保存在这台 Mac，最多保留最近 20 条。" : "仅保存在当前浏览器，最多保留最近 20 条记录。"}</p></div><button className="secondary-button" onClick={newSession}><Plus size={16} />新建提示词</button></div><div className="history-list">{visibleHistory.length ? visibleHistory.map(record => <article className="history-card" key={record.id}><button className="history-main" onClick={() => restoreSession(record)}><span className="history-direction">{DIRECTION_LABELS[record.brief.direction]}</span><h2>{record.brief.input}</h2><p><Clock3 size={12} />{dateLabel(record.createdAt)}<span>·</span>{record.candidates.filter(c => c.status === "success").length} 份候选<span>·</span>{record.judge?.status === "complete" ? "已评审" : "未完成评审"}</p></button><div className="history-actions"><button className={record.favorite ? "icon-button favorited" : "icon-button"} onClick={() => toggleFavorite(record)} aria-label={record.favorite ? "取消收藏" : "收藏记录"}><Star size={17} fill={record.favorite ? "currentColor" : "none"} /></button><button className="icon-button" onClick={() => { setHistory(old => old.filter(s => s.id !== record.id)); if (session?.id === record.id) updateSession(null); }} aria-label="删除这条历史记录"><Trash2 size={16} /></button><button className="icon-button" aria-label="打开记录" onClick={() => restoreSession(record)}><ArrowRight size={18} /></button></div></article>) : <div className="library-empty"><span><History size={30} strokeWidth={1.3} /></span><h2>{historyOpen === "favorites" ? "把喜欢的结果，收藏在这里" : "你的提示词故事，从这里开始"}</h2><p>{historyOpen === "favorites" ? "在生成结果上点击收藏，下次使用更顺手。" : "生成第一组提示词后，就能在这里找到它。"}</p><button className="primary-button" onClick={newSession}>写下第一个想法 <ArrowRight size={16} /></button></div>}</div></main> : <main className="main-content">
        <section className="hero"><div className="page-eyebrow"><span /> A LITTLE IDEA. A BETTER PROMPT.</div><h1>你的想法，<span>值得更好的表达。</span></h1><p>随手写下需求，让三个模型打磨提示词，再由 Jev 为你比较。</p><button className="hero-demo" onClick={openDemo}>看看它如何工作 <ArrowDown size={14} /></button></section>
        <section className="composer-section" aria-label="创建提示词">
          <div className="section-heading"><h2><span className="step-index">01</span>这次，想创造什么？</h2><span className="section-hint">选择一个方向</span></div>
          <div className="direction-grid">{directions.map(({ id, icon: Icon, subtitle, number }) => <button key={id} className={`direction-card ${brief.direction === id ? "selected" : ""}`} aria-pressed={brief.direction === id} onClick={() => updateBrief("direction", id)}><div className="direction-card-top"><span className="direction-icon"><Icon size={20} strokeWidth={1.7} /></span><span className="direction-number">{brief.direction === id ? <Check size={14} /> : number}</span></div><strong>{DIRECTION_LABELS[id]}</strong><span className="direction-subtitle">{subtitle}</span></button>)}</div>
          <div className="section-heading input-heading"><h2><span className="step-index">02</span>把想法交给我们</h2><span className="section-hint">不必完整，也不必专业</span></div>
          <div className="composer-card"><label className="sr-only" htmlFor="prompt-input">你的原始想法</label><textarea ref={textareaRef} id="prompt-input" className="idea-input" placeholder={preset.placeholder} value={brief.input} maxLength={12000} onChange={e => updateBrief("input", e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !running) { e.preventDefault(); void startGeneration(); } }} /><div className="input-bottom"><button className="example-button" onClick={() => { updateBrief("input", preset.example); textareaRef.current?.focus(); }}><Sparkles size={13} />试试这个灵感<span className="example-text">{preset.example}</span><ArrowRight size={13} /></button><span className="character-count">{brief.input.length.toLocaleString()} <span>/ 12,000</span></span></div>
            <div className="composer-options"><div className="target-row"><label htmlFor="target-model">准备用在哪个模型？<span>选填</span></label><div className="target-input-wrap"><input id="target-model" maxLength={200} value={brief.targetModel} list="target-models" placeholder="通用，或输入任意目标模型" onChange={e => updateBrief("targetModel", e.target.value)} /><datalist id="target-models">{preset.targets.map(target => <option key={target} value={target} />)}</datalist><ChevronDown size={14} /></div></div><div className="target-chips"><span>试试</span>{preset.targets.slice(0, 4).map(target => <button className={brief.targetModel === target ? "selected" : ""} key={target} onClick={() => updateBrief("targetModel", brief.targetModel === target ? "" : target)}>{target}</button>)}</div>
              <button className="context-toggle" aria-expanded={contextOpen} aria-controls="context-fields" onClick={() => setContextOpen(!contextOpen)}><Plus size={14} className={contextOpen ? "rotate-45" : ""} />补充背景与硬性要求<span>让结果更贴合你</span><ChevronDown size={14} className={contextOpen ? "rotate-180" : ""} /></button>{contextOpen && <div className="context-fields" id="context-fields"><label>补充背景<textarea rows={3} maxLength={6000} placeholder="比如：受众是谁、使用场景、已有素材……" value={brief.context} onChange={e => updateBrief("context", e.target.value)} /></label><label>硬性要求<textarea rows={3} maxLength={4000} placeholder="比如：必须保留的内容、不能出现的元素、字数限制……" value={brief.constraints} onChange={e => updateBrief("constraints", e.target.value)} /></label></div>}
              <div className="tuning-row"><fieldset className="intensity-field"><legend>优化强度</legend><div className="segmented-control">{([{ id: "faithful", label: "保留原意" }, { id: "balanced", label: "标准优化" }, { id: "creative", label: "创意扩展" }] as const).map(option => <button type="button" key={option.id} aria-pressed={brief.intensity === option.id} className={brief.intensity === option.id ? "selected" : ""} onClick={() => updateBrief("intensity", option.id)}>{option.label}</button>)}</div></fieldset><div className="language-field"><label htmlFor="output-language">输出语言</label><select id="output-language" value={brief.outputLanguage} onChange={e => updateBrief("outputLanguage", e.target.value as Brief["outputLanguage"])}><option value="zh">中文</option><option value="en">English</option></select></div></div>
            </div>
            <div className="composer-footer"><div className="model-stack"><span className="model-orbit openai-orbit">O</span><span className="model-orbit claude-orbit">A</span><span className="model-orbit gemini-orbit">G</span><div><strong>三个模型，独立打磨</strong><button onClick={() => setSettingsOpen(true)}>{configuredCount === 3 ? "模型已就绪" : `已连接 ${configuredCount}/3 · 设置模型`} <ChevronDown size={11} /></button></div></div>{running ? <button className="cancel-button" onClick={() => stopRun()}><Square size={13} />停止生成</button> : <button className="primary-button generate-button" onClick={() => void startGeneration()}><WandSparkles size={17} />开始生成<span className="generate-shortcut">⌘ ↵</span><ArrowRight size={16} /></button>}</div>
          </div>
          <div className="under-composer"><span><ShieldCheck size={13} />{isDesktop ? "API Key 由 macOS 钥匙串加密保护" : "API Key 仅留在当前页面内存"}</span>{isDesktop ? <button className="desktop-demo-link" onClick={openDemo}>查看完整示例 <ArrowRight size={12} /></button> : <span>有目标，有约束，结果更出色。</span>}</div>
        </section>
        {session ? <section className="results-section" ref={resultsRef}><Results session={session} connections={connections} pending={pending} judging={judging} running={running} onRetry={retryCandidate} onRetryJudge={retryJudge} onSettings={() => setSettingsOpen(true)} onFavorite={() => toggleFavorite(session)} onNotice={setNotice} /></section> : <section className="empty-results"><div className="empty-results-heading"><h2><span className="step-index">03</span>好提示词，让结果更进一步</h2><span>从想法到推荐，只需一步</span></div><div className="workflow-explainer"><div className="workflow-item"><span className="workflow-icon"><Layers3 size={20} strokeWidth={1.5} /></span><div><h3>三份独立方案</h3><p>不同模型，为同一个想法<br />带来更多表达可能。</p></div></div><span className="workflow-arrow"><ArrowRight size={20} strokeWidth={1} /></span><div className="workflow-item"><span className="workflow-icon"><ShieldCheck size={20} strokeWidth={1.5} /></span><div><h3>Jev 多维度评审</h3><p>依据意图、约束与可执行性，<br />比较各份提示词。</p></div></div><span className="workflow-arrow"><ArrowRight size={20} strokeWidth={1} /></span><div className="workflow-item"><span className="workflow-icon lime"><Check size={21} strokeWidth={1.5} /></span><div><h3>你来决定，用哪一份</h3><p>保留所有候选和改写说明，<br />随时复制、收藏或调整。</p></div></div></div><button className="text-button sample-link" onClick={openDemo}>还没准备好？查看完整示例 <ArrowRight size={14} /></button></section>}
        <footer className="page-footer"><span>PE STUDIO <span className="footer-divider">/</span> 给灵感一个更好的起点</span><span><CircleHelp size={12} />评审比较提示词质量，不代表下游生成效果已验证</span></footer>
      </main>}
      {storageError && <div className="storage-warning" role="status">{storageError}</div>}
    </div>
    {settingsOpen && credentialsStatus !== "loading" && <SettingsDialog connections={connections} judge={judgeConnection} serverConfig={serverConfig} isDesktop={isDesktop} credentialsAvailable={credentialsStatus === "ready"} shortcut={shortcut} onShortcutChange={setShortcut} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />}
    {settingsOpen && credentialsStatus === "loading" && <div className="toast" role="status">正在安全读取已保存的密钥…</div>}
    <div className="sr-only" role="status" aria-live="polite">{running ? judging ? "候选已生成，Jev 正在评审。" : `正在生成提示词，还有 ${pending.length} 个模型运行中。` : session ? "本轮操作已完成。" : ""}</div>
    {notice && <div className="toast" role="status"><span><Check size={16} /></span>{notice}<button aria-label="关闭提示" onClick={() => setNotice("")}><X size={15} /></button></div>}
  </div>;
}
