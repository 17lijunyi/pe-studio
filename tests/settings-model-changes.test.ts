import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import React, { type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hasModelChanges } from "../components/studio/settings-model-changes";
import { DEFAULT_CONNECTIONS, DEFAULT_JUDGE, type Connection } from "../lib/types";
import type { SettingsDialog } from "../components/studio/settings-dialog";

test("model leave confirmation follows stable slot identity, not tab order", () => {
  const saved = DEFAULT_CONNECTIONS.map(connection => ({ ...connection }));
  assert.equal(hasModelChanges(saved, [...saved].reverse()), false);
  const changed = saved.map(connection => connection.id === "writer-2" ? { ...connection, model: "different-model" } : connection);
  assert.equal(hasModelChanges(saved, changed), true);
  assert.equal(hasModelChanges(saved, changed.map(connection => connection.id === "writer-2" ? saved[1] : connection)), false);
});

test("key, endpoint, provider, label and whitespace-only edits do not trigger a model reminder", () => {
  const draft: Connection[] = DEFAULT_CONNECTIONS.map(connection => ({
    ...connection, label: "another label", protocol: "deepseek", baseUrl: "https://example.com/v1",
    apiKey: "fixture-only-another-key", model: ` ${connection.model} `,
  }));
  assert.equal(hasModelChanges(DEFAULT_CONNECTIONS, draft), false);
  assert.equal(hasModelChanges(DEFAULT_CONNECTIONS, draft.map((connection, i) => i === 2 ? { ...connection, model: "" } : connection)), true);
});

const compiled = buildSync({
  stdin: { contents: 'export { SettingsDialog } from "./components/studio/settings-dialog";', resolveDir: fileURLToPath(new URL("../", import.meta.url)), sourcefile: "settings-save-entry.ts" },
  bundle: true, platform: "node", format: "cjs", jsx: "automatic",
  external: ["react", "react-dom/server"], loader: { ".css": "empty" }, write: false,
});
const moduleOutput = { exports: {} };
runInNewContext(compiled.outputFiles[0].text, { module: moduleOutput, exports: moduleOutput.exports, require: createRequire(import.meta.url) });
const Dialog = (moduleOutput.exports as { SettingsDialog: ComponentType<React.ComponentProps<typeof SettingsDialog>> }).SettingsDialog;
function renderSettings(connections: Connection[]) {
  return renderToStaticMarkup(React.createElement(Dialog, {
    embedded: true, connections, judge: DEFAULT_JUDGE, serverConfig: {}, isDesktop: true,
    credentialsAvailable: true, shortcut: "Control+Q", onShortcutChange: () => {}, onSave: () => true, onClose: () => {},
  }));
}

test("cloud model confirmation is beside the model field and before the expandable catalog", () => {
  const html = renderSettings(DEFAULT_CONNECTIONS);
  assert.ok(html.indexOf('id="writer-model"') < html.indexOf('class="provider-model-save"'));
  assert.ok(html.indexOf('class="provider-model-save"') < html.indexOf('class="provider-model-heading"'));
  assert.equal((html.match(/>保存设置</g) || []).length, 1);
  assert.doesNotMatch(html.slice(html.indexOf('<footer class="dialog-footer"')), /<button/);
});

test("local Agent model selection has the same nearby confirmation", () => {
  const local: Connection[] = DEFAULT_CONNECTIONS.map((connection, i) => i === 0 ? { ...connection, protocol: "local-agent", baseUrl: "local://codex", model: "default", apiKey: "" } : connection);
  const html = renderSettings(local);
  const modelField = html.indexOf('<select id="writer-model"');
  const saveActions = html.indexOf('class="provider-model-save"');
  assert.ok(modelField > -1 && modelField < saveActions);
  assert.equal((html.match(/>保存设置</g) || []).length, 1);
});
