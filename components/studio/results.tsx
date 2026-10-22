"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, ArrowDownToLine, Check, ChevronDown, Copy, Crown, FlaskConical, LoaderCircle, RefreshCw, Settings2, ShieldCheck, Sparkles, Star } from "lucide-react";
import { DIRECTION_LABELS, type Candidate, type CandidateScore, type Connection, type SessionRecord } from "@/lib/types";
import { brandForConnection } from "./model-brand";
import { ModelLogo } from "./model-logo";
import { blindFailure, blindLabel, orderedCandidateIds } from "./blind-label";
export { brandForConnection } from "./model-brand";
import { GlassButton } from "./liquid-glass";
import "./compact-results.css";

interface Props { session: SessionRecord; connections: Connection[]; pending: string[]; judging: boolean; running: boolean; onRetry: (id: string) => void; onRetryJudge: () => void; onSettings: () => void; onFavorite: () => void; onNotice: (message: string) => void }
async function downloadText(text: string, filename: string): Promise<boolean> { if (window.peDesktop?.isDesktop) { const result = await window.peDesktop.exportMarkdown(text, filename); if (result.canceled) return false; if (!result.ok) throw new Error(result.error || "文件保存失败，请重试。"); return true; } const blob = new Blob([text], { type: "text/markdown;charset=utf-8" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); return true; }
async function copyText(text: string) { if (window.peDesktop?.isDesktop) { const result = await window.peDesktop.copyText(text); if (!result.ok) throw new Error("复制未完成，请重试。"); return; } if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; } const el = document.createElement("textarea"); el.value = text; el.style.position = "fixed"; el.style.opacity = "0"; document.body.appendChild(el); el.select(); const done = document.execCommand("copy"); el.remove(); if (!done) throw new Error("浏览器不支持自动复制，请展开后手动选择文本。"); }
const scoreValue = (value: number) => Number.isFinite(value) ? Math.round(Math.max(0, Math.min(100, value)) * 10) / 10 : 0;

