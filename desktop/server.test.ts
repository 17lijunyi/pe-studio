import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APP_ORIGIN, createDesktopHandler, DESKTOP_TOKEN_HEADER, isAppUrl, isAuthorizedApiRequest } from "./server";

const token = "a".repeat(64);
const headers = { [DESKTOP_TOKEN_HEADER]: token };

test("desktop origin and token checks reject cross-origin and forged hosts", () => {
  assert.equal(isAppUrl(`${APP_ORIGIN}/`), true);
  for (const url of ["https://pe-studio/", "app://pe-studio.evil.test/", "app://user@pe-studio/", "app://pe-studio:1234/"]) assert.equal(isAppUrl(url), false);
  assert.equal(isAuthorizedApiRequest(new Request(`${APP_ORIGIN}/api/config`, { headers }), token), true);
  assert.equal(isAuthorizedApiRequest(new Request(`${APP_ORIGIN}/api/config`), token), false);
  assert.equal(isAuthorizedApiRequest(new Request(`${APP_ORIGIN}/api/config`, { headers: { ...headers, Origin: "https://evil.test" } }), token), false);
  assert.equal(isAuthorizedApiRequest(new Request(`${APP_ORIGIN}/api/config`, { headers: { ...headers, Host: "evil.test" } }), token), false);
  assert.equal(isAuthorizedApiRequest(new Request(`${APP_ORIGIN}/api/config`, { headers: { ...headers, "Sec-Fetch-Site": "cross-site" } }), token), false);
});

test("desktop handler serves protected local APIs without granting CORS", async () => {
  const handler = createDesktopHandler("/not-used-for-api", token);
  const missing = await handler(new Request(`${APP_ORIGIN}/api/config`));
  assert.equal(missing.status, 403);
  const response = await handler(new Request(`${APP_ORIGIN}/api/config`, { headers }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  const config = await response.json() as { configured: Record<string, boolean> };
  assert.deepEqual(Object.keys(config), ["configured"]);
  assert.ok(Object.values(config.configured).every(value => typeof value === "boolean"));
  assert.equal((await handler(new Request(`${APP_ORIGIN}/api/config`, { method: "OPTIONS", headers }))).status, 405);
});

test("model directory stays behind desktop authentication and cannot dispatch a local agent", async () => {
  const handler = createDesktopHandler("/not-used-for-api", token);
  const request = (body: unknown, authorized = true) => new Request(`${APP_ORIGIN}/api/models`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(authorized ? headers : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await handler(request({}, false))).status, 403);
  assert.equal((await handler(request({}))).status, 400);
  assert.equal((await handler(request({ connection: { protocol: "local-agent", baseUrl: "local://codex", apiKey: "" } }))).status, 400);
  assert.equal((await handler(new Request(`${APP_ORIGIN}/api/models`, { headers }))).status, 405);
});

test("desktop static routing confines files and symlinks to the renderer directory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pe-desktop-test-"));
  try {
    const renderer = join(temporary, "renderer");
    await mkdir(renderer);
    await writeFile(join(renderer, "index.html"), "<html>PE Studio</html>");
    await writeFile(join(temporary, "outside.txt"), "outside-secret");
    await symlink(join(temporary, "outside.txt"), join(renderer, "link.txt"));
    const handler = createDesktopHandler(renderer, token);
    const page = await handler(new Request(`${APP_ORIGIN}/`));
    assert.equal(page.status, 200);
    assert.match(page.headers.get("Content-Security-Policy") ?? "", /connect-src 'self'/);
    assert.equal(await page.text(), "<html>PE Studio</html>");
    const escaped = await handler(new Request(`${APP_ORIGIN}/%2e%2e%2foutside.txt`));
    assert.equal(escaped.status, 403);
    assert.ok(!(await escaped.text()).includes("outside-secret"));
    assert.equal((await handler(new Request(`${APP_ORIGIN}/link.txt`))).status, 403);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
