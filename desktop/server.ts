import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { POST as generate } from "../app/api/generate/route";
import { POST as models } from "../app/api/models/route";
import { POST as judge } from "../app/api/judge/route";
import { GET as config } from "../app/api/config/route";

export const APP_ORIGIN = "app://pe-studio";
export const DESKTOP_TOKEN_HEADER = "x-pe-desktop-token";

export function isAppUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "app:" && url.hostname === "pe-studio" && !url.port && !url.username && !url.password;
  } catch { return false; }
}

function secretMatches(value: string | null, expected: string): boolean {
  if (!value || value.length !== expected.length) return false;
  const received = Buffer.from(value);
  const target = Buffer.from(expected);
  return received.length === target.length && timingSafeEqual(received, target);
}

export function isAuthorizedApiRequest(request: Request, token: string): boolean {
  if (!isAppUrl(request.url) || !secretMatches(request.headers.get(DESKTOP_TOKEN_HEADER), token)) return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const site = request.headers.get("sec-fetch-site");
  return (!origin || origin === APP_ORIGIN) && (!host || host === "pe-studio") && (!site || site === "same-origin" || site === "none");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
};

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
};

function failure(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: SECURITY_HEADERS });
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Runs inside Electron's protocol handler. No TCP server or public port exists. */
export function createDesktopHandler(rendererRoot: string, token: string): (request: Request) => Promise<Response> {
  const root = resolve(rendererRoot);
  return async request => {
    if (!isAppUrl(request.url)) return failure(403, "不允许访问此应用地址。");
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      if (!isAuthorizedApiRequest(request, token)) return failure(403, "仅允许应用窗口发起请求。");
      // No CORS allowance, OPTIONS handling, proxy destination or arbitrary route dispatch.
      try {
        let response: Response;
        if (url.pathname === "/api/config" && request.method === "GET") response = config();
        else if (url.pathname === "/api/generate" && request.method === "POST") response = await generate(request);
        else if (url.pathname === "/api/models" && request.method === "POST") response = await models(request);
        else if (url.pathname === "/api/judge" && request.method === "POST") response = await judge(request);
        else return failure(405, "该接口或请求方法不可用。");
        for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(key, value);
        return response;
      } catch { return failure(500, "本地模型服务处理失败，请稍后重试。"); }
    }
    if (request.method !== "GET" && request.method !== "HEAD") return failure(405, "不支持此请求方法。");
    try {
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.includes("\0") || pathname.includes("\\")) return failure(400, "资源路径无效。");
      const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!within(root, file)) return failure(403, "资源路径无效。");
      const canonicalRoot = await realpath(root);
      const canonicalFile = await realpath(file);
      if (!within(canonicalRoot, canonicalFile)) return failure(403, "资源路径无效。");
      const info = await stat(canonicalFile);
      if (!info.isFile() || info.size > 20 * 1024 * 1024) return failure(404, "未找到应用资源。");
      const body = request.method === "HEAD" ? null : new Uint8Array(await readFile(canonicalFile));
      return new Response(body, { headers: { ...SECURITY_HEADERS, "Content-Type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" } });
    } catch { return failure(404, "未找到应用资源。"); }
  };
}
