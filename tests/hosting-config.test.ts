import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sites } from "../build/sites-vite-plugin";
import { readHostingConfig } from "../scripts/hosting-config.mjs";

test("clean clones use empty local bindings without creating hosting metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-hosting-default-"));
  try {
    const file = join(root, ".openai/hosting.json");
    assert.deepEqual(readHostingConfig(file), { d1: null, r2: null });
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("existing hosting configuration is preserved and malformed JSON fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-hosting-existing-"));
  try {
    const file = join(root, "hosting.json");
    const fixture = { d1: "DB", r2: "BUCKET", project_id: "fixture-project" };
    await writeFile(file, JSON.stringify(fixture));
    assert.deepEqual(readHostingConfig(file), fixture);
    await writeFile(file, "{");
    assert.throws(() => readHostingConfig(file), SyntaxError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Sites build copies existing hosting metadata and tolerates its absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pe-hosting-build-"));
  try {
    await mkdir(join(root, "drizzle"));
    await writeFile(join(root, "drizzle/fixture.sql"), "-- test migration\n");
    const plugin = sites();
    const configure = plugin.configResolved as unknown as (config: { root: string; command: "build" }) => void;
    const closeBundle = plugin.closeBundle as unknown as () => Promise<void>;
    configure({ root, command: "build" });
    await closeBundle();
    assert.equal(await readFile(join(root, "dist/.openai/drizzle/fixture.sql"), "utf8"), "-- test migration\n");
    await assert.rejects(readFile(join(root, "dist/.openai/hosting.json")), { code: "ENOENT" });

    await mkdir(join(root, ".openai"));
    const fixture = JSON.stringify({ d1: "DB", r2: null, project_id: "fixture-project" });
    await writeFile(join(root, ".openai/hosting.json"), fixture);
    await closeBundle();
    assert.equal(await readFile(join(root, "dist/.openai/hosting.json"), "utf8"), fixture);

    // Removing local metadata must not leave a stale copy in the next build.
    await rm(join(root, ".openai/hosting.json"));
    await closeBundle();
    await assert.rejects(readFile(join(root, "dist/.openai/hosting.json")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
