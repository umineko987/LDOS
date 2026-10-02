import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing_selector:${selector}`);
  const open = source.indexOf("{", start);
  const close = source.indexOf("}", open);
  return source.slice(open + 1, close);
}

function appCss(directory: string): string {
  return readFileSync(new URL(`../src/apps/${directory}/${directory}.css`, import.meta.url), "utf8");
}

describe("application scrolling in the single content area", () => {
  it.each(["crawl", "tasks"])("keeps %s workspace and column content scrollable inside the page", (directory) => {
    const css = appCss(directory);
    const root = rule(css, `.${directory}-app`);
    expect(root).toMatch(/(?:^|;)\s*height:\s*100%\s*;/);
    expect(root).toMatch(/(?:^|;)\s*min-height:\s*0\s*;/);
    expect(rule(css, `.${directory}-workspace`)).toMatch(/(?:^|;)\s*overflow:\s*auto\s*;/);
    expect(rule(css, `.${directory}-column__scroll`)).toMatch(/(?:^|;)\s*overflow-y:\s*auto\s*;/);
    expect(css).not.toMatch(/\.app-window|data-maximized/);
  });

  it.each(["proxy", "vault", "policy", "diagnostics", "personalization"])("lets %s settings scroll vertically and collapse at narrow content widths", (directory) => {
    const css = appCss(directory);
    const root = rule(css, `.${directory}-app`);
    expect(root).toMatch(/(?:^|;)\s*height:\s*100%\s*;/);
    expect(root).toMatch(/(?:^|;)\s*min-width:\s*0\s*;/);
    expect(root).toMatch(/(?:^|;)\s*overflow-y:\s*auto\s*;/);
    const narrow = css.slice(css.indexOf("@container (max-width: 900px)"));
    expect(narrow).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(css).not.toMatch(/min-width:\s*(?:[89]\d\d|\d{4,})px|overflow-x:\s*(?:auto|scroll)|\.app-window|data-maximized/);
  });
});
