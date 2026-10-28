// SvelteKit 把启动代码写成页面里的内联 <script>，而 Tauri 的 CSP 是 `script-src 'self'`。
// 这里把内联脚本改写成同源的外部经典脚本：
// - 构建：externalize-boot.mjs 在 adapter 写完 dist 后，把脚本落成 dist 里和 HTML 同目录的文件；
// - 开发：Vite 中间件改写 HTML 响应（同时补上 devCsp 头），脚本从内存里按哈希提供。
// 外部经典脚本同步执行，document.currentScript 仍然指向它，启动代码里的
// `currentScript.parentElement` 和相对 import() 都保持原义（文件和 HTML 在同一目录）。
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

export interface ExtractedScript {
  readonly name: string;
  readonly code: string;
}

const INLINE_SCRIPT = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
const EXECUTABLE_TYPES = new Set(["", "text/javascript", "module", "application/javascript"]);

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\s${name}(?:\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+)))?`, "i").exec(attributes);
  if (!match) return null;
  return match[2] ?? match[3] ?? match[4] ?? "";
}

/** 把可执行的内联脚本替换成 `<script src>`；数据块（JSON 等）和已有 src 的脚本不动。 */
export function extractInlineScripts(
  html: string,
  srcFor: (name: string) => string,
): { html: string; scripts: ExtractedScript[] } {
  const scripts: ExtractedScript[] = [];
  const rewritten = html.replace(INLINE_SCRIPT, (whole, rawAttributes: string | undefined, code: string) => {
    const attributes = rawAttributes ?? "";
    if (attribute(attributes, "src") !== null || code.trim() === "") return whole;
    const type = (attribute(attributes, "type") ?? "").trim().toLowerCase();
    if (!EXECUTABLE_TYPES.has(type)) return whole;
    const digest = createHash("sha256").update(code).digest("hex").slice(0, 12);
    const name = `boot.${digest}.js`;
    scripts.push({ name, code });
    const moduleType = type === "module" ? ' type="module"' : "";
    return `<script${moduleType} src="${srcFor(name)}"></script>`;
  });
  return { html: rewritten, scripts };
}

// 脚本和页面放在同一目录：开发模式的启动代码用 `./node_modules/...` 这样的相对 import()。
const BOOT_FILE = /\/(boot\.[0-9a-f]{12}\.js)$/;

/**
 * 开发服务器：给 HTML 响应加上 Tauri 开发窗口的 CSP（devCsp），改写其中的内联脚本，
 * 并从内存提供抽出的脚本。这样在普通浏览器里 `npm run dev` 也和 Tauri 窗口受同样的约束。
 */
export function devCsp(policy: string): Plugin {
  const served = new Map<string, string>();
  return {
    name: "ldos-dev-csp",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const boot = BOOT_FILE.exec((req.url ?? "").split("?")[0] ?? "");
        if (boot) {
          const code = served.get(boot[1] ?? "");
          res.statusCode = code === undefined ? 404 : 200;
          res.setHeader("Content-Type", "text/javascript; charset=utf-8");
          res.setHeader("Cache-Control", "no-store");
          res.end(code ?? "");
          return;
        }
        rewriteHtmlResponse(res, (html) => {
          const { html: rewritten, scripts } = extractInlineScripts(html, (name) => `./${name}`);
          for (const script of scripts) served.set(script.name, script.code);
          return rewritten;
        }, policy);
        next();
      });
    },
  };
}

type Chunk = string | Uint8Array;

/** 缓冲 text/html 响应体，改写后带正确的 Content-Length 一次发出；其他响应原样透传。 */
function rewriteHtmlResponse(res: ServerResponse, transform: (html: string) => string, policy: string): void {
  const original = { writeHead: res.writeHead, write: res.write, end: res.end };
  const chunks: Buffer[] = [];
  let deferredStatus: number | null = null;
  const isHtml = () => String(res.getHeader("content-type") ?? "").startsWith("text/html");
  const buffering = () => deferredStatus !== null || isHtml();

  res.writeHead = function (this: ServerResponse, status: number, ...rest: unknown[]) {
    const headers = rest.find((arg) => typeof arg === "object" && arg !== null && !Array.isArray(arg));
    if (headers) for (const [key, value] of Object.entries(headers)) this.setHeader(key, value as string);
    if (!isHtml()) return original.writeHead.call(this, status);
    deferredStatus = status;
    return this;
  } as typeof res.writeHead;

  res.write = function (this: ServerResponse, chunk: Chunk, ...rest: unknown[]) {
    if (!buffering()) return (original.write as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    chunks.push(Buffer.from(chunk));
    return true;
  } as typeof res.write;

  res.end = function (this: ServerResponse, chunk?: Chunk | (() => void), ...rest: unknown[]) {
    if (!buffering()) return (original.end as (...args: unknown[]) => ServerResponse).call(this, chunk, ...rest);
    if (chunk !== undefined && typeof chunk !== "function") chunks.push(Buffer.from(chunk));
    const body = Buffer.from(transform(Buffer.concat(chunks).toString("utf8")));
    this.setHeader("Content-Length", body.byteLength);
    this.setHeader("Content-Security-Policy", policy);
    original.writeHead.call(this, deferredStatus ?? this.statusCode);
    return (original.end as (body: Buffer) => ServerResponse).call(this, body);
  } as typeof res.end;
}
