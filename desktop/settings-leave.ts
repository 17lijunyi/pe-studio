export type SettingsLeaveChoice = "save" | "discard" | "continue";
export type SettingsDraftAction = "save" | "discard";

/** Coalesces repeated leave requests while a native decision or save is pending. */
export function createSettingsLeaveGuard(dependencies: {
  choose: () => Promise<SettingsLeaveChoice>;
  apply: (action: SettingsDraftAction) => Promise<boolean>;
}) {
  let dirty = false;
  let revision = 0;
  let pending: Promise<boolean> | undefined;
  return {
    isDirty: () => dirty,
    setDirty(value: boolean) { if (dirty !== value) { dirty = value; revision++; } },
    confirm(): Promise<boolean> {
      if (pending) return pending;
      if (!dirty) return Promise.resolve(true);
      const started = revision;
      pending = (async () => {
        const choice = await dependencies.choose();
        if (choice === "continue") return false;
        const applied = await dependencies.apply(choice);
        if (!applied) return false;
        // The editor reports clean after applying. A newer dirty edit must not
        // be erased by a delayed completion for an earlier save.
        if (revision !== started && dirty) return false;
        dirty = false;
        return true;
      })().catch(() => false).finally(() => { pending = undefined; });
      return pending;
    },
  };
}
