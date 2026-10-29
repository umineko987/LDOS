import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures/test";

// 无头 Chromium 的 WebGL2 是 SwiftShader（软件实现）。要测自动选择的每条路径，
// 就在页面脚本运行前改掉设备名，或者干脆拿走 webgl2 上下文。
type GpuMode = "accelerated" | "software" | "none";

async function stubGpu(page: Page, mode: GpuMode) {
  await page.addInitScript((mode: GpuMode) => {
    if (mode === "none") {
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        return type === "webgl2" ? null : (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof getContext;
      return;
    }
    const name = mode === "accelerated" ? "Mesa Intel(R) Graphics (ADL GT2)" : "llvmpipe (LLVM 19.1.7, 256 bits)";
    const UNMASKED_RENDERER_WEBGL = 0x9246;
    const getParameter = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (this: WebGL2RenderingContext, parameter: number) {
      return parameter === UNMASKED_RENDERER_WEBGL ? name : getParameter.call(this, parameter);
    };
  }, mode);
}

/** 画布上不透明的像素数。WebGL 的绘制缓冲每帧清空，所以排在页面的绘制回调之后、同一帧里读。 */
async function paintedPixels(page: Page): Promise<number> {
  return page.getByTestId("gfx-stage").locator("canvas").evaluate(
    (canvas: HTMLCanvasElement) =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() => {
          let pixels: Uint8Array | Uint8ClampedArray;
          if (canvas.dataset.renderer === "webgl2") {
            const gl = canvas.getContext("webgl2")!;
            pixels = new Uint8Array(canvas.width * canvas.height * 4);
            gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
          } else {
            pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
          }
          let count = 0;
          for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count += 1;
          resolve(count);
        });
      }),
  );
}

function renderer(page: Page) {
  return page.getByTestId("gfx-renderer");
}

async function expectRenderer(page: Page, kind: string, reason: string | RegExp) {
  await expect(renderer(page)).toHaveAttribute("data-kind", kind);
  await expect(renderer(page)).toHaveAttribute("data-reason", reason);
  // 换渲染器时换的是整块画布，容器里始终只有当前这一块。
  await expect(page.getByTestId("gfx-stage").locator("canvas")).toHaveCount(1);
  await expect(page.getByTestId("gfx-stage").locator("canvas")).toHaveAttribute("data-renderer", kind);
}

function preference(page: Page, name: string) {
  return page.getByTestId("gfx-preference").getByRole("button", { name, exact: true });
}

test("画 5000 个方块并显示帧率", async ({ page }) => {
  await page.goto("/#/dev/gfx");
  await expect(page.getByTestId("gfx-count")).toHaveText("5000");
  await expect(preference(page, "自动")).toHaveAttribute("aria-pressed", "true");
  await expect(renderer(page)).toHaveAttribute("data-kind", /^(webgl2|canvas2d)$/);
  await expectRenderer(page, (await renderer(page).getAttribute("data-kind"))!, /^(auto|software|unsupported)$/);
  // 默认的无头 Chromium 用 SwiftShader：设备名对得上时必须认作软件渲染。
  const gpu = page.getByTestId("gfx-gpu");
  if ((await gpu.count()) && (await gpu.textContent())?.includes("SwiftShader")) {
    await expect(page.getByTestId("gfx-support")).toHaveAttribute("data-support", "software");
    await expect(renderer(page)).toContainText("Canvas2D · WebGL2 只有软件渲染，已改用 Canvas2D");
  }

  await expect.poll(async () => Number(await page.getByTestId("gfx-fps").getAttribute("data-fps"))).toBeGreaterThan(0);
  await expect(page.getByTestId("gfx-fps")).toHaveText(/^\d+ fps · \d+\.\d ms\/帧$/);
  expect(await paintedPixels(page)).toBeGreaterThan(10_000);
  await expect(page.getByTestId("gfx-lose")).toBeDisabled();
});

test("有硬件加速时自动用 WebGL2；上下文丢失后回退 Canvas2D，再选一次就重试", async ({ page }) => {
  await stubGpu(page, "accelerated");
  await page.goto("/#/dev/gfx");
  await expect(page.getByTestId("gfx-support")).toHaveAttribute("data-support", "accelerated");
  await expectRenderer(page, "webgl2", "auto");
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(10_000);

  await page.getByTestId("gfx-lose").click();
  await expectRenderer(page, "canvas2d", "context_lost");
  await expect(renderer(page)).toContainText("WebGL 上下文丢失，已改用 Canvas2D");
  await expect(page.getByTestId("gfx-lose")).toBeDisabled();
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(10_000);

  await preference(page, "自动").click();
  await expectRenderer(page, "webgl2", "auto");

  // 命令面板里也有这个页面的命令；上下文丢失只在 WebGL2 时出现。
  await page.keyboard.press("Control+k");
  const palette = page.getByRole("dialog");
  await page.keyboard.type("上下文");
  await expect(palette.locator('[data-command-id="gfx.lose"]')).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expectRenderer(page, "canvas2d", "context_lost");

  await page.keyboard.press("Control+k");
  await page.keyboard.type("上下文");
  await expect(palette.locator("[data-command-id]")).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("手动选择覆盖自动结果，保存在本机；数字键 1/2/3 切换", async ({ page }) => {
  await stubGpu(page, "software");
  await page.goto("/#/dev/gfx");
  await expectRenderer(page, "canvas2d", "software");

  await preference(page, "WebGL2").click();
  await expect(preference(page, "WebGL2")).toHaveAttribute("aria-pressed", "true");
  await expectRenderer(page, "webgl2", "forced");
  expect(await page.evaluate(() => localStorage.getItem("ldos.renderer"))).toBe("webgl2");

  await page.reload();
  await expect(preference(page, "WebGL2")).toHaveAttribute("aria-pressed", "true");
  await expectRenderer(page, "webgl2", "forced");

  await page.keyboard.press("3");
  await expectRenderer(page, "canvas2d", "forced");
  await expect(preference(page, "Canvas2D")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("1");
  await expectRenderer(page, "canvas2d", "software");
  expect(await page.evaluate(() => localStorage.getItem("ldos.renderer"))).toBe("auto");
});

test("没有 WebGL2 时始终用 Canvas2D", async ({ page }) => {
  await stubGpu(page, "none");
  await page.goto("/#/dev/gfx");
  await expect(page.getByTestId("gfx-support")).toHaveAttribute("data-support", "none");
  await expect(page.getByTestId("gfx-gpu")).toHaveCount(0);
  await expectRenderer(page, "canvas2d", "unsupported");

  await preference(page, "WebGL2").click();
  await expectRenderer(page, "canvas2d", "unsupported");
  await expect(renderer(page)).toContainText("没有 WebGL2，已改用 Canvas2D");
  await expect.poll(() => paintedPixels(page)).toBeGreaterThan(10_000);
});
