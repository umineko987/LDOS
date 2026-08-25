import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const applications = [
  ["Crawl", "crawl", ".crawl-app", ".crawl-column__scroll"],
  ["Tasks", "tasks", ".tasks-app", ".tasks-column__scroll"],
  ["Proxy", "proxy", ".proxy-app", ".proxy-column__scroll"],
  ["Vault", "vault", ".vault-app", ".vault-column-scroll"],
  ["Policy", "policy", ".policy-app", ".policy-column-scroll"],
  ["Diagnostics", "diagnostics", ".diagnostics-app", ".diagnostics-column-scroll"],
] as const;

function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing_selector:${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

describe("application vertical scrolling layout contract", () => {
  it.each(applications)("constrains %s to the window body and preserves its column scroller", (_, directory, root, scroller) => {
    const css = readFileSync(new URL(`../src/apps/${directory}/${directory}.css`, import.meta.url), "utf8");

    expect(rule(css, root)).toMatch(/(?:^|;)\s*height:\s*100%\s*;/);
    expect(rule(css, root)).toMatch(/(?:^|;)\s*min-height:\s*0\s*;/);
    expect(rule(css, scroller)).toMatch(/(?:^|;)\s*overflow(?:-y)?:\s*auto\s*;/);
  });
});
