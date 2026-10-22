"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Copy, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { PublicStudioState, WorkspaceCommand } from "@/desktop/workspace-contract";
import { brandForConnection } from "./model-brand";
import { ModelLogo } from "./model-logo";
import { blindFailure, blindLabel } from "./blind-label";
import { useDesktopAppearance } from "./use-desktop-appearance";
import { GlassScene, GlassSurface, GlassButton } from "./liquid-glass";
import "./compact-results.css";

export interface ResultBubbleProps { resultId: string }

/** A read-only view of the task owner. It never starts a request or loads keys. */
export function ResultBubble({ resultId }: ResultBubbleProps) {
  useDesktopAppearance();
  const [state, setState] = useState<PublicStudioState | null>(null);
  const [feedback, setFeedback] = useState<{ identity: string; text: string } | null>(null);
  const [copiedIdentity, setCopiedIdentity] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [sending, setSending] = useState(false);
  const promptRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const copyBusy = useRef(false);
  const commandBusy = useRef(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  const session = state?.session;
  const candidate = session?.candidates.find(value => value.id === resultId);
  const connection = state?.runConnections?.find(value => value.id === resultId) || state?.config.writers.find(value => value.id === resultId);
  const pending = Boolean(state?.pending.includes(resultId));
  const brand = brandForConnection((pending ? connection : candidate) || connection || candidate || {});
  const model = (pending ? connection?.model : candidate?.model) || connection?.model || "";
  const letter = blindLabel(resultId, session?.candidateOrder);
  const revealed = Boolean(state?.modelsRevealed);
  const displayName = revealed ? `${letter} · ${brand.name}` : letter;
  const success = candidate?.status === "success" && !pending;
  const report = session?.judge?.status === "complete" ? session.judge : null;
  const returnedScore = success ? report?.candidates.find(value => value.candidateId === resultId) : undefined;
  const score = returnedScore && Number.isFinite(returnedScore.score) && returnedScore.score >= 0 && returnedScore.score <= 100 ? returnedScore : undefined;
  const recommended = Boolean(score?.eligible && report?.recommendedId === resultId);
  const tied = Boolean(score?.eligible && report && report.tiedIds.length > 1 && report.tiedIds.includes(resultId));
  const identity = `${session?.id || ""}:${resultId}`;
  const currentIdentity = useRef(identity);
  const notice = feedback?.identity === identity ? feedback.text : "";
  const copied = copiedIdentity === identity;

  // Score/config updates and native focus changes leave this DOM node, text
  // selection and scroll position untouched. Only a different task resets it.
  useLayoutEffect(() => {
    currentIdentity.current = identity;
    if (promptRef.current) promptRef.current.scrollTop = 0;
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, [identity]);

  useEffect(() => {
    const bridge = window.peDesktop;
    mounted.current = true;
    if (!bridge) return;
    let received = false;
    const unsubscribe = bridge.onStateChanged(next => { received = true; setState(next); });
    void bridge.getState().then(next => { if (mounted.current && !received) setState(next); }).catch(() => { if (mounted.current) setFeedback({ identity: currentIdentity.current, text: "暂时无法读取结果，请重新打开。" }); });
    return () => { mounted.current = false; unsubscribe(); if (copyTimer.current) clearTimeout(copyTimer.current); };
  }, []);

  async function copy() {
    if (!success || !candidate || copyBusy.current || !window.peDesktop) return;
    const copiedIdentity = identity;
    copyBusy.current = true; setCopying(true);
    try {
      const result = await window.peDesktop.copyText(candidate.prompt);
      if (!mounted.current || currentIdentity.current !== copiedIdentity) return;
      if (!result.ok) { setFeedback({ identity: copiedIdentity, text: "复制未完成，请重试。" }); return; }
      setCopiedIdentity(copiedIdentity); setFeedback({ identity: copiedIdentity, text: "完整提示词已复制" });
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => { setCopiedIdentity(null); setFeedback(null); }, 2200);
    } catch { if (mounted.current && currentIdentity.current === copiedIdentity) setFeedback({ identity: copiedIdentity, text: "复制未完成，请重试。" }); }
    finally { copyBusy.current = false; if (mounted.current) setCopying(false); }
  }
  async function command(value: WorkspaceCommand) {
    if (!window.peDesktop || (state?.running && value.type !== "reveal-models") || commandBusy.current) return;
    commandBusy.current = true; setSending(true);
    const commandIdentity = identity;
    try {
      const result = await window.peDesktop.sendCommand(value);
      if (mounted.current && currentIdentity.current === commandIdentity) setFeedback({ identity: commandIdentity, text: result.ok ? "" : "操作未完成，请稍后再试。" });
    } catch { if (mounted.current && currentIdentity.current === commandIdentity) setFeedback({ identity: commandIdentity, text: "操作未完成，请稍后再试。" }); }
    finally { commandBusy.current = false; if (mounted.current) setSending(false); }
  }
  async function close() {
    try { const result = await window.peDesktop?.closeResult(resultId); if (result && !result.ok) setFeedback({ identity, text: "关闭未完成，请重试。" }); }
    catch { setFeedback({ identity, text: "关闭未完成，请重试。" }); }
  }
  const reviewText = score ? `${session?.demo ? "示例 " : ""}${Math.round(score.score * 10) / 10} 分`
    : state?.judging && success ? "评审中" : success ? "尚未评分" : "";

  return <GlassScene className="pe-kit-result-scene"><GlassSurface radius={40} className={`pe-result-bubble model-brand-${revealed ? brand.tone : "custom"}`} role="region" aria-label={`${displayName} 提示词结果`}>
    <header className="result-bubble-header">
      <div className="result-bubble-identity"><strong title={revealed ? model : undefined}>{displayName}{revealed && <ModelLogo brand={brand} />}</strong></div>
      {!revealed && <GlassButton className="result-reveal-model" type="button" disabled={!state || sending} aria-label="显示全部模型" onClick={() => void command({ type: "reveal-models" })}>显示模型</GlassButton>}
      <GlassButton className="result-bubble-close" type="button" aria-label={`关闭 ${displayName} 结果`} onClick={() => void close()}><X size={14} aria-hidden="true" /></GlassButton>
    </header>
    <div className="result-bubble-meta" role="status" aria-live="polite">
      {reviewText && <span>{reviewText}</span>}
      {recommended && <span className="result-bubble-recommendation">{session?.demo ? "示例推荐" : "Jev 推荐"}</span>}
      {tied && !recommended && <span>并列</span>}
      {session?.demo && <span className="result-bubble-demo">演示内容 · 非真实 API 结果</span>}
    </div>
    {pending ? <div className="result-bubble-empty" role="status"><LoaderCircle size={19} className="spin" aria-hidden="true" /><p>正在生成提示词</p></div>
      : success && candidate ? <div ref={promptRef} className="result-bubble-prompt" tabIndex={0} aria-label={`${displayName} 完整提示词，可选择或滚动阅读`}><pre>{candidate.prompt}</pre></div>
      : <div className="result-bubble-empty"><p>{candidate?.status === "error" ? "这次生成未完成" : state ? "结果尚未生成" : "正在读取结果"}</p>{candidate?.status === "error" && <small>可以单独重试，其他结果会保留。</small>}{candidate?.status === "error" && candidate.error && (revealed ? <details className="result-bubble-diagnostic"><summary>查看连接详情</summary><p>{candidate.error}</p></details> : <small>{blindFailure(candidate.error)}</small>)}{candidate?.status === "error" && !session?.demo && <GlassButton className="result-bubble-retry" type="button" disabled={state?.running || sending} onClick={() => void command({ type: "retry-candidate", id: resultId })}><RefreshCw size={12} aria-hidden="true" />单独重试</GlassButton>}</div>}
    {success && session?.judge?.status === "unavailable" && <p className="result-bubble-review-note">评审未完成，已有提示词仍可使用。连接详情可在后台查看。</p>}
    <footer className="result-bubble-footer">
      <span className="result-bubble-feedback" role="status" aria-live="polite">{notice}</span>
      {success && !report && !state?.running && !session?.demo && <GlassButton className="result-bubble-retry" type="button" disabled={sending} onClick={() => void command({ type: "retry-judge" })}>重新评审</GlassButton>}
      <GlassButton className="result-bubble-copy" type="button" disabled={!success || copying} aria-label={`复制 ${displayName} 完整提示词`} onClick={() => void copy()}>{copied ? <Check size={13} aria-hidden="true" /> : copying ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? "已复制" : "复制"}</GlassButton>
    </footer>
  </GlassSurface></GlassScene>;
}

export default ResultBubble;