export function Results({ session, connections, pending, judging, running, onRetry, onRetryJudge, onSettings, onFavorite, onNotice }: Props) {
  const [revealedSessionId, setRevealedSessionId] = useState<string | null>(null);
  const modelsRevealed = revealedSessionId === session.id;
  const revealModels = () => setRevealedSessionId(session.id);
  const report = session.judge;
  const ready = session.candidates.filter(c => c.status === "success").length;
  const candidateIds = orderedCandidateIds(session.demo ? session.candidates.map(c => c.id) : Array.from(new Set([...connections.map(c => c.id), ...session.candidates.map(c => c.id)])), session.candidateOrder);
  const labelOrder = session.candidateOrder;
  const recommended = report?.status === "complete" && report.candidates.find(score => score.candidateId === report.recommendedId)?.eligible
    ? session.candidates.find(c => c.id === report.recommendedId && c.status === "success") : undefined;
  const complete = report?.status === "complete";
  const reviewSummary = complete ? `${report.candidates.length} 份提示词已${session.demo ? "完成示例评分" : "评分"}。${recommended ? `本次推荐 ${blindLabel(recommended.id, labelOrder)}。` : report.tiedIds.length > 1 ? "多份结果接近，可选择更适合的一份。" : "可以按需要选择使用。"}` : "评审尚未完成，已有提示词仍可使用。";
  const progress = judging ? 85 : running ? Math.max(8, (3 - pending.length) / 3 * 75) : 100;
  async function exportAll() {
    revealModels();
    const text = [`# PE Studio${session.demo ? " · 演示数据（非真实 API 结果）" : ""}`, `方向：${DIRECTION_LABELS[session.brief.direction]}`, `原始想法：${session.brief.input}`, `目标模型：${session.brief.targetModel || "通用"}`, `创建时间：${session.createdAt}`, "", ...candidateIds.flatMap(id => { const c = session.candidates.find(value => value.id === id); return c ? [`## ${blindLabel(id, labelOrder)} · ${c.provider} · ${c.model}`, c.status === "error" ? `生成失败：${c.error}` : c.prompt, "", "改写说明：", ...c.changes.map(s => `- ${s}`), "补充假设：", ...c.assumptions.map(s => `- ${s}`), ""] : []; }), report ? `评审${session.demo ? "（示例，非实测）" : ""}：${reviewSummary}` : "评审尚未完成。"].join("\n");
    try { if (await downloadText(text, `PE-Studio-${session.demo ? "示例-" : ""}${session.id}.md`)) onNotice("已导出本轮提示词，文件不含连接密钥。"); } catch (error) { onNotice(error instanceof Error ? error.message : "导出未完成，请重试。"); }
  }
  return <>
    <div className="results-header"><div><div className="section-heading"><h2><span className="step-index">03</span>{running ? "好提示词，正在发生" : "同一个想法，三种表达"}</h2></div><p>{running ? judging ? "三个模型已完成，正在进行 Jev 独立评审。" : "模型正在独立生成，结果会陆续出现在下方。" : `${DIRECTION_LABELS[session.brief.direction]} · ${session.brief.targetModel || "通用目标模型"} · ${ready} 份候选已生成`}</p></div><div className="result-tools">{!modelsRevealed && <button type="button" className="secondary-button" onClick={revealModels}>显示模型</button>}{!session.demo && <button className={session.favorite ? "secondary-button favorited" : "secondary-button"} disabled={running || !ready} onClick={onFavorite}><Star size={14} fill={session.favorite ? "currentColor" : "none"} />{session.favorite ? "已收藏" : "收藏"}</button>}<button className="secondary-button" onClick={() => void exportAll()} disabled={running || !ready}><ArrowDownToLine size={14} />显示模型并导出</button></div></div>
    {session.demo && <div className="demo-banner"><FlaskConical size={18} /><div><strong>你正在查看完整示例</strong><p>提示词与分数均为演示数据，未调用真实 API。点击上方「开始生成」才会运行你的模型。</p></div><span>DEMO</span></div>}
    {running && <div className="run-progress" role="status"><div><LoaderCircle size={15} className="spin" /><strong>{judging ? "Jev 正在多维度评审" : `并行生成中 · ${3 - pending.length}/3 已返回`}</strong><span>{judging ? "比较意图、约束与适配性" : "你可以保留已完成结果并随时停止"}</span></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></div>}
    {complete && <div className="judge-summary"><span className="jev-logo">j.</span><div><div className="judge-summary-title"><strong>{session.demo ? "Jev 示例评审" : "Jev 的比较结果"}</strong>{recommended && <span><Crown size={12} />{blindLabel(recommended.id, labelOrder)} {session.demo ? "示例推荐" : "更贴合本次需求"}</span>}{!recommended && report.tiedIds.length > 1 && <span>多份候选接近</span>}</div><p>{reviewSummary}</p></div><span className="review-label"><ShieldCheck size={13} />{session.demo ? "示例分数" : "已完成评审"}</span></div>}
    {!running && !complete && <div className="judge-unavailable"><AlertCircle size={19} /><div><strong>评审尚未完成 · 当前结果未评分</strong><p>{reviewSummary}</p></div><div><button className="text-button" onClick={onSettings}><Settings2 size={13} />检查设置</button>{ready >= 1 && !session.demo && <button className="secondary-button" onClick={onRetryJudge}><RefreshCw size={13} />重试评审</button>}</div></div>}
    <div className={`candidate-grid ${recommended ? "has-recommendation" : ""}`}>{candidateIds.map((id, index) => <CandidateCard key={`${session.id}-${id}`} candidate={session.candidates.find(c => c.id === id)} connection={connections.find(c => c.id === id)} index={index} letter={blindLabel(id, labelOrder)} revealed={modelsRevealed} pending={pending.includes(id)} running={running} demo={session.demo} score={complete ? report.candidates.find(c => c.candidateId === id) : undefined} recommended={report?.recommendedId === id && complete} tied={Boolean(complete && report.tiedIds.includes(id))} onRetry={() => onRetry(id)} onNotice={onNotice} />)}</div>
    <p className="evaluation-note"><ShieldCheck size={13} />{session.demo ? "所有示例分数仅展示界面，不表示这些模型的真实能力或测评结果。" : "Jev 评估的是提示词本身。最终效果仍取决于目标模型与实际运行结果。"}</p>
  </>;
}

