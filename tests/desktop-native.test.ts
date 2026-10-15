import assert from "node:assert/strict";
import test from "node:test";
import { constants } from "node:fs";
import { resolveNodeHeaders } from "../scripts/desktop-native.mjs";

test("native headers honor an explicit local directory without probing other installations", async () => {
  const checked: unknown[] = [];
  const result = await resolveNodeHeaders({
    environment: { NODE_INCLUDE_DIR: "/mock/node-headers" },
    executablePath: "/mock/bin/node",
    accessImpl: async (path: unknown, mode?: number) => { checked.push(path); assert.equal(mode, constants.R_OK); },
    realpathImpl: async () => { throw new Error("must not inspect executable for an override"); },
  });
  assert.equal(result, "/mock/node-headers");
  assert.deepEqual(checked, ["/mock/node-headers/node_api.h"]);
});

test("invalid or empty NODE_INCLUDE_DIR fails instead of silently using available system headers", async () => {
  for (const override of ["/missing/headers", "", "   "]) {
    const checked: unknown[] = [];
    await assert.rejects(resolveNodeHeaders({
      environment: { NODE_INCLUDE_DIR: override },
      accessImpl: async path => { checked.push(path); if (path !== "/usr/local/include/node/node_api.h") throw new Error("missing"); },
    }), /NODE_INCLUDE_DIR.*automatic fallback is disabled/);
    assert.ok(checked.every(path => path === "/missing/headers/node_api.h"));
  }
});

test("native header discovery checks the executable prefix before its resolved symlink prefix", async () => {
  const checked: unknown[] = [];
  const result = await resolveNodeHeaders({
    environment: {}, executablePath: "/mock/current/bin/node",
    realpathImpl: async () => "/mock/versions/node-24/bin/node",
    accessImpl: async path => { checked.push(path); if (path !== "/mock/versions/node-24/include/node/node_api.h") throw new Error("missing"); },
  });
  assert.equal(result, "/mock/versions/node-24/include/node");
  assert.deepEqual(checked, ["/mock/current/include/node/node_api.h", "/mock/versions/node-24/include/node/node_api.h"]);
});

test("native header discovery includes both Homebrew installation prefixes", async () => {
  for (const expected of ["/opt/homebrew/include/node", "/usr/local/include/node"]) {
    const result = await resolveNodeHeaders({
      environment: {}, executablePath: "/mock/bin/node",
      realpathImpl: async () => "/mock/bin/node",
      accessImpl: async path => { if (path !== `${expected}/node_api.h`) throw new Error("missing"); },
    });
    assert.equal(result, expected);
  }
});

test("native header discovery can use an executable prefix even if realpath lookup fails", async () => {
  const result = await resolveNodeHeaders({
    environment: {}, executablePath: "/mock/node/bin/node",
    realpathImpl: async () => { throw new Error("unavailable"); },
    accessImpl: async path => { assert.equal(path, "/mock/node/include/node/node_api.h"); },
  });
  assert.equal(result, "/mock/node/include/node");
});

test("missing local native headers report the required override without downloading or scanning user directories", async () => {
  const checked: unknown[] = [];
  await assert.rejects(resolveNodeHeaders({
    environment: {}, executablePath: "/mock/bin/node",
    realpathImpl: async () => "/mock/bin/node",
    accessImpl: async path => { checked.push(path); throw new Error("missing"); },
  }), /NODE_INCLUDE_DIR.*No headers are downloaded automatically/);
  assert.deepEqual(checked, ["/mock/include/node/node_api.h", "/opt/homebrew/include/node/node_api.h", "/usr/local/include/node/node_api.h"]);
});
