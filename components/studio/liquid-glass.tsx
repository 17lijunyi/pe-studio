"use client";

import { createContext, createElement, forwardRef, useCallback, useContext, useEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type ForwardedRef, type HTMLAttributes } from "react";
import type { BackgroundPainter, LiquidGlassSceneElement, MaterialName } from "@/vendor/liquid-glass/liquid-glass";
import "./liquid-glass.css";

type GlassLibrary = typeof import("@/vendor/liquid-glass/liquid-glass");
let libraryPromise: Promise<GlassLibrary> | undefined;
function loadGlass() {
  libraryPromise ??= import("@/vendor/liquid-glass/liquid-glass.js");
  return libraryPromise;
}

interface GlassAppearance { dark: boolean; opaque: boolean; reduceMotion: boolean }
const initialAppearance: GlassAppearance = { dark: false, opaque: false, reduceMotion: false };
const GlassContext = createContext<GlassAppearance & { desktop: boolean; ready: boolean; refresh: () => void }>({ ...initialAppearance, desktop: false, ready: false, refresh: () => {} });

function useGlassAppearance() {
  const [appearance, setAppearance] = useState(initialAppearance);
  useEffect(() => {
    const root = document.documentElement;
    const media = {
      dark: matchMedia("(prefers-color-scheme: dark)"),
      transparency: matchMedia("(prefers-reduced-transparency: reduce)"),
      motion: matchMedia("(prefers-reduced-motion: reduce)"),
      contrast: matchMedia("(prefers-contrast: more)"),
      forced: matchMedia("(forced-colors: active)"),
    };
    const update = () => {
      const dark = root.dataset.theme ? root.dataset.theme === "dark" : media.dark.matches;
      const opaque = root.dataset.reduceTransparency === "true" || root.dataset.increaseContrast === "true" || media.transparency.matches || media.contrast.matches || media.forced.matches;
      const reduceMotion = root.dataset.reduceMotion === "true" || media.motion.matches;
      setAppearance(previous => previous.dark === dark && previous.opaque === opaque && previous.reduceMotion === reduceMotion ? previous : { dark, opaque, reduceMotion });
    };
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "data-reduce-transparency", "data-reduce-motion", "data-increase-contrast"] });
    Object.values(media).forEach(query => query.addEventListener("change", update));
    update();
    return () => { observer.disconnect(); Object.values(media).forEach(query => query.removeEventListener("change", update)); };
  }, []);
  return appearance;
}

/** An explicit SDR scene texture, deliberately unrelated to the user's desktop. */
function neutralBackground(dark: boolean): BackgroundPainter {
  return (ctx, { width, height }) => {
    const base = ctx.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, dark ? "#24323e" : "#e5edf1");
    base.addColorStop(.52, dark ? "#20272f" : "#f0f2f2");
    base.addColorStop(1, dark ? "#302f33" : "#ece7e1");
    ctx.fillStyle = base; ctx.fillRect(0, 0, width, height);
    const cool = ctx.createRadialGradient(width * .13, height * .12, 0, width * .13, height * .12, Math.max(width, height) * .82);
    cool.addColorStop(0, dark ? "rgba(88,127,147,.24)" : "rgba(191,218,229,.68)");
    cool.addColorStop(1, "rgba(191,218,229,0)");
    ctx.fillStyle = cool; ctx.fillRect(0, 0, width, height);
    const warm = ctx.createRadialGradient(width * .94, height * .82, 0, width * .94, height * .82, Math.max(width, height) * .7);
    warm.addColorStop(0, dark ? "rgba(135,112,101,.18)" : "rgba(236,220,204,.54)");
    warm.addColorStop(1, "rgba(236,220,204,0)");
    ctx.fillStyle = warm; ctx.fillRect(0, 0, width, height);
    // Broad, low contrast curves give the supplied optics something to refract.
    ctx.fillStyle = dark ? "rgba(174,195,204,.055)" : "rgba(255,255,255,.29)";
    ctx.beginPath(); ctx.ellipse(width * .7, height * -.08, width * .82, height * .62, -.32, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = dark ? "rgba(6,13,20,.10)" : "rgba(182,201,209,.13)";
    ctx.beginPath(); ctx.ellipse(width * -.2, height * 1.05, width * .76, height * .88, -.42, 0, Math.PI * 2); ctx.fill();
  };
}