interface CardProps { candidate?: Candidate; connection?: Connection; index: number; letter: string; revealed: boolean; pending: boolean; running: boolean; demo: boolean; score?: CandidateScore; recommended: boolean; tied: boolean; onRetry: () => void; onNotice: (message: string) => void }
function CandidateCard({ candidate, connection, letter, revealed, pending, running, demo, score, recommended, tied, onRetry, onNotice }: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showScores, setShowScores] = useState(false);
  const brand = brandForConnection(candidate || connection || {});
  const provider = revealed ? `${letter} · ${brand.name}` : letter;
  const model = candidate?.model || connection?.model;
  const success = candidate?.status === "success";
  async function copy() {
    if (!candidate) return;
    try { await copyText(candidate.prompt); setCopied(true); onNotice("提示词已复制，可以粘贴到目标模型中使用。"); setTimeout(() => setCopied(false), 2000); }
    catch (error) { onNotice(error instanceof Error ? error.message : "复制未完成，请手动选择文本。"); }
  }
  return <article className={`candidate-card ${recommended ? "recommended" : ""} ${pending ? "loading-card" : ""}`}>
    {recommended && <div className="recommendation-ribbon"><Sparkles size={12} />{demo ? "示例推荐" : "Jev 推荐"}<span>更贴合本次需求</span></div>}
    <div className="candidate-header"><div><h3 className="model-identity-inline">{provider}{revealed && <ModelLogo brand={brand} />}</h3>{revealed && <p title={model}>{model}</p>}</div></div>
    {pending ? <div className="candidate-loading"><div className="loading-label"><LoaderCircle size={16} className="spin" />正在打磨你的提示词</div><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line short" /><div className="skeleton-line" /><div className="skeleton-line medium" /><p>整理意图、补充结构，让表达更清楚。</p></div> : success ? <>
      <div className="candidate-score-row">{score ? <><span className="score-number">{scoreValue(score.score)}<small>/100</small></span><div className="score-name"><strong>{demo ? "示例评分" : "综合评分"}</strong><span>{tied ? "与其他候选接近" : "Jev 多维度比较"}</span></div><button aria-expanded={showScores} className="score-expand" onClick={() => setShowScores(!showScores)} aria-label={showScores ? "收起评分维度" : "展开评分维度"}><ChevronDown size={15} className={showScores ? "rotate-180" : ""} /></button></> : <><span className="unscored"><span />{running ? "等待评审" : "未评分"}</span><span className="latency">{candidate.latencyMs ? `${(candidate.latencyMs / 1000).toFixed(1)}s` : ""}</span></>}</div>
      {score && <div className="overall-score-track"><span style={{ width: `${scoreValue(score.score)}%` }} /></div>}
      {score && showScores && <div className="dimension-scores">{score.dimensions.map(d => <div key={d.id}><div><span>{d.label}</span><strong>{scoreValue(d.score)}</strong></div><div className="dimension-track"><span style={{ width: `${scoreValue(d.score)}%` }} /></div></div>)}</div>}
      <div className="prompt-label"><span>PROMPT</span><span>{candidate.prompt.length.toLocaleString()} 字符</span></div><div className={`candidate-prompt ${expanded ? "expanded" : ""}`}><pre>{candidate.prompt}</pre></div><button className="expand-prompt" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起完整提示词" : "展开完整提示词"}<ChevronDown size={13} className={expanded ? "rotate-180" : ""} /></button>
      <div className="candidate-notes"><details><summary><span><Check size={13} />做了哪些优化</span><ChevronDown size={13} /></summary><ul>{candidate.changes.length ? candidate.changes.map((change, i) => <li key={i}>{change}</li>) : <li>模型未提供改写说明。</li>}</ul></details><details><summary><span><CircleAssumption />补充了哪些假设</span><ChevronDown size={13} /></summary><ul>{candidate.assumptions.length ? candidate.assumptions.map((assumption, i) => <li key={i}>{assumption}</li>) : <li>未增加额外假设。</li>}</ul></details></div><div className="candidate-actions"><button className={recommended ? "copy-button primary-copy" : "copy-button"} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? "已复制" : "复制提示词"}</button><button className="icon-button" title="导出此提示词" aria-label={`导出 ${provider} 提示词`} onClick={() => { void downloadText(`${demo ? "示例提示词（非真实 API 结果）\n\n" : ""}${candidate.prompt}`, `PE-${provider.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_")}.md`).then(saved => { if (saved) onNotice("提示词已导出。"); }).catch(error => onNotice(error instanceof Error ? error.message : "导出失败，请重试。")); }}><ArrowDownToLine size={16} /></button></div>
    </> : <div className="candidate-error"><span><AlertCircle size={23} /></span><h4>{candidate ? "这份提示词还没完成" : "等待模型返回"}</h4><p>{revealed ? candidate?.error || "本次请求尚未返回结果。" : blindFailure(candidate?.error)}</p>{!demo && <button className="secondary-button" disabled={running} onClick={onRetry}><RefreshCw size={14} />单独重试</button>}<small>其他模型的结果会为你保留</small></div>}
  </article>;
}
function CircleAssumption() { return <span className="assumption-symbol">?</span>; }

export interface CompactResultsProps {
  session: SessionRecord;
  connections: Pick<Connection, "id" | "label" | "model">[];
  generatingIds: string[];
  busy: boolean;
  judging: boolean;
  onOpenCandidate: (id: string, focus?: boolean) => void;
  activeCandidateId?: string;
  openedCandidateIds?: string[];
  modelsRevealed?: boolean;
  onRevealModels?: () => void;
  onRetry?: (id: string) => void;
  onRetryJudge?: () => void;
  onNotice?: (message: string) => void;
}

/** Results open in independent native bubbles. This strip never owns their content. */
export function CompactResults(props: CompactResultsProps) {
  return <CompactResultsSession key={props.session.id} {...props} />;
}

