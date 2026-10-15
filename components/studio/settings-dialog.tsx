"use client";

import { useEffect, useEffectEvent, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { Check, ChevronDown, Eye, EyeOff, KeyRound, Keyboard, LoaderCircle, Monitor, RefreshCw, Search, Settings2, ShieldCheck, X } from "lucide-react";
import { DEFAULT_CONNECTIONS, DEFAULT_JUDGE, type Connection, type JudgeConnection, type Protocol } from "@/lib/types";
import { AIHUBMIX_BASE_URL, AIHUBMIX_BACKUP_BASE_URL, normalizeAiHubMixBase } from "@/lib/aihubmix";
import { CLOUD_PROVIDERS as PROVIDER_DEFINITIONS, type ModelCatalogEntry } from "@/lib/provider-catalog";
import { hasModelChanges } from "./settings-model-changes";
import "./provider-settings.css";

export type ServerConfig = Partial<Record<"openai" | "anthropic" | "gemini" | "aihubmix" | "deepseek" | "jev", boolean>>;
export interface SettingsDialogController { saveChanges(): Promise<boolean>; discardChanges(): void }
interface Props { embedded?: boolean; saving?: boolean; connections: Connection[]; judge: JudgeConnection; serverConfig: ServerConfig; isDesktop: boolean; credentialsAvailable: boolean; shortcut: string; onShortcutChange: (value: string) => void; onSave: (writers: Connection[], judge: JudgeConnection) => boolean | Promise<boolean>; onClose: () => void; controllerRef?: Ref<SettingsDialogController>; onModelDirtyChange?: (dirty: boolean) => void }
type ProviderId = "aihubmix" | "deepseek" | "local-agent" | "legacy";
type ModelItem = ModelCatalogEntry;
interface Catalog { items: ModelItem[]; loading: boolean; message: string; error: boolean }
interface LocalAgent { id: string; label: string; installed: boolean; available: boolean; status: string; models?: string[] }
const CLOUD_PROVIDERS = PROVIDER_DEFINITIONS.map(provider => ({ ...provider, subtitle: provider.id === "aihubmix" ? "AiHubMix" : "深度求索", label: provider.id === "aihubmix" ? "推理时代" : provider.label, baseUrl: provider.defaultBaseUrl, mark: provider.id === "aihubmix" ? "Ai" : "D" }));
const EMPTY_CATALOG: Catalog = { items: [], loading: false, message: "", error: false };
const SLOT_NAMES = ["1", "2", "3"];
function providerOf(connection: Connection): ProviderId { return connection.protocol === "aihubmix" || connection.protocol === "deepseek" || connection.protocol === "local-agent" ? connection.protocol : "legacy"; }
function draftKey(connection: Connection) { return `${connection.id}/${providerOf(connection)}`; }
function validHttpAddress(value: string) { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } }
function parseModels(value: unknown): ModelItem[] {
  if (!value || typeof value !== "object" || !("models" in value) || !Array.isArray(value.models)) return [];
  const seen = new Set<string>();
  return value.models.flatMap(item => {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !item.id.trim() || item.id.length > 300 || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{ id: item.id, ...("displayName" in item && typeof item.displayName === "string" ? { displayName: item.displayName.slice(0, 200) } : {}) }];
  });
}

