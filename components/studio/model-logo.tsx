import type { ModelBrand } from "./model-brand";

/** Local, transparent brand artwork; custom connections keep their own name.
 * OpenAI: https://openai.github.io/openai-agents-python/assets/logo.svg
 * Claude: the unchanged starburst path in https://claude.com/ (125 × 125).
 * Gemini: https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg
 * The marks identify model families, not the PE Studio app itself.
 */
export function ModelLogo({ brand, className = "" }: { brand: ModelBrand; className?: string }) {
  if (brand.tone === "custom") return null;
  return <span className={`model-logo model-logo-${brand.tone} ${className}`} aria-hidden="true" />;
}
