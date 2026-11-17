// 构建后步骤：把 dist 里每个 HTML 的内联启动脚本落成同目录的外部文件。
// 原因和做法见 external-boot.ts。必须在 frontend-manifest.mjs 之前运行。
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { extractInlineScripts, insertCspMeta } from "./external-boot.ts";

const { production: csp } = JSON.parse(await readFile(new URL("../csp.json", import.meta.url), "utf8"));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const entries = await readdir(dist, { withFileTypes: true, recursive: true });
let moved = 0;
for (const entry of entries) {
  if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
  const file = join(entry.parentPath, entry.name);
  const { html, scripts } = extractInlineScripts(await readFile(file, "utf8"), (name) => `./${name}`);
  for (const script of scripts) await writeFile(join(dirname(file), script.name), script.code, "utf8");
  await writeFile(file, insertCspMeta(html, csp), "utf8");
  moved += scripts.length;
}
if (!(await readFile(join(dist, "index.html"), "utf8")).includes('src="./boot.')) {
  throw new Error("dist/index.html 没有外置的启动脚本，SvelteKit 的输出格式可能变了");
}
console.log(`externalize-boot: moved ${moved} inline script(s)`);