export function SettingsDialog({ embedded = false, saving = false, connections, judge, serverConfig, isDesktop, credentialsAvailable, shortcut, onShortcutChange, onSave, onClose, controllerRef, onModelDirtyChange }: Props) {
  const [writers, setWriters] = useState(connections.map(connection => ({ ...connection })));
  const [judgeDraft, setJudgeDraft] = useState({ ...judge });
  const [tab, setTab] = useState(0);
  const [visibleKeys, setVisibleKeys] = useState<Record<string, boolean>>({});
  const [validation, setValidation] = useState("");
  const [shortcutDraft, setShortcutDraft] = useState(shortcut);
  const [shortcutStatus, setShortcutStatus] = useState("");
  const [savingShortcut, setSavingShortcut] = useState(false);
  const [catalogs, setCatalogs] = useState<Record<string, Catalog>>({});
  const [modelSearch, setModelSearch] = useState("");
  const [expandedCatalogKey, setExpandedCatalogKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [agents, setAgents] = useState<LocalAgent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsMessage, setAgentsMessage] = useState("");
  const providerDrafts = useRef<Record<string, Connection>>({});
  const requests = useRef<Record<string, AbortController>>({});
  const mounted = useRef(true);
  const submittingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeDialog = useEffectEvent(() => { if (!busy) onClose(); });
  const writer = writers[tab];
  const selectedProvider = providerOf(writer);
  const currentCatalog = catalogs[draftKey(writer)] || EMPTY_CATALOG;
  const cloudProvider = CLOUD_PROVIDERS.find(provider => provider.id === selectedProvider);
  const localId = selectedProvider === "local-agent" ? writer.baseUrl.replace(/^local:\/\//, "") : "";
  const selectedAgent = agents.find(agent => agent.id === localId);
  const modelDirty = hasModelChanges(connections, writers);
  const busy = saving || submitting;
  const reportModelDirty = useEffectEvent((dirty: boolean) => onModelDirtyChange?.(dirty));

  useLayoutEffect(() => { reportModelDirty(modelDirty); }, [modelDirty]);
  useEffect(() => () => reportModelDirty(false), []);
  useImperativeHandle(controllerRef, () => ({ saveChanges: save, discardChanges }));

  useEffect(() => {
    mounted.current = true;
    const pending = requests.current;
    return () => { mounted.current = false; for (const controller of Object.values(pending)) controller.abort(); };
  }, []);
  useEffect(() => {
    if (embedded) return;
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); closeDialog(); }
      if (event.key !== "Tab" || !dialog) return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex="0"]')).filter(element => element.offsetParent !== null);
      const first = nodes[0]; const last = nodes[nodes.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener("keydown", keydown); previous?.focus(); };
  }, [embedded]);

  function clearCatalog(connection: Connection) {
    const key = draftKey(connection);
    requests.current[key]?.abort();
    delete requests.current[key];
    setCatalogs(old => ({ ...old, [key]: EMPTY_CATALOG }));
  }
  function updateWriter<K extends keyof Connection>(key: K, value: Connection[K]) {
    if (key === "apiKey" || key === "baseUrl") clearCatalog(writer);
    setWriters(old => old.map((connection, index) => index === tab ? { ...connection, [key]: value } : connection));
    setValidation("");
  }
  function selectProvider(provider: ProviderId) {
    if (selectedProvider === provider || busy) return;
    providerDrafts.current[draftKey(writer)] = { ...writer };
    const restored = providerDrafts.current[`${writer.id}/${provider}`];
    const preset = CLOUD_PROVIDERS.find(item => item.id === provider);
    const replacement = restored || (provider === "legacy" ? connections.find(item => item.id === writer.id && providerOf(item) === "legacy") : undefined) || {
      id: writer.id,
      label: preset ? `${preset.label}${preset.id === "aihubmix" ? " / AiHubMix" : ""}` : "本地 Agent",
      protocol: provider as Protocol,
      model: provider === "local-agent" ? "default" : "",
      baseUrl: preset?.baseUrl || "local://",
      apiKey: "",
    };
    setWriters(old => old.map((connection, index) => index === tab ? { ...replacement } : connection));
    setVisibleKeys(old => ({ ...old, [`writer-key-${tab}`]: false }));
    setModelSearch(""); setExpandedCatalogKey(null); setValidation("");
  }
  function writerServerConfigured(connection: Connection) {
    if (connection.protocol === "local-agent") return false;
    if (connection.protocol === "aihubmix") {
      try { return normalizeAiHubMixBase(connection.baseUrl.trim()) === AIHUBMIX_BASE_URL && Boolean(serverConfig.aihubmix); } catch { return false; }
    }
    if (connection.protocol === "deepseek") return /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(connection.baseUrl.trim()) && Boolean(serverConfig.deepseek);
    const official = DEFAULT_CONNECTIONS.some(item => (item.protocol === connection.protocol || (connection.protocol === "openai-compatible" && item.protocol === "openai-responses")) && item.baseUrl.replace(/\/$/, "") === connection.baseUrl.replace(/\/$/, ""));
    return official && Boolean(serverConfig[connection.protocol === "anthropic" ? "anthropic" : connection.protocol === "gemini" ? "gemini" : "openai"]);
  }
  async function fetchModels() {
    const snapshot = { ...writer };
    const key = draftKey(snapshot);
    if (!validHttpAddress(snapshot.baseUrl.trim())) { setCatalogs(old => ({ ...old, [key]: { ...EMPTY_CATALOG, error: true, message: "请先填写完整的 HTTP(S) 接口地址。" } })); return; }
    if (!snapshot.apiKey.trim() && !writerServerConfigured(snapshot)) { setCatalogs(old => ({ ...old, [key]: { ...EMPTY_CATALOG, error: true, message: "请先填写当前厂商的 API Key。" } })); return; }
    requests.current[key]?.abort();
    const controller = new AbortController(); requests.current[key] = controller;
    setCatalogs(old => ({ ...old, [key]: { ...(old[key] || EMPTY_CATALOG), loading: true, message: "正在检测连接并获取模型…", error: false } }));
    try {
      const response = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ connection: { protocol: selectedProvider, baseUrl: snapshot.baseUrl, apiKey: snapshot.apiKey } }), signal: controller.signal });
      const value: unknown = await response.json();
      if (!mounted.current || requests.current[key] !== controller) return;
      if (!response.ok || (value && typeof value === "object" && "ok" in value && value.ok === false)) {
        const error = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error.slice(0, 500) : "连接检测失败，请核对 API Key 与接口地址。";
        setCatalogs(old => ({ ...old, [key]: { ...EMPTY_CATALOG, message: error, error: true } })); return;
      }
      const items = parseModels(value);
      setCatalogs(old => ({ ...old, [key]: { items, loading: false, error: false, message: items.length ? `连接成功，已获取 ${items.length} 个模型。` : "连接成功，目录暂无模型；仍可手动填写 Model ID。" } }));
      if (items.length) setExpandedCatalogKey(key);
    } catch {
      if (!controller.signal.aborted && mounted.current && requests.current[key] === controller) setCatalogs(old => ({ ...old, [key]: { ...EMPTY_CATALOG, message: "未能获取模型列表，请检查连接后重试。", error: true } }));
    } finally { if (requests.current[key] === controller) delete requests.current[key]; }
  }
  async function detectLocalAgents() {
    const desktop = window.peDesktop as (typeof window.peDesktop & { listLocalAgents?: () => Promise<LocalAgent[]> });
    if (!desktop?.listLocalAgents) { setAgentsMessage(isDesktop ? "本地 Agent 检测暂不可用，请更新应用后重试。" : "本地 Agent 模式仅在 macOS App 中可用。"); return; }
    setAgentsLoading(true); setAgentsMessage("");
    try {
      const detected = await desktop.listLocalAgents();
      if (!mounted.current) return;
      setAgents(detected);
      setAgentsMessage(detected.some(agent => agent.available) ? "检测完成，选择可用的本地 Agent。" : "没有可用的受支持 Agent，请查看检测结果并更新或安装工具。");
    } catch { if (mounted.current) setAgentsMessage("检测未完成，请稍后重试。"); }
    finally { if (mounted.current) setAgentsLoading(false); }
  }
  async function changeShortcut() {
    if (!window.peDesktop || !shortcutDraft.trim()) return;
    setSavingShortcut(true); setShortcutStatus("");
    try {
      const result = await window.peDesktop.setShortcut(shortcutDraft.trim());
      if (result.ok) { onShortcutChange(result.accelerator); setShortcutDraft(result.accelerator); setShortcutStatus("唤出快捷键已更新。"); }
      else setShortcutStatus(result.error || "快捷键未能注册，请换一个组合。");
    } catch { setShortcutStatus("快捷键设置失败，请重试。"); }
    finally { setSavingShortcut(false); }
  }
  function discardChanges() {
    for (const controller of Object.values(requests.current)) controller.abort();
    for (const key of Object.keys(requests.current)) delete requests.current[key];
    providerDrafts.current = {};
    setWriters(connections.map(connection => ({ ...connection })));
    setJudgeDraft({ ...judge });
    setVisibleKeys({}); setValidation(""); setCatalogs({});
    setModelSearch(""); setExpandedCatalogKey(null); setShortcutDraft(shortcut);
    onModelDirtyChange?.(false);
  }
  async function save(): Promise<boolean> {
    if (saving || submittingRef.current) return false;
    for (const [index, connection] of writers.entries()) {
      if (!connection.model.trim()) { setTab(index); setValidation(`请为 ${SLOT_NAMES[index] || index + 1} 位选择或填写模型。`); return false; }
      if (connection.protocol === "local-agent") {
        const id = connection.baseUrl.replace(/^local:\/\//, "");
        const detected = agents.find(agent => agent.id === id && agent.available);
        const unchanged = connections.some(original => original.id === connection.id && original.protocol === "local-agent" && original.baseUrl === connection.baseUrl);
        if (!/^local:\/\/[a-z0-9-]+$/.test(connection.baseUrl) || (!detected && !unchanged)) { setTab(index); setValidation(`请检测并选择 ${SLOT_NAMES[index] || index + 1} 位可用的本地 Agent。`); return false; }
      } else if (!validHttpAddress(connection.baseUrl.trim())) { setTab(index); setValidation("接口地址请填写完整的 HTTP(S) 地址，不要包含密钥或查询参数。"); return false; }
    }
    if (!judgeDraft.model.trim() || !validHttpAddress(judgeDraft.baseUrl.trim())) { setValidation("请核对 Jev 的 Model ID 与完整的 HTTP(S) 接口地址。"); return false; }
    submittingRef.current = true; setSubmitting(true); setValidation("");
    try {
      const ok = await onSave(writers.map(connection => ({ ...connection, label: connection.label.trim() || connection.model.trim(), model: connection.model.trim(), baseUrl: connection.baseUrl.trim().replace(/\/$/, ""), apiKey: connection.protocol === "local-agent" ? "" : connection.apiKey.trim() })), { model: judgeDraft.model.trim(), baseUrl: judgeDraft.baseUrl.trim().replace(/\/$/, ""), apiKey: judgeDraft.apiKey.trim() });
      if (!ok && mounted.current) setValidation("设置未保存，修改已保留。请查看错误提示后重试。");
      return ok === true;
    } catch {
      if (mounted.current) setValidation("设置未保存，修改已保留，请重试。");
      return false;
    } finally { submittingRef.current = false; if (mounted.current) setSubmitting(false); }
  }
  const filteredModels = currentCatalog.items.filter(model => `${model.id} ${model.displayName || ""}`.toLowerCase().includes(modelSearch.trim().toLowerCase()));
  const localModels = selectedAgent?.models || [];

  return <div className={embedded ? "embedded-settings provider-settings" : "modal-overlay provider-settings"} onMouseDown={event => { if (!embedded && !busy && event.target === event.currentTarget) onClose(); }}><div ref={dialogRef} className="settings-dialog" data-model-dirty={modelDirty} role={embedded ? "region" : "dialog"} aria-modal={embedded ? undefined : true} aria-labelledby="settings-title"><header className="dialog-header"><span className="dialog-icon"><Settings2 size={21} /></span><div><h2 id="settings-title">模型与设置</h2><p>三个位置独立配置，每轮随机分配前台 A/B/C。</p></div>{!embedded && <button className="icon-button" disabled={busy} aria-label="关闭模型设置" onClick={onClose}><X size={20} /></button>}</header><div className="dialog-body">{isDesktop && !credentialsAvailable && <p className="form-error" role="status">未能读取原有密钥，暂不覆盖已保存的密钥。请重启应用后重试。</p>}
      <div className="settings-section-label"><span>生成模型位</span><span>每个位置独立配置，不共用 Key</span></div>
      <div className="writer-tabs" role="tablist" aria-label="生成模型">{writers.map((connection, index) => <button type="button" key={connection.id} role="tab" aria-selected={tab === index} aria-controls="writer-panel" id={`writer-tab-${index}`} disabled={busy} onClick={() => { setTab(index); setModelSearch(""); setExpandedCatalogKey(null); setValidation(""); }} className={tab === index ? "selected" : ""}><span className="provider-slot-letter">{SLOT_NAMES[index] || index + 1}</span><span className="writer-tab-copy"><span className="writer-tab-name">{connection.model || "选择模型"}</span><small>{connection.protocol === "local-agent" ? "本地 Agent" : connection.apiKey || writerServerConfigured(connection) ? "已配置" : "待连接"}</small></span></button>)}</div>
      <section id="writer-panel" role="tabpanel" aria-labelledby={`writer-tab-${tab}`} data-protocol={writer.protocol} className="writer-panel provider-layout">
        <nav className="provider-list" aria-label={`${SLOT_NAMES[tab]} 位接入厂商`}><p>模型服务</p>{CLOUD_PROVIDERS.map(provider => <button type="button" key={provider.id} data-provider={provider.id} aria-pressed={selectedProvider === provider.id} disabled={busy} onClick={() => selectProvider(provider.id)}><span className={`provider-mark ${provider.id}`} aria-hidden="true">{provider.mark}</span><span>{provider.label}<small>{provider.subtitle}</small></span>{selectedProvider === provider.id && <Check size={14} />}</button>)}<p className="provider-local-heading">本机</p><button type="button" data-provider="local-agent" aria-pressed={selectedProvider === "local-agent"} disabled={busy || !isDesktop} onClick={() => { selectProvider("local-agent"); if (!agents.length && !agentsLoading) void detectLocalAgents(); }}><span className="provider-mark local" aria-hidden="true"><Monitor size={17} /></span><span>本地 Agent<small>检测本机可用工具</small></span>{selectedProvider === "local-agent" && <Check size={14} />}</button></nav>
        <div className="provider-detail"><header className="provider-detail-header"><div><h3>{cloudProvider ? `${cloudProvider.label}${cloudProvider.id === "aihubmix" ? " / AiHubMix" : ""}` : selectedProvider === "local-agent" ? "本地 Agent" : "原有连接 · 待迁移"}</h3><p>{selectedProvider === "local-agent" ? "使用本机已安装并登录的 Agent。" : `此处仅修改 ${SLOT_NAMES[tab]} 位，保存后用于下一次生成。`}</p></div></header>
          {selectedProvider === "local-agent" ? <div className="provider-local-panel"><div className="provider-model-heading"><h4>可用 Agent</h4><button type="button" className="secondary-button" disabled={agentsLoading || busy || !isDesktop} onClick={() => void detectLocalAgents()}><RefreshCw size={14} className={agentsLoading ? "spin" : ""} />{agentsLoading ? "检测中…" : "检测本地 Agent"}</button></div><p className="provider-hint">检测仅检查受支持工具的安装和可用状态，不启动服务、不发送任务。</p>{agentsMessage && <p className="provider-status" role="status">{agentsMessage}</p>}<div className="provider-agents">{agents.map(agent => <button type="button" key={agent.id} className={localId === agent.id ? "is-selected" : ""} aria-pressed={localId === agent.id} disabled={!agent.available || busy} onClick={() => { setWriters(old => old.map((connection, index) => index === tab ? { ...connection, protocol: "local-agent" as Protocol, baseUrl: `local://${agent.id}`, model: "default", label: agent.label, apiKey: "" } : connection)); setValidation(""); }}><Monitor size={18} /><span><strong>{agent.label}</strong><small>{agent.status}</small></span>{localId === agent.id && <Check size={15} />}</button>)}</div>{!agents.length && !agentsLoading && <p className="provider-empty">点击检测，查看本机可用的 Agent。</p>}{localId && <p className="provider-hint">当前选择：{selectedAgent?.label || localId}{!selectedAgent && " · 尚未重新检测"}</p>}<div className="settings-field full-width"><label htmlFor="writer-model">模型</label><select id="writer-model" value={writer.model} disabled={busy} onChange={event => updateWriter("model", event.target.value)}><option value="default">使用 Agent 默认模型</option>{localModels.filter(model => model !== "default").map(model => <option value={model} key={model}>{model}</option>)}</select><small>使用本地工具现有的模型配置，不读取或更改它的密钥。</small></div><ModelSaveActions saving={busy} dirty={modelDirty} validation={validation} onSave={() => void save()} /></div> : <>
            {selectedProvider === "legacy" && <p className="provider-legacy-note">原有连接暂时保留，请选择推理时代、DeepSeek 或本地 Agent 完成迁移。切换厂商时密钥不会自动带入；取消可恢复原配置。</p>}
            <div className="settings-grid"><ApiKeyField id={`writer-key-${tab}`} value={writer.apiKey} onChange={value => updateWriter("apiKey", value)} configured={writerServerConfigured(writer)} isDesktop={isDesktop} disabled={busy} visible={Boolean(visibleKeys[`writer-key-${tab}`])} onToggle={() => setVisibleKeys(old => ({ ...old, [`writer-key-${tab}`]: !old[`writer-key-${tab}`] }))} detect={selectedProvider !== "legacy"} loading={currentCatalog.loading} onDetect={() => void fetchModels()} /><div className="settings-field full-width"><label htmlFor="writer-base">API 接口地址</label><input id="writer-base" type="url" value={writer.baseUrl} disabled={busy} onChange={event => updateWriter("baseUrl", event.target.value)} spellCheck={false} /><small>填写服务商提供的接口地址，不要在地址中包含 API Key。</small>{selectedProvider === "aihubmix" && <div className="provider-route-options" role="group" aria-label="AiHubMix 访问线路"><button type="button" disabled={busy} aria-pressed={writer.baseUrl.replace(/\/+$/, "") === AIHUBMIX_BASE_URL} onClick={() => updateWriter("baseUrl", AIHUBMIX_BASE_URL)}>主线路</button><button type="button" disabled={busy} aria-pressed={writer.baseUrl.replace(/\/+$/, "") === AIHUBMIX_BACKUP_BASE_URL} onClick={() => updateWriter("baseUrl", AIHUBMIX_BACKUP_BASE_URL)}>备用线路</button></div>}</div></div>
            <section className="provider-models" aria-labelledby="provider-models-title">
              <div className="settings-field full-width"><label htmlFor="writer-model">Model ID <small>选择或手动填写</small></label><input id="writer-model" value={writer.model} disabled={busy} onChange={event => updateWriter("model", event.target.value)} spellCheck={false} placeholder="选择目录中的模型，或填写精确 Model ID" /><small>保留服务商提供的原始 ID 与大小写，不限制使用目录外模型。</small></div>
              <ModelSaveActions saving={busy} dirty={modelDirty} validation={validation} onSave={() => void save()} />
              <div className="provider-model-heading"><h4 id="provider-models-title">模型目录 <span>{currentCatalog.items.length || ""}</span></h4><div className="provider-model-tools">{currentCatalog.items.length > 0 && <button type="button" className="secondary-button" data-testid="model-catalog-toggle" aria-expanded={expandedCatalogKey === draftKey(writer)} aria-controls="provider-model-catalog" disabled={busy} onClick={() => setExpandedCatalogKey(expandedCatalogKey === draftKey(writer) ? null : draftKey(writer))}>{expandedCatalogKey === draftKey(writer) ? "收起目录" : "选择模型"}<ChevronDown size={14} /></button>}{selectedProvider !== "legacy" && <button type="button" className="secondary-button" disabled={busy || currentCatalog.loading} onClick={() => void fetchModels()}><RefreshCw size={14} className={currentCatalog.loading ? "spin" : ""} />获取模型列表</button>}</div></div>
              {currentCatalog.message && <p className={`provider-status${currentCatalog.error ? " is-error" : ""}`} role="status">{currentCatalog.message}</p>}
              {currentCatalog.items.length > 0 && expandedCatalogKey === draftKey(writer) && <div id="provider-model-catalog"><label className="provider-model-search"><Search size={15} /><span className="sr-only">搜索模型</span><input type="search" value={modelSearch} onChange={event => setModelSearch(event.target.value)} placeholder="搜索模型名称或 ID…" /></label><div className="provider-model-catalog" role="group" aria-label="选择模型">{filteredModels.length ? filteredModels.slice(0, 200).map(model => <button type="button" key={model.id} aria-pressed={writer.model === model.id} disabled={busy} onClick={() => { updateWriter("model", model.id); setExpandedCatalogKey(null); setModelSearch(""); document.getElementById("writer-model")?.focus(); }}><span><strong>{model.displayName || model.id}</strong>{model.displayName && model.displayName !== model.id && <small>{model.id}</small>}</span>{writer.model === model.id ? <Check size={15} /> : <ChevronDown size={14} className="provider-model-choice" />}</button>) : <p className="provider-empty">没有匹配的模型，可修改搜索或手动填写 ID。</p>}{filteredModels.length > 200 && <p className="provider-hint">仅显示前 200 项，请搜索以缩小范围。</p>}</div></div>}
              {!currentCatalog.items.length && !currentCatalog.message && selectedProvider !== "legacy" && <p className="provider-empty">填写 API Key 后获取目录，也可以直接填写模型 ID。</p>}
            </section>
          </>}
        </div>
      </section>
      <details className="provider-extra-settings"><summary><span className="jev-mini">j.</span><span>Jev 评审<small>独立配置，保留现有评分机制</small></span><ChevronDown size={16} /></summary><section className="judge-settings"><div className="settings-grid"><div className="settings-field"><label htmlFor="judge-model">Model ID</label><input id="judge-model" value={judgeDraft.model} disabled={busy} spellCheck={false} onChange={event => setJudgeDraft(old => ({ ...old, model: event.target.value }))} /></div><div className="settings-field"><label htmlFor="judge-base">API 接口地址</label><input id="judge-base" type="url" value={judgeDraft.baseUrl} disabled={busy} spellCheck={false} onChange={event => setJudgeDraft(old => ({ ...old, baseUrl: event.target.value }))} /></div><ApiKeyField id="judge-key" value={judgeDraft.apiKey} onChange={value => setJudgeDraft(old => ({ ...old, apiKey: value }))} configured={Boolean(serverConfig.jev && judgeDraft.baseUrl.replace(/\/$/, "") === DEFAULT_JUDGE.baseUrl)} isDesktop={isDesktop} disabled={busy} visible={Boolean(visibleKeys["judge-key"])} onToggle={() => setVisibleKeys(old => ({ ...old, "judge-key": !old["judge-key"] }))} /></div></section></details>
      {isDesktop && <details className="provider-extra-settings"><summary><Keyboard size={18} /><span>全局快捷键<small>{shortcut}</small></span><ChevronDown size={16} /></summary><section className="shortcut-settings"><div className="shortcut-editor"><label className="sr-only" htmlFor="global-shortcut">快捷键组合</label><input id="global-shortcut" value={shortcutDraft} disabled={savingShortcut || busy} onChange={event => setShortcutDraft(event.target.value)} placeholder="Control+Q" spellCheck={false} /><button type="button" className="secondary-button" disabled={savingShortcut || saving || !shortcutDraft.trim()} onClick={() => void changeShortcut()}>{savingShortcut ? "设置中…" : "应用快捷键"}</button></div><p>例如 Control+Q 或 CommandOrControl+Shift+P。此项单独生效。</p>{shortcutStatus && <p role="status" className="shortcut-status">{shortcutStatus}</p>}</section></details>}
      <div className="key-privacy"><ShieldCheck size={17} /><p>{isDesktop ? "各模型位的 Key 独立保存并加密，不进入浏览器存储、历史或导出文件。云端请求发送到所填厂商接口；本地模式使用已选 Agent。" : "非密钥设置会记住。API Key 仅保留在当前页面内存，不写入浏览器存储、历史记录或导出文件。"}</p></div>
    </div><footer className="dialog-footer"><span><KeyRound size={13} />保存入口位于模型框下方</span></footer></div></div>;
}

