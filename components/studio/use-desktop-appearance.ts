"use client";

import { useEffect, useState } from "react";

export function useDesktopAppearance() {
  const [appearance, setAppearance] = useState<{ dark: boolean; reduceTransparency: boolean; reduceMotion: boolean; increaseContrast: boolean; nativeGlass?: boolean }>({ dark: false, reduceTransparency: false, reduceMotion: false, increaseContrast: false, nativeGlass: false });
  useEffect(() => {
    const desktop = window.peDesktop;
    let active = true;
    if (!desktop) return;
    void desktop.getAppearance().then(value => { if (active) setAppearance(value); }).catch(() => {});
    const unsubscribe = desktop.onAppearanceChanged(setAppearance);
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!window.peDesktop) return;
    document.documentElement.dataset.desktop = "true";
    document.documentElement.dataset.theme = appearance.dark ? "dark" : "light";
    document.documentElement.dataset.reduceTransparency = String(appearance.reduceTransparency);
    document.documentElement.dataset.reduceMotion = String(appearance.reduceMotion);
    document.documentElement.dataset.increaseContrast = String(appearance.increaseContrast);
    document.documentElement.dataset.nativeGlass = String(Boolean(appearance.nativeGlass));
  }, [appearance]);
  return appearance;
}
