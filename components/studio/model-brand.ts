export interface ModelBrand {
  name: string;
  tone: "gpt" | "claude" | "gemini" | "custom";
}

/** Display identity only: never normalize the model ID sent to a provider. */
export function brandForConnection(value: { model?: string; provider?: string; label?: string }): ModelBrand {
  const model = value.model || "";
  if (/(?:^|[\s/_.-])(?:gpt|chatgpt)(?:$|[\d\s/_.-])/i.test(model) || /(?:^|\/)o[134](?:$|[-.])/i.test(model)) return { name: "GPT", tone: "gpt" };
  if (/(?:^|[\s/_.-])claude(?:$|[\d\s/_.-])/i.test(model)) return { name: "Claude", tone: "claude" };
  if (/(?:^|[\s/_.-])gemini(?:$|[\d\s/_.-])/i.test(model)) return { name: "Gemini", tone: "gemini" };
  const label = (value.provider || value.label || "").trim();
  // A gateway identifies the connection, not the underlying model family.
  const usableLabel = label && !/aihubmix|inferera/i.test(label) && !/^(?:模型|writer|model)\s*[-#]?\s*\d*$/i.test(label);
  if (!model) {
    if (/^(?:openai|chatgpt|gpt)$/i.test(label)) return { name: "GPT", tone: "gpt" };
    if (/^(?:anthropic|claude)$/i.test(label)) return { name: "Claude", tone: "claude" };
    if (/^(?:google|gemini)$/i.test(label)) return { name: "Gemini", tone: "gemini" };
  }
  return { name: usableLabel ? label : model || "自定义模型", tone: "custom" };
}
