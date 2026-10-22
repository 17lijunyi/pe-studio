"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, ArrowUpRight, Check, Copy, FlaskConical, History, Layers3, Plus, Settings2, ShieldCheck, SlidersHorizontal, Star, Trash2 } from "lucide-react";
import type { PublicStudioState, WorkspaceCommand, WorkspaceSection } from "@/desktop/workspace-contract";
import { DIRECTION_LABELS, type Brief, type Connection, type JudgeConnection, type SessionRecord } from "@/lib/types";
import { DIRECTION_PRESETS } from "@/lib/prompts";
import { SettingsDialog, type ServerConfig, type SettingsDialogController } from "./settings-dialog";
import { useDesktopAppearance } from "./use-desktop-appearance";
import { brandForConnection } from "./model-brand";
import { ModelLogo } from "./model-logo";
import { blindFailure, blindLabel, orderedCandidateIds } from "./blind-label";
import { GlassButton, GlassScene, GlassSurface } from "./liquid-glass";


export default function DesktopWorkspace() {
  useDesktopAppearance();
  const [state, setState] = useState<PublicStudioState | null>(null);
  const [section, setSection] = useState<WorkspaceSection>("settings");
  const [notice, setNotice] = useState("");
  const [shortcut, setShortcut] = useState("Control+Q");
  const [serverConfig, setServerConfig] = useState<ServerConfig>({});
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [judge, setJudge] = useState<JudgeConnection | null>(null);
  const [credentialsAvailable, setCredentialsAvailable] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const settingsControllerRef = useRef<SettingsDialogController>(null);
  const [settingsEpoch, setSettingsEpoch] = useState(0);
  const [editedTask, setEditedTask] = useState<Brief | null>(null);
  const [taskDirty, setTaskDirty] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  const [revealedRecordId, setRevealedRecordId] = useState<string | null>(null);

  useEffect(() => {
    const desktop = window.peDesktop!;
    let active = true;
    let received = false;
    const update = (value: PublicStudioState) => { received = true; if (active) setState(value); };
    void desktop.getState().then(value => { if (value && !received) update(value); });
    const unsubscribe = desktop.onStateChanged(update);
    const unsection = desktop.onWorkspaceSection(value => setSection(value));
    const unaction = desktop.onSettingsAction(request => {
      void (async () => {
        let ok = false;
        try {
          const controller = settingsControllerRef.current;
          if (controller) {
            if (request.action === "save") ok = await controller.saveChanges();
            else { controller.discardChanges(); ok = true; }
          }
        } catch { setNotice("设置操作未完成，修改已保留，请重试。"); }
        await desktop.completeSettingsAction(request.requestId, ok);
      })().catch(() => { if (active) setNotice("未能确认设置状态，请重试。"); });
    });
    void desktop.getShortcut().then(value => { if (active) setShortcut(value.accelerator); });
    void fetch("/api/config").then(response => response.json()).then(value => { if (active) setServerConfig((value as { configured?: ServerConfig }).configured || {}); }).catch(() => {});
    return () => { active = false; unsubscribe(); unsection(); unaction(); void desktop.setSettingsModelDirty(false).catch(() => {}); };
  }, []);

  useEffect(() => {
    if (!state || connections || state.credentialsStatus === "loading") return;
    let active = true;
    void window.peDesktop!.getCredentials().then(keys => {
      if (!active) return;
      setConnections(state.config.writers.map(c => ({ ...c, apiKey: keys.writers[c.id] || "" })));
      setJudge({ ...state.config.judge, apiKey: keys.jev || "" });
      setCredentialsAvailable(state.credentialsStatus === "ready");
    }).catch(() => {
      if (!active) return;
      setConnections(state.config.writers.map(c => ({ ...c, apiKey: "" })));
      setJudge({ ...state.config.judge, apiKey: "" });
      setCredentialsAvailable(false);
    });
    return () => { active = false; };
  }, [state, connections]);

  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(""), 6000); return () => clearTimeout(timer); }, [notice]);

  async function command(value: WorkspaceCommand) {
    const result = await window.peDesktop!.sendCommand(value);
    if (!result.ok) setNotice(result.error || "操作尚未完成，请重试。");
    return result.ok;
  }

  async function saveSettings(writers: Connection[], judgeDraft: JudgeConnection): Promise<boolean> {
    if (savingRef.current) return false;
    if (!credentialsAvailable) { setNotice("暂不能确认保存，请先恢复原有密钥读取。当前修改已保留，可继续编辑或放弃修改。"); return false; }
    savingRef.current = true; setSaving(true);
    const config = { writers: writers.map(({ id, label, protocol, model, baseUrl }) => ({ id, label, protocol, model, baseUrl })), judge: { model: judgeDraft.model, baseUrl: judgeDraft.baseUrl } };
    try {
      // Key values travel only through the existing protected credential channel.
      const saved = await window.peDesktop!.commitSettings(config, { writers: Object.fromEntries(writers.map(c => [c.id, c.apiKey])), jev: judgeDraft.apiKey });
      if (saved.applied !== true) { setNotice(saved.error || "密钥格式无效，设置未应用。"); return false; }
      if (!saved.ok || saved.persisted === false) { setNotice("密钥未持久保存，设置尚未确认，可继续编辑或放弃修改。"); return false; }
      setConnections(writers); setJudge(judgeDraft); setSettingsEpoch(value => value + 1);
      setNotice("设置已保存，密钥已加密。正在运行的任务继续使用原配置。");
      return true;
    } catch { setNotice("设置尚未保存，请检查钥匙串或重试。草稿仍然保留。"); return false; }
    finally { savingRef.current = false; setSaving(false); }
  }

  async function exportText(text: string, name: string) {
    try {
      const result = await window.peDesktop!.exportMarkdown(text, name);
      if (result.ok) setNotice("已导出 Markdown。");
      else if (!result.canceled) setNotice(result.error || "导出失败，请重试。");
    } catch { setNotice("导出失败，请重试。"); }
  }
  async function copy(text: string) {
    try { const result = await window.peDesktop!.copyText(text); setNotice(result.ok ? "已复制完整提示词。" : "复制未完成，请重试。"); }
    catch { setNotice("复制未完成，请重试。"); }
  }
  async function newSession() {
    if (await command({ type: "new-session" })) window.peDesktop!.showPanel();
  }

  const inspected = state?.history.find(record => record.id === inspectedId) || state?.session;
  const records = state?.history.filter(record => !favoritesOnly || record.favorite) || [];
  const inspectedIds = orderedCandidateIds(inspected?.candidates.map(candidate => candidate.id) || [], inspected?.candidateOrder);
  const historyModelsRevealed = revealedRecordId === inspected?.id;
  function revealHistory() {
    if (inspected) setRevealedRecordId(inspected.id);
  }
  function exportWithIdentities(record: SessionRecord) {
    setRevealedRecordId(record.id);
    void exportText(recordMarkdown(record), `PE-Studio-${record.id}.md`);
  }
  const taskDraft = taskDirty ? editedTask : state?.brief || null;
  const updateTask = <K extends keyof Brief>(key: K, value: Brief[K]) => { if (taskDraft) setEditedTask({ ...taskDraft, [key]: value }); setTaskDirty(true); };

  return <GlassScene className="pe-kit-workbench-scene"><GlassSurface className="pe-workspace" radius={40}>
    <aside className="pe-workspace-sidebar"><div className="pe-workspace-brand"><span><Layers3 size={20} /></span><strong>PE Studio<small>让想法更清楚</small></strong></div><nav aria-label="后台导航">{([{ id: "tasks", label: "当前任务", icon: SlidersHorizontal }, { id: "library", label: "历史与收藏", icon: History }, { id: "settings", label: "模型与设置", icon: Settings2 }] as const).map(({ id, label, icon: Icon }) => <GlassButton key={id} aria-current={section === id ? "page" : undefined} className={section === id ? "is-active" : ""} onClick={() => void window.peDesktop!.openWorkspace(id)}><Icon size={17} />{label}</GlassButton>)}</nav><div className="pe-workspace-bottom"><GlassButton className="pe-glass-button" onClick={() => window.peDesktop!.showPanel()}><ArrowUpRight size={16} />回到小窗</GlassButton><p>{shortcut} 随时呼出</p></div></aside>
    <main className="pe-workspace-main">
      {!state ? <div className="pe-workspace-loading" role="status">正在连接工作台…</div> : <>
        <section className="pe-workspace-pane" hidden={section !== "tasks"}>
          <header className="pe-workspace-heading"><div><p>本轮需求</p><h1>给提示词一点方向</h1></div><GlassButton className="pe-glass-button" disabled={state.running} onClick={() => void newSession()}><Plus size={16} />新建</GlassButton></header>
          {taskDraft && <GlassSurface className="pe-task-card" radius={22}><div className="pe-task-grid"><label>目标模型 <small>自由填写，建议仅供参考</small><input id="workspace-target-model" value={taskDraft.targetModel} maxLength={200} list="workspace-targets" placeholder="通用，或任意目标模型" onChange={e => updateTask("targetModel", e.target.value)} /><datalist id="workspace-targets">{DIRECTION_PRESETS[taskDraft.direction].targets.map(target => <option key={target} value={target} />)}</datalist></label><label>输出语言<select value={taskDraft.outputLanguage} onChange={e => updateTask("outputLanguage", e.target.value as Brief["outputLanguage"])}><option value="zh">中文</option><option value="en">English</option></select></label><label className="pe-task-full">优化强度<div className="pe-task-segment">{([{ id: "faithful", label: "保留原意" }, { id: "balanced", label: "标准优化" }, { id: "creative", label: "创意扩展" }] as const).map(item => <GlassButton key={item.id} aria-pressed={taskDraft.intensity === item.id} onClick={() => updateTask("intensity", item.id)}>{item.label}</GlassButton>)}</div></label><label className="pe-task-full">补充背景<textarea rows={3} maxLength={6000} value={taskDraft.context} placeholder="受众、使用场景、已有素材…" onChange={e => updateTask("context", e.target.value)} /></label><label className="pe-task-full">硬性要求<textarea rows={3} maxLength={4000} value={taskDraft.constraints} placeholder="必须保留的内容、不能出现的元素、字数限制…" onChange={e => updateTask("constraints", e.target.value)} /></label></div><footer><p>{state.running ? "本轮已开始。修改将用于下一次生成。" : "这些补充用于当前输入，生成时会保存需求快照。"}</p><GlassButton className="pe-glass-button pe-primary" disabled={!taskDirty} onClick={() => { void command({ type: "update-brief", patch: { targetModel: taskDraft.targetModel, context: taskDraft.context, constraints: taskDraft.constraints, intensity: taskDraft.intensity, outputLanguage: taskDraft.outputLanguage } }).then(ok => { if (ok) { setTaskDirty(false); setNotice("本轮补充已应用。"); } }); }}><Check size={16} />应用补充</GlassButton></footer></GlassSurface>}
          <div className="pe-workspace-help"><h2>轻巧一点，专注一点</h2><p>按快捷键输入，三个模型分别优化，Jev 比较评分。点击外部或按 Esc 收起小窗，后台任务会继续。</p><GlassButton className="pe-glass-button" disabled={state.running} onClick={() => { void command({ type: "open-demo" }).then(ok => { if (ok) window.peDesktop!.showPanel(); }); }}><FlaskConical size={16} />查看演示</GlassButton><p className="pe-help-note">演示内容和分数为手工示例，不会调用 API。生图和视频方向输出的是提示词。</p></div>
          {state.session && <p className="pe-workspace-status" role="status">{state.running ? state.judging ? "Jev 正在评审，小窗收起后仍会继续。" : "三个模型正在生成，小窗收起后仍会继续。" : "本轮结果已保留，可到历史与收藏查看详情。"}</p>}
        </section>
        <section className="pe-workspace-pane" hidden={section !== "library"}>
          <header className="pe-workspace-heading"><div><p>本机保存 · 最近 20 条</p><h1>留下值得再用的表达</h1></div><GlassButton className="pe-glass-button" aria-pressed={favoritesOnly} onClick={() => setFavoritesOnly(value => !value)}><Star size={16} fill={favoritesOnly ? "currentColor" : "none"} />{favoritesOnly ? "只看收藏" : "全部记录"}</GlassButton></header>
          <div className="pe-library-layout"><div className="pe-library-list">{records.length ? records.map(record => <article className={inspected?.id === record.id ? "is-selected" : ""} key={record.id}><button className="pe-library-record" onClick={() => { setInspectedId(record.id); setRevealedRecordId(null); }}><span>{DIRECTION_LABELS[record.brief.direction]} · {new Date(record.createdAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</span><strong>{record.brief.input}</strong><small>{record.candidates.filter(c => c.status === "success").length} 份结果 · {record.judge?.status === "complete" ? "已评审" : "未评分"}</small></button><div className="pe-library-record-actions"><GlassButton aria-label={record.favorite ? "取消收藏" : "收藏"} disabled={state.running} onClick={() => void command({ type: "toggle-favorite", id: record.id })}><Star size={14} fill={record.favorite ? "currentColor" : "none"} /></GlassButton><GlassButton aria-label="删除记录" disabled={state.running} onClick={() => void command({ type: "delete-session", id: record.id })}><Trash2 size={14} /></GlassButton></div></article>) : <div className="pe-library-empty">{favoritesOnly ? "还没有收藏的记录" : "生成后，完整结果会保存在这里"}</div>}</div>
            <div className="pe-library-detail">{inspected ? <><header><div><span>{inspected.demo ? "演示 · 非真实评分" : "完整结果"}</span><h2>{inspected.brief.input}</h2></div><GlassButton className="pe-glass-button" disabled={state.running} onClick={() => { void command({ type: "restore-session", id: inspected.id }).then(ok => { if (ok) window.peDesktop!.showPanel(); }); }}><ArrowUpRight size={15} />打开小窗</GlassButton></header><p className="pe-review-summary">{reviewSummary(inspected)}</p><div className="pe-history-tools">{!historyModelsRevealed && <GlassButton type="button" className="pe-glass-button" onClick={revealHistory}>显示模型</GlassButton>}<GlassButton className="pe-glass-button" onClick={() => exportWithIdentities(inspected)}><ArrowDownToLine size={15} />显示模型并导出全部</GlassButton></div>{inspectedIds.map(id => {
              const candidate = inspected.candidates.find(item => item.id === id)!;
              const score = inspected.judge?.status === "complete" ? inspected.judge.candidates.find(item => item.candidateId === id) : undefined;
              const letter = blindLabel(id, inspected?.candidateOrder);
              const revealed = historyModelsRevealed;
              const brand = brandForConnection(candidate);
              return <article className="pe-detail-candidate" key={`${inspected.id}:${id}`}>
                <header><strong title={revealed ? candidate.model : undefined}>{revealed ? `${letter} · ${brand.name}` : letter}{revealed && <ModelLogo brand={brand} />}</strong><span>{score ? `${Math.round(score.score)} 分` : "未评分"}{inspected.judge?.recommendedId === id ? " · 推荐" : ""}</span></header>
                {revealed && <small>{candidate.model}</small>}
                {candidate.status === "success" ? <><pre>{candidate.prompt}</pre><div className="pe-detail-actions"><GlassButton className="pe-glass-button" onClick={() => void copy(candidate.prompt)}><Copy size={14} />复制</GlassButton><GlassButton className="pe-glass-button" onClick={() => void exportText(candidate.prompt, `PE-${letter}.md`)}><ArrowDownToLine size={14} />仅导出提示词</GlassButton></div><details><summary>改写说明与补充假设</summary><ul>{candidate.changes.map((item, i) => <li key={`change-${i}`}>{item}</li>)}</ul><p>{candidate.assumptions.length ? candidate.assumptions.join("；") : "未增加额外假设。"}</p></details>{score && <details><summary>评分维度</summary><ul>{score.dimensions.map(item => <li key={item.id}>{item.label} · {Math.round(item.score)} 分</li>)}</ul></details>}</> : <p className="pe-inline-warning">{revealed ? candidate.error || "请求尚未返回" : blindFailure(candidate.error)}</p>}
              </article>;
            })}<p className="pe-help-note">Jev 评估提示词本身，最终效果取决于目标模型与实际运行。</p></> : <div className="pe-library-empty">选择记录，查看三份结果和详细评分</div>}</div></div>
        </section>
        <section className="pe-workspace-pane pe-settings-pane" hidden={section !== "settings"}>
          {connections && judge ? <SettingsDialog key={settingsEpoch} embedded saving={saving} connections={connections} judge={judge} serverConfig={serverConfig} isDesktop credentialsAvailable={credentialsAvailable} shortcut={shortcut} onShortcutChange={setShortcut} controllerRef={settingsControllerRef} onModelDirtyChange={dirty => { void window.peDesktop!.setSettingsModelDirty(dirty).catch(() => setNotice("未能同步模型修改状态，请重试。")); }} onSave={saveSettings} onClose={() => { setSettingsEpoch(value => value + 1); setNotice("未保存的模型修改已取消。"); }} /> : <div className="pe-workspace-loading" role="status">正在安全读取模型连接…</div>}
          <div className="pe-workspace-system"><ShieldCheck size={16} /><p>外观跟随 macOS。深浅色、减少透明度、减少动态效果与增强对比度均读取系统偏好。密钥和记录只保存在这台 Mac。</p></div>
        </section>
      </>}
    </main>
    {notice && <div className="pe-workspace-toast" role="status">{notice}</div>}
  </GlassSurface></GlassScene>;
}

function recordMarkdown(record: SessionRecord) {
  const ids = orderedCandidateIds(record.candidates.map(candidate => candidate.id), record.candidateOrder);
  return [`# PE Studio${record.demo ? " · 演示数据（非真实 API 结果）" : ""}`, `方向：${DIRECTION_LABELS[record.brief.direction]}`, `原始想法：${record.brief.input}`, `目标模型：${record.brief.targetModel || "通用"}`, "", ...ids.flatMap(id => { const candidate = record.candidates.find(item => item.id === id)!; return [`## ${blindLabel(id, record.candidateOrder)} · ${brandForConnection(candidate).name} · ${candidate.model}`, candidate.status === "success" ? candidate.prompt : `生成失败：${candidate.error}`, "", "改写说明：", ...candidate.changes.map(item => `- ${item}`), "补充假设：", ...candidate.assumptions.map(item => `- ${item}`), ""]; }), `评审：${reviewSummary(record)}`].join("\n");
}

function reviewSummary(record: SessionRecord): string {
  const report = record.judge;
  if (!report || report.status !== "complete") return "评审尚未完成，当前结果未评分。";
  const count = report.candidates.length;
  if (report.recommendedId) return `Jev 已完成 ${count} 份评分，推荐结果已标出。你可以选择任意一份使用。`;
  if (report.tiedIds.length > 1) return `Jev 已完成 ${count} 份评分，领先结果并列。`;
  return `Jev 已完成 ${count} 份评分，可根据内容自行选择。`;
}
