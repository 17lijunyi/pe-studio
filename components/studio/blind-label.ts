const slotIndex = (id: string): number | undefined => {
  const writer = /^writer-([123])$/.exec(id);
  if (writer) return Number(writer[1]) - 1;
  const demo = /^demo-([abc])$/i.exec(id);
  return demo ? demo[1].toLowerCase().charCodeAt(0) - 97 : undefined;
};

/** Display ordering only. IDs, scores and request-to-connection bindings never change. */
export function orderedCandidateIds(ids: readonly string[], referenceOrder: readonly string[] = []): string[] {
  const unique = Array.from(new Set(ids));
  const explicit = Array.from(new Set(referenceOrder));
  const fallback = unique.filter(id => !explicit.includes(id)).sort((a, b) => {
    const aSlot = slotIndex(a);
    const bSlot = slotIndex(b);
    if (aSlot !== undefined && bSlot !== undefined) return aSlot - bSlot || a.localeCompare(b);
    if (aSlot !== undefined) return -1;
    if (bSlot !== undefined) return 1;
    return a.localeCompare(b);
  });
  const rank = (id: string) => explicit.includes(id) ? explicit.indexOf(id) : explicit.length + fallback.indexOf(id);
  return unique.sort((a, b) => rank(a) - rank(b));
}

export function blindLabel(id: string, order: readonly string[] = []): string {
  const index = order.length ? Array.from(new Set(order)).indexOf(id) : slotIndex(id) ?? -1;
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : "结果";
}

/** A useful failure status without provider URLs, model IDs or upstream prose. */
export function blindFailure(error?: string): string {
  const status = error?.match(/\bHTTP\s*[:：]?\s*([45]\d{2})\b/i)?.[1];
  return status ? `请求未完成（HTTP ${status}）。显示模型后可查看连接详情。` : "请求未完成。显示模型后可查看连接详情。";
}
