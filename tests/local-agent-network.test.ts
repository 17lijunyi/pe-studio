import test from "node:test";
import assert from "node:assert/strict";
import { localAgentProxyEnvironment, parseMacSystemProxy, readLocalAgentProxyEnvironment } from "../desktop/local-agent-network";

const staticProxy = `<dictionary> {
  ExceptionsList : <array> {
    0 : *.local
    1 : localhost
    2 : 169.254/16
    3 : *.local
    4 : 127.0.0.1
    5 : service.*.test
  }
  HTTPEnable : 1
  HTTPPort : 8200
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 8201
  HTTPSProxy : proxy.example.test
  SOCKSEnable : 1
  SOCKSPort : 8202
  SOCKSProxy : 127.0.0.1
}`;

test("system static HTTP/HTTPS proxies preserve their distinct ports and conservative bypass entries", () => {
  assert.deepEqual(parseMacSystemProxy(staticProxy), {
    HTTP_PROXY: "http://127.0.0.1:8200", http_proxy: "http://127.0.0.1:8200",
    HTTPS_PROXY: "http://proxy.example.test:8201", https_proxy: "http://proxy.example.test:8201",
    NO_PROXY: ".local,localhost,127.0.0.1", no_proxy: ".local,localhost,127.0.0.1",
  });
});

test("single comma-separated ExceptionsList retains simple entries without widening complex wildcards", () => {
  const output = staticProxy.replace(/ExceptionsList : <array> \{[\s\S]*?\n  \}/, `ExceptionsList : <array> {
    0 : *example.test, service.*.test, localhost, *.local,127.*,127.0.0.1,internal.example.test, 169.254/16
  }`);
  const parsed = parseMacSystemProxy(output);
  assert.equal(parsed.NO_PROXY, "localhost,.local,127.0.0.1,internal.example.test");
  assert.equal(parsed.no_proxy, parsed.NO_PROXY);
  assert.equal(parsed.HTTP_PROXY, "http://127.0.0.1:8200");
});

test("parsing ignores scoped dictionaries and does not invent HTTP from SOCKS or PAC", () => {
  assert.deepEqual(parseMacSystemProxy(`<dictionary> {
    __SCOPED__ : <dictionary> {
      en0 : <dictionary> {
        HTTPEnable : 1
        HTTPPort : 9999
        HTTPProxy : scoped-only.test
      }
    }
    SOCKSEnable : 1
    SOCKSPort : 9000
    SOCKSProxy : 127.0.0.1
    ProxyAutoConfigURLString : https://example.test/proxy.pac
  }`), {});
  for (const field of ["ProxyAutoConfigEnable", "ProxyAutoDiscoveryEnable"]) assert.deepEqual(parseMacSystemProxy(staticProxy.replace("HTTPEnable : 1", `${field} : 1\n  HTTPEnable : 1`)), {});
});

test("invalid endpoints, disabled settings, duplicates and oversized/malformed dictionaries are not adopted", () => {
  const invalid = ["http://127.0.0.1", "user:secret@localhost", "localhost/path", "host;command", "-invalid.test", "a..b"];
  for (const host of invalid) assert.equal(parseMacSystemProxy(staticProxy.replace("HTTPProxy : 127.0.0.1", `HTTPProxy : ${host}`)).HTTP_PROXY, undefined);
  for (const port of ["0", "65536", "80/path", "-1", "abc"]) assert.equal(parseMacSystemProxy(staticProxy.replace("HTTPPort : 8200", `HTTPPort : ${port}`)).HTTP_PROXY, undefined);
  assert.equal(parseMacSystemProxy(staticProxy.replace("HTTPEnable : 1", "HTTPEnable : 0")).HTTP_PROXY, undefined);
  assert.deepEqual(parseMacSystemProxy(staticProxy.replace("HTTPEnable : 1", "HTTPEnable : 1\n  HTTPEnable : 1")), {});
  assert.deepEqual(parseMacSystemProxy(staticProxy.slice(0, -1)), {});
  assert.deepEqual(parseMacSystemProxy("x".repeat(16_385)), {});
  assert.equal(parseMacSystemProxy(staticProxy.replace("HTTPProxy : 127.0.0.1", "HTTPProxy : ::1")).HTTP_PROXY, "http://[::1]:8200");
});

test("explicit uppercase/lowercase choices and empty opt-out are retained without adding system routes", () => {
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    for (const value of ["http://custom.test:7080", ""]) assert.deepEqual(localAgentProxyEnvironment({ [name]: value, NO_PROXY: "internal.test", OPENAI_API_KEY: "not-copied", NODE_OPTIONS: "not-copied" }, parseMacSystemProxy(staticProxy)), { [name]: value, NO_PROXY: "internal.test" });
  }
  assert.deepEqual(localAgentProxyEnvironment({ HTTP_PROXY: "http://upper.test:81", http_proxy: "http://lower.test:82", NO_PROXY: "one.test", no_proxy: "two.test" }), {
    HTTP_PROXY: "http://upper.test:81", http_proxy: "http://lower.test:82", NO_PROXY: "one.test", no_proxy: "two.test",
  });
});

test("explicit bypass replaces both system aliases while no unrelated keys enter the child environment", () => {
  const result = localAgentProxyEnvironment({ NO_PROXY: "", API_KEY: "secret", NODE_OPTIONS: "hook" }, { ...parseMacSystemProxy(staticProxy), API_KEY: "another-secret" });
  assert.equal(result.NO_PROXY, ""); assert.equal(result.no_proxy, undefined);
  assert.equal(result.HTTP_PROXY, "http://127.0.0.1:8200");
  assert.equal(result.API_KEY, undefined); assert.equal(result.NODE_OPTIONS, undefined);
  assert.deepEqual(localAgentProxyEnvironment({ no_proxy: "local.test" }), { no_proxy: "local.test" });
});

test("Finder-like macOS environment reads only system proxies; existing routes/non-macOS skip the read", async () => {
  let reads = 0;
  const readSystemProxy = async () => { reads++; return staticProxy; };
  const detected = await readLocalAgentProxyEnvironment({ HOME: "/mock/home" }, { platform: "darwin", readSystemProxy });
  assert.equal(reads, 1); assert.equal(detected.HTTPS_PROXY, "http://proxy.example.test:8201"); assert.equal(detected.HOME, undefined);
  assert.deepEqual(await readLocalAgentProxyEnvironment({ ALL_PROXY: "socks5://custom.test:1080" }, { platform: "darwin", readSystemProxy }), { ALL_PROXY: "socks5://custom.test:1080" });
  assert.deepEqual(await readLocalAgentProxyEnvironment({}, { platform: "linux", readSystemProxy }), {});
  assert.equal(reads, 1);
  assert.deepEqual(await readLocalAgentProxyEnvironment({ NO_PROXY: "internal.test" }, { platform: "darwin", readSystemProxy: async () => { throw new Error("unavailable"); } }), { NO_PROXY: "internal.test" });
});
