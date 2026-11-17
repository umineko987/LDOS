import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// 图片都来自另一个源上的本地后端（桌面里页面是 mygo://localhost）。不带 crossorigin 的 <img> 请求没有 Origin，
// 只有 Sec-Fetch-Site: cross-site，后端的 local_origin_guard 会回 403 forbidden_cross_site。
// 带上 crossorigin="anonymous" 才会发 Origin，后端按 cors_origins 放行。mock 的 e2e 图片是同源的，抓不到这个问题。

const SRC = join(import.meta.dirname, "../..");

function svelteFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".svelte"))
    .map((path) => join(dir, path));
}

describe("images from the backend", () => {
  it("every <img> is a self-closing tag with crossorigin=\"anonymous\"", () => {
    const offenders: string[] = [];
    let count = 0;
    for (const file of svelteFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/<img\b[\s\S]*?\/>/g)) {
        count += 1;
        if (!/\bcrossorigin="anonymous"/.test(match[0])) offenders.push(`${file}: ${match[0].slice(0, 80)}`);
      }
      const opened = source.match(/<img\b/g)?.length ?? 0;
      const closed = source.match(/<img\b[\s\S]*?\/>/g)?.length ?? 0;
      if (opened !== closed) offenders.push(`${file}: <img> without "/>"`);
    }
    expect(count).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("preloads through new Image() use the same CORS mode", () => {
    for (const file of svelteFiles(SRC)) {
      const source = readFileSync(file, "utf8");
      if (source.includes("new Image()")) expect(source, file).toContain('.crossOrigin = "anonymous"');
    }
  });
});
