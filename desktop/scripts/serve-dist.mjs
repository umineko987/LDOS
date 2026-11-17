// 以生产 CSP 头提供 dist/，给 Playwright 的 dist 项目用：验证打包后的页面在
// csp.json 的 `production` 策略下能启动。用法：node scripts/serve-dist.mjs [port]
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist", import.meta.url));
const { production: csp } = JSON.parse(await readFile(new URL("../csp.json", import.meta.url), "utf8"));
const port = Number(process.argv[2] ?? process.env.LDOS_DIST_PORT ?? 1421);

const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

async function resolveFile(pathname) {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const file = join(root, relative);
  if (file !== root && !file.startsWith(root + sep)) return null;
  try {
    const info = await stat(file);
    if (info.isDirectory()) return resolveFile(join(pathname, "index.html"));
    return file;
  } catch {
    return null;
  }
}

createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const file = await resolveFile(pathname);
  if (!file) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("not found");
    return;
  }
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  const headers = { "Content-Type": type, "Cache-Control": "no-store" };
  if (type.startsWith("text/html")) headers["Content-Security-Policy"] = csp;
  response.writeHead(200, headers);
  response.end(await readFile(file));
}).listen(port, "localhost", () => {
  console.log(`serve-dist: http://localhost:${port}/`);
});
