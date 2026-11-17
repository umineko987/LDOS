import { describe, expect, it } from "vitest";

import { extractInlineScripts, insertCspMeta } from "./external-boot.ts";

const src = (name: string) => `./${name}`;

describe("extractInlineScripts", () => {
  it("把内联启动脚本改成同目录的外部脚本", () => {
    const html = `<div><script>\n  kit.start();\n</script></div>`;
    const { html: out, scripts } = extractInlineScripts(html, src);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.code).toBe("\n  kit.start();\n");
    expect(scripts[0]?.name).toMatch(/^boot\.[0-9a-f]{12}\.js$/);
    expect(out).toBe(`<div><script src="./${scripts[0]?.name}"></script></div>`);
  });

  it("同样的内容得到同样的文件名", () => {
    const a = extractInlineScripts("<script>x()</script>", src).scripts[0]?.name;
    const b = extractInlineScripts("<p></p><script>x()</script>", src).scripts[0]?.name;
    expect(a).toBe(b);
  });

  it("保留 module 类型", () => {
    const { html } = extractInlineScripts(`<script type="module">x()</script>`, src);
    expect(html).toMatch(/^<script type="module" src="\.\/boot\.[0-9a-f]{12}\.js"><\/script>$/);
  });

  it("不动外部脚本、空脚本和数据块", () => {
    const html = [
      `<script src="./a.js"></script>`,
      `<script type="module" src='./b.js'>  </script>`,
      `<script></script>`,
      `<script type="application/json">{"a":1}</script>`,
      `<script type="importmap">{}</script>`,
    ].join("");
    const result = extractInlineScripts(html, src);
    expect(result.scripts).toEqual([]);
    expect(result.html).toBe(html);
  });
});

describe("insertCspMeta", () => {
  it("puts the production policy before every other head element, even without inline scripts", () => {
    const html = '<html><head><script src="./boot.js"></script></head><body></body></html>';
    expect(insertCspMeta(html, "script-src 'self'")).toBe(
      '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><script src="./boot.js"></script></head><body></body></html>',
    );
  });

  it("escapes the policy as an HTML attribute", () => {
    expect(insertCspMeta("<head></head>", '"<&>')).toBe(
      '<head><meta http-equiv="Content-Security-Policy" content="&quot;&lt;&amp;&gt;"></head>',
    );
  });

  it("fails the build when HTML has no head", () => {
    expect(() => insertCspMeta("<body></body>", "default-src 'self'")).toThrow("HTML has no head");
  });
});
