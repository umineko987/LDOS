import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import App from "../src/App.svelte";

describe("P1 Svelte scaffold", () => {
  it("keeps the nocturne glass desktop product contract visible in the bootstrap shell", () => {
    const { body } = render(App);

    expect(body).toContain('data-product-contract="nocturne-glass-desktop"');
    expect(body).toContain("ImageWeave");
    expect(body).toContain("正在启动本地服务");
  });
});
