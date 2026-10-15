import type { Connection } from "@/lib/types";

/** Only model changes participate in the leave-settings confirmation. */
export function hasModelChanges(saved: readonly Pick<Connection, "id" | "model">[], draft: readonly Pick<Connection, "id" | "model">[]): boolean {
  const savedModels = new Map(saved.map(connection => [connection.id, connection.model.trim()]));
  return saved.length !== draft.length || draft.some(connection => savedModels.get(connection.id) !== connection.model.trim());
}
