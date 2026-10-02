import { render } from "svelte/server";
import { describe, expect, it } from "vitest";

import App from "../src/App.svelte";

describe("desktop composition root", () => {
  it("keeps the supervised health gate while the workbench waits for FastAPI", () => {
    const { body } = render(App);

    expect(body).toContain('data-startup-phase="starting"');
    expect(body).toContain("LDOS");
    expect(body).toContain("正在启动本地服务");
    expect(body).not.toContain("bootstrap-menu");
    expect(body).not.toContain("bootstrap-dock");
  });
});