function assignRef<T>(ref: ForwardedRef<T>, value: T | null) {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

export interface GlassSceneProps extends HTMLAttributes<HTMLElement> {}

/** One shared backdrop/coordinate system. Its caller owns sizing and scrolling. */
export const GlassScene = forwardRef<HTMLElement, GlassSceneProps>(function GlassScene({ className = "", children, ...props }, forwardedRef) {
  const appearance = useGlassAppearance();
  // Desktop glass must sample the real backdrop in AppKit. A WebGL canvas
  // (even a transparent-looking painted texture) covers that native material.
  // Use the stable preload bridge, not nativeGlass which toggles during reveal.
  const desktop = typeof window !== "undefined" && Boolean(window.peDesktop);
  const sceneRef = useRef<LiquidGlassSceneElement | null>(null);
  const [ready, setReady] = useState(false);
  const painter = useMemo(() => neutralBackground(appearance.dark), [appearance.dark]);
  const painterRef = useRef(painter); painterRef.current = painter;
  const ref = useCallback((node: HTMLElement | null) => {
    sceneRef.current = node as LiquidGlassSceneElement | null;
    // Set the property before upgrading, so the demo backdrop is never selected.
    if (node && !desktop) (node as LiquidGlassSceneElement).background = painterRef.current;
    assignRef(forwardedRef, node);
  }, [forwardedRef, desktop]);
  const refresh = useCallback(() => sceneRef.current?.refresh?.(), []);
  useEffect(() => {
    if (desktop) { setReady(true); return; }
    let active = true;
    void loadGlass().then(library => {
      library.defineLiquidGlass(window);
      if (!active) return;
      setReady(true);
      refresh();
    }).catch(() => { if (active) setReady(false); });
    // The custom element owns renderer disposal on DOM removal. Do not destroy
    // a connected node during React StrictMode's effect replay.
    return () => { active = false; };
  }, [refresh, desktop]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || desktop) return;
    scene.background = painter;
    scene.refresh?.();
  }, [painter, ready, desktop]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const settle = (event: Event) => {
      // Only a shared window transform can change the background's geometry.
      // Child button feedback needs a geometry refresh, not a texture upload.
      if (event.target === scene) scene.updateBackground?.();
      scene.refresh?.();
    };
    scene.addEventListener("animationend", settle);
    scene.addEventListener("animationcancel", settle);
    scene.addEventListener("transitionend", settle);
    return () => {
      scene.removeEventListener("animationend", settle);
      scene.removeEventListener("animationcancel", settle);
      scene.removeEventListener("transitionend", settle);
    };
  }, []);
  useEffect(() => { refresh(); }, [appearance.opaque, appearance.reduceMotion, refresh, ready]);
  const context = useMemo(() => ({ ...appearance, desktop, ready, refresh }), [appearance, desktop, ready, refresh]);
  return <GlassContext.Provider value={context}>{createElement(desktop ? "div" : "liquid-glass-scene", {
    ...props, ref, className: `pe-kit-scene ${className}`.trim(),
    ...(!desktop ? { material: appearance.dark ? "clearActiveDark" : "clearActive", kernel: "variable13", "render-mode": appearance.opaque ? "css" : undefined } : {}),
    "data-pe-kit-backdrop": desktop ? "native" : "painted",
    "data-pe-kit-theme": appearance.dark ? "dark" : "light",
    "data-pe-kit-opaque": String(appearance.opaque),
    "data-pe-kit-motion": appearance.reduceMotion ? "reduced" : "full",
  }, children)}</GlassContext.Provider>;
});

export interface GlassSurfaceProps extends HTMLAttributes<HTMLDivElement> { radius?: number; material?: MaterialName }

/** A normal div keeps layout, selection, refs and native drag regions.
 * Radius stays numeric: React 19 calls an upgraded custom element's setter. */
export const GlassSurface = forwardRef<HTMLDivElement, GlassSurfaceProps>(function GlassSurface({ radius = 22, material, className = "", children, style, ...props }, ref) {
  const appearance = useContext(GlassContext);
  return <div {...props} ref={ref} className={`pe-kit-surface ${className}`.trim()} style={{ borderRadius: radius, ...style }}>{createElement(appearance.desktop ? "span" : "liquid-glass", {
    className: "pe-kit-lens pe-kit-surface-lens",
    ...(!appearance.desktop ? { radius, material: material || (appearance.dark ? "clearActiveDark" : "clearActive") } : {}),
    "aria-hidden": true,
    // Inline standard CSS survives prefix optimization across Shadow DOM.
    style: appearance.opaque ? { backdropFilter: "none", WebkitBackdropFilter: "none" } : undefined,
  })}{children}</div>;
});

export interface GlassButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> { radius?: number; material?: MaterialName }

/** The real button owns activation, focus and the supplied interaction spring. */
export const GlassButton = forwardRef<HTMLButtonElement, GlassButtonProps>(function GlassButton({ radius = 12, material, className = "", children, style, disabled, ...props }, forwardedRef) {
  const appearance = useContext(GlassContext);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const ref = useCallback((node: HTMLButtonElement | null) => { buttonRef.current = node; assignRef(forwardedRef, node); }, [forwardedRef]);
  useEffect(() => {
    if (appearance.desktop || !appearance.ready || appearance.reduceMotion || disabled || !buttonRef.current) return;
    let active = true;
    let binding: ReturnType<GlassLibrary["attachGlassInteraction"]> | undefined;
    void loadGlass().then(library => {
      if (active && buttonRef.current) binding = library.attachGlassInteraction(buttonRef.current, { onChange: appearance.refresh });
    }).catch(() => {});
    return () => { active = false; binding?.destroy(); };
  }, [appearance.desktop, appearance.ready, appearance.reduceMotion, appearance.refresh, disabled]);
  return <button {...props} ref={ref} disabled={disabled} className={`pe-kit-button ${className}`.trim()} style={{ borderRadius: radius, ...style }}>{children}{createElement(appearance.desktop ? "span" : "liquid-glass", {
    className: "pe-kit-lens pe-kit-button-lens",
    ...(!appearance.desktop ? { radius, material: material || (appearance.dark ? "clearActiveDark" : "clearActive") } : {}),
    "aria-hidden": true,
    // Inline standard CSS survives prefix optimization across Shadow DOM.
    style: appearance.opaque ? { backdropFilter: "none", WebkitBackdropFilter: "none" } : undefined,
  })}</button>;
});