function CompactResultsSession({ session, connections, generatingIds, busy, judging, activeCandidateId, openedCandidateIds = [], modelsRevealed = false, onOpenCandidate, onRevealModels }: CompactResultsProps) {
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const candidateIds = orderedCandidateIds(session.demo
    ? session.candidates.map(candidate => candidate.id)
    : Array.from(new Set([...connections.map(connection => connection.id), ...session.candidates.map(candidate => candidate.id)]))
  , session.candidateOrder).slice(0, 3);
  const labelOrder = session.candidateOrder;
  const report = session.judge?.status === "complete" ? session.judge : null;
  const scores = new Map(report?.candidates.map(score => [score.candidateId, score]) || []);
  const recommendedId = report?.recommendedId && scores.get(report.recommendedId)?.eligible
    && session.candidates.some(candidate => candidate.id === report.recommendedId && candidate.status === "success")
    && !generatingIds.includes(report.recommendedId) ? report.recommendedId : null;
  // A late score can highlight a recommendation, but never opens or changes a
  // result after the user has chosen one. Each result window owns its reading state.
  const activeId = activeCandidateId && candidateIds.includes(activeCandidateId) ? activeCandidateId
    : selectedId && candidateIds.includes(selectedId) ? selectedId : recommendedId || candidateIds[0];
  const activeIndex = Math.max(0, candidateIds.indexOf(activeId));
  function open(id: string, focus = true) { setSelectedId(id); onOpenCandidate(id, focus); }
  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (!candidateIds.length) return;
    const focusedIndex = buttonRefs.current.findIndex(button => button === event.target);
    const current = focusedIndex < 0 ? activeIndex : focusedIndex;
    let next: number;
    if (event.key === "ArrowRight") next = (current + 1) % candidateIds.length;
    else if (event.key === "ArrowLeft") next = (current - 1 + candidateIds.length) % candidateIds.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = candidateIds.length - 1;
    else return;
    event.preventDefault();
    buttonRefs.current[next]?.focus();
    open(candidateIds[next], false);
  }
  return <section className="compact-results" aria-label="模型生成结果">
    <div className="compact-results-tabs" role="toolbar" aria-label="打开模型提示词" onKeyDown={handleKeys}>
      {candidateIds.map((id, index) => {
        const candidate = session.candidates.find(value => value.id === id);
        const connection = connections.find(value => value.id === id);
        const pending = generatingIds.includes(id);
        const opened = openedCandidateIds.includes(id);
        const revealed = modelsRevealed;
        const letter = blindLabel(id, labelOrder);
        const brand = brandForConnection((pending ? connection : candidate) || connection || candidate || {});
        const displayName = revealed ? `${letter} · ${brand.name}` : letter;
        const success = candidate?.status === "success" && !pending;
        const score = success ? scores.get(id) : undefined;
        const validScore = score && Number.isFinite(score.score) && score.score >= 0 && score.score <= 100 ? score : undefined;
        const state = pending ? "生成中" : candidate?.status === "error" ? "生成失败"
          : validScore ? `${session.demo ? "示例 " : ""}${scoreValue(validScore.score)} 分`
          : success ? judging || busy ? "评审中" : "已生成" : "等待生成";
        const badge = recommendedId === id ? session.demo ? "示例推荐" : "推荐"
          : report && report.tiedIds.length > 1 && report.tiedIds.includes(id) && score?.eligible ? "并列" : null;
        return <GlassButton key={id} ref={element => { buttonRefs.current[index] = element; }} type="button"
          className={`compact-results-tab model-brand-${revealed ? brand.tone : "custom"}${opened ? " is-active" : ""}`}
          aria-label={`${displayName}，${state}${badge ? `，${badge}` : ""}，${opened ? "收起" : "展开"}完整提示词`}
          aria-expanded={opened} aria-pressed={opened} tabIndex={activeId === id ? 0 : -1}
          title={revealed ? (pending ? connection?.model : candidate?.model) || connection?.model || brand.name : undefined} onClick={() => open(id)}>
          <span className="compact-results-brand"><span>{displayName}</span>{revealed && <ModelLogo brand={brand} />}</span>
          <span className="compact-results-tab-score">{pending && <LoaderCircle size={11} className="spin" aria-hidden="true" />}{state}</span>
          {badge && <span className="compact-results-tab-badge">{badge}</span>}
        </GlassButton>;
      })}
    </div>
    <div className="compact-results-reveal">{modelsRevealed ? <span>模型已显示</span> : onRevealModels && <GlassButton type="button" className="compact-reveal-model" aria-label="显示全部模型" onClick={onRevealModels}>显示模型</GlassButton>}</div>
  </section>;
}
