/** Assign display positions once per round; request IDs and scores stay unchanged. */
export function createCandidateOrder(ids: readonly string[], random: () => number = Math.random): string[] {
  const order = Array.from(new Set(ids));
  for (let index = order.length - 1; index > 0; index -= 1) {
    const value = random();
    if (!Number.isFinite(value) || value < 0 || value >= 1) {
      throw new RangeError("The random source must return a number in [0, 1).");
    }
    const next = Math.floor(value * (index + 1));
    [order[index], order[next]] = [order[next], order[index]];
  }
  return order;
}
