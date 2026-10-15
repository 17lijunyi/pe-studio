import test from "node:test";
import assert from "node:assert/strict";
import { createSettingsLeaveGuard, type SettingsDraftAction, type SettingsLeaveChoice } from "../desktop/settings-leave";

function fixture(choice: SettingsLeaveChoice, success = true) {
  let prompts = 0;
  const actions: SettingsDraftAction[] = [];
  const guard = createSettingsLeaveGuard({
    choose: async () => { prompts++; return choice; },
    apply: async action => { actions.push(action); return success; },
  });
  return { guard, actions, get prompts() { return prompts; } };
}
test("clean settings leave without asking or attempting a save", async () => {
  const mock = fixture("continue");
  assert.equal(await mock.guard.confirm(), true);
  assert.equal(mock.prompts, 0);
  assert.deepEqual(mock.actions, []);
});
test("continue editing preserves dirty changes and cancels the leave", async () => {
  const mock = fixture("continue"); mock.guard.setDirty(true);
  assert.equal(await mock.guard.confirm(), false);
  assert.equal(mock.guard.isDirty(), true);
  assert.deepEqual(mock.actions, []);
});
for (const choice of ["save", "discard"] as const) {
  test(`${choice} must finish successfully before allowing the leave`, async () => {
    const mock = fixture(choice); mock.guard.setDirty(true);
    assert.equal(await mock.guard.confirm(), true);
    assert.equal(mock.guard.isDirty(), false);
    assert.deepEqual(mock.actions, [choice]);
    const failed = fixture(choice, false); failed.guard.setDirty(true);
    assert.equal(await failed.guard.confirm(), false);
    assert.equal(failed.guard.isDirty(), true);
  });
}
test("repeated requests share one decision and one save while pending", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let prompts = 0, saves = 0;
  const guard = createSettingsLeaveGuard({ choose: async () => { prompts++; await wait; return "save"; }, apply: async () => { saves++; return true; } });
  guard.setDirty(true);
  const a = guard.confirm(), b = guard.confirm();
  assert.equal(a, b); release();
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  assert.equal(prompts, 1); assert.equal(saves, 1);
});
test("a failed bridge or new edit cannot be silently treated as saved", async () => {
  const failed = createSettingsLeaveGuard({ choose: async () => "save", apply: async () => { throw new Error("test bridge unavailable"); } });
  failed.setDirty(true); assert.equal(await failed.confirm(), false); assert.equal(failed.isDirty(), true);
  const guard = createSettingsLeaveGuard({ choose: async () => "save", apply: async () => { guard.setDirty(false); guard.setDirty(true); return true; } });
  guard.setDirty(true); assert.equal(await guard.confirm(), false); assert.equal(guard.isDirty(), true);
});
