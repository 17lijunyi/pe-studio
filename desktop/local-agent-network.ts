import { execFile } from "node:child_process";
import { isIP } from "node:net";

const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"] as const;
const ROUTING_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"] as const;
const MAX_SYSTEM_PROXY_BYTES = 16_384;

/** Proxy-only values; deliberately not the app's complete ProcessEnv. */
export type LocalAgentProxyEnvironment = Record<string, string | undefined>;

function hasVariable(source: LocalAgentProxyEnvironment, name: string): boolean {
  return Object.hasOwn(source, name) && typeof source[name] === "string";
}

function proxyUrl(host: string | undefined, port: string | undefined): string | undefined {
  if (!host || !port || !/^\d{1,5}$/.test(port) || +port < 1 || +port > 65_535) return undefined;
  const unwrapped = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const addressType = isIP(unwrapped);
  // scutil stores a host, not a URL. Never interpret credentials, paths,
  // startup arguments or other untrusted punctuation as part of an endpoint.
  if (!addressType && !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)) return undefined;
  if (!addressType && host.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return undefined;
  return `http://${addressType === 6 ? `[${unwrapped}]` : host}:${+port}`;
}

function exceptionForNoProxy(value: string): string | undefined {
  if (isIP(value)) return value;
  // *.local can safely become .local. More complex wildcards and CIDRs vary
  // between CLI runtimes, so do not widen or guess their bypass semantics.
  const domain = value.startsWith("*.") ? value.slice(2) : value.startsWith(".") ? value.slice(1) : value;
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)) return undefined;
  if (domain.split(".").some(label => !label || label.length > 63 || label.startsWith("-") || label.endsWith("-"))) return undefined;
  return value.startsWith("*.") || value.startsWith(".") ? `.${domain}` : domain;
}

/** Main-process-only: parse scutil's top-level static proxies, without PAC or SOCKS. */
export function parseMacSystemProxy(output: string): LocalAgentProxyEnvironment {
  if (Buffer.byteLength(output) > MAX_SYSTEM_PROXY_BYTES) return {};
  const values = new Map<string, string>();
  const exceptions: string[] = [];
  let depth = 0, exceptionDepth = -1, malformed = false;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const topField = depth === 1 ? line.match(/^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/) : undefined;
    if (topField) {
      const [, key, value] = topField;
      if (values.has(key)) malformed = true;
      values.set(key, value);
      if (key === "ExceptionsList" && value === "<array> {") exceptionDepth = depth + 1;
    } else if (depth === exceptionDepth) {
      const entry = line.match(/^\d+\s*:\s*(.*?)\s*$/);
      if (entry) {
        // Some proxy clients store all bypass entries as a single comma list.
        // Validate each item independently so unsupported wildcards cannot
        // discard valid localhost/domain entries alongside them.
        for (const value of entry[1].split(",")) {
          const exception = exceptionForNoProxy(value.trim());
          if (exception) exceptions.push(exception);
        }
      }
    }
    // Only scutil container lines affect nesting; braces inside values do not.
    if (/^(?:(?:[A-Za-z0-9_]+)\s*:\s*)?<(?:dictionary|array)>\s*\{$/.test(line)) depth++;
    else if (line === "}") {
      if (depth === exceptionDepth) exceptionDepth = -1;
      depth--;
      if (depth < 0) malformed = true;
    }
  }
  if (malformed || depth !== 0 || values.get("ProxyAutoConfigEnable") === "1" || values.get("ProxyAutoDiscoveryEnable") === "1") return {};
  const result: LocalAgentProxyEnvironment = {};
  for (const [prefix, upper, lower] of [["HTTP", "HTTP_PROXY", "http_proxy"], ["HTTPS", "HTTPS_PROXY", "https_proxy"]] as const) {
    if (values.get(`${prefix}Enable`) !== "1") continue;
    const url = proxyUrl(values.get(`${prefix}Proxy`), values.get(`${prefix}Port`));
    if (url) { result[upper] = url; result[lower] = url; }
  }
  if (Object.keys(result).length && exceptions.length) {
    const noProxy = [...new Set(exceptions)].join(",");
    result.NO_PROXY = noProxy; result.no_proxy = noProxy;
  }
  return result;
}

/** Preserve explicit proxy choices exactly; never merge unrelated environment values. */
export function localAgentProxyEnvironment(source: LocalAgentProxyEnvironment, systemProxy: LocalAgentProxyEnvironment = {}): LocalAgentProxyEnvironment {
  const result: LocalAgentProxyEnvironment = {};
  const explicitRouting = ROUTING_VARIABLES.some(name => hasVariable(source, name));
  const explicitBypass = hasVariable(source, "NO_PROXY") || hasVariable(source, "no_proxy");
  for (const name of PROXY_VARIABLES) {
    if (!explicitRouting && (!explicitBypass || !["NO_PROXY", "no_proxy"].includes(name)) && hasVariable(systemProxy, name)) result[name] = systemProxy[name];
    if (hasVariable(source, name)) result[name] = source[name];
  }
  return result;
}

export interface LocalAgentProxyDependencies {
  platform?: NodeJS.Platform;
  /** Test seam only. The production reader is fixed to scutil --proxy. */
  readSystemProxy?: () => Promise<string>;
}

function readMacSystemProxy(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("/usr/sbin/scutil", ["--proxy"], {
      encoding: "utf8", timeout: 750, maxBuffer: MAX_SYSTEM_PROXY_BYTES,
      env: { NODE_ENV: "production", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" }, windowsHide: true,
    }, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
  });
}

/** Main process only: no proxy addresses, credentials or system output go to IPC/logs. */
export async function readLocalAgentProxyEnvironment(source: LocalAgentProxyEnvironment = process.env, dependencies: LocalAgentProxyDependencies = {}): Promise<LocalAgentProxyEnvironment> {
  if ((dependencies.platform ?? process.platform) !== "darwin" || ROUTING_VARIABLES.some(name => hasVariable(source, name))) return localAgentProxyEnvironment(source);
  try {
    const output = await (dependencies.readSystemProxy || readMacSystemProxy)();
    return localAgentProxyEnvironment(source, parseMacSystemProxy(output));
  } catch {
    // Unavailable/unsupported system proxy settings must not block detection.
    return localAgentProxyEnvironment(source);
  }
}
