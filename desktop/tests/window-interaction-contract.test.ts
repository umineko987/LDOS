import { describe, expect, it } from "vitest";

import budgetContract from "./fixtures/p0-performance-budget.json";
import interactionSource from "../src/core/windowing/interaction.ts?raw";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import windowLayerSource from "../src/shell/WindowLayer.svelte?raw";

describe("P2 window interaction static contract", () => {
  it("takes over the P0 rAF and translate3d target in the desktop suite", () => {
    expect(interactionSource).toContain("scheduleProjection(session)");
    expect(interactionSource).toContain("frames.request");
    expect(interactionSource).toContain("translate3d(");
    expect(windowLayerSource).toContain("window.requestAnimationFrame(callback)");
    expect(windowLayerSource).toContain("window.cancelAnimationFrame(frameId)");
    expect(budgetContract.budgets.resize.size_writes_per_frame_max).toBe(1);
  });

  it("keeps one engine path and never writes shell or storage during pointer movement", () => {
    const pointerMoveBody = interactionSource.slice(
      interactionSource.indexOf("function onPointerMove"),
      interactionSource.indexOf("function onPointerUp"),
    );
    expect(pointerMoveBody).toContain("scheduleProjection(session)");
    expect(pointerMoveBody).not.toMatch(/commit|ShellStore|localStorage|sessionStorage|writeWindowPlacement/);
    expect(appWindowSource).not.toContain("onpointermove");
    expect(appWindowSource).not.toMatch(/style\.(?:left|top|width|height|transform)\s*=/);
    expect(windowLayerSource.match(/createWindowInteractionEngine\s*\(/g)).toHaveLength(1);
    expect(windowLayerSource).toContain("keyboardResizeWindowRect");
    expect(appWindowSource).toContain("onKeyboardResize");
  });

  it("releases capture, listeners, and pending frames on every cleanup", () => {
    for (const marker of [
      'frames.cancel(session.frameId)',
      'removeEventListener("pointermove"',
      'removeEventListener("pointerup"',
      'removeEventListener("pointercancel"',
      'removeEventListener("keydown"',
      'removeEventListener("blur"',
      'removeEventListener("lostpointercapture"',
      "releasePointerCapture(session.pointerId)",
      'removeAttribute("data-window-interacting")',
    ]) expect(interactionSource).toContain(marker);
    expect(windowLayerSource).toContain("interaction?.destroy()");
    expect(windowLayerSource).toContain("if (interaction?.isActive()) return");
  });
});