function ModelSaveActions({ saving, dirty, validation, onSave }: { saving: boolean; dirty: boolean; validation: string; onSave: () => void }) {
  return <div className="provider-model-save"><div className="provider-model-save-row"><p role="status">{dirty ? "模型已修改，尚未保存。" : "修改保存后用于下一轮生成。"}</p><button type="button" className="primary-button" disabled={saving} onClick={onSave}>{saving ? "保存中…" : "保存设置"}<Check size={15} /></button></div>{validation && <p role="alert" className="form-error">{validation}</p>}</div>;
}

interface ApiKeyFieldProps { id: string; value: string; onChange: (value: string) => void; configured: boolean; isDesktop: boolean; disabled: boolean; visible: boolean; onToggle: () => void; detect?: boolean; loading?: boolean; onDetect?: () => void }
function ApiKeyField({ id, value, onChange, configured, isDesktop, disabled, visible, onToggle, detect = false, loading = false, onDetect }: ApiKeyFieldProps) {
  return <div className="settings-field full-width"><label htmlFor={id}>API Key {configured && <span className="server-key-badge"><Check size={11} />服务端已配置</span>}</label><div className="provider-key-row"><div className="secret-input"><input id={id} type={visible ? "text" : "password"} value={value} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder={configured ? "留空使用服务端密钥，或填写当前厂商的 Key" : "填写当前厂商的 API Key"} autoComplete="off" spellCheck={false} data-lpignore="true" /><button type="button" className="icon-button" disabled={disabled} onClick={onToggle} aria-label={visible ? "隐藏 API Key" : "显示 API Key"}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div>{detect && <button type="button" className="secondary-button" disabled={disabled || loading} onClick={onDetect}>{loading ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}检测</button>}</div><small>{isDesktop ? "保存后由 macOS 钥匙串保护的密钥加密存储。" : "仅保留在当前页面内存，刷新或关闭页面后清除。"}</small></div>;
}
