import { describe, expect, it } from "vitest";

import desktopSource from "../src/shell/Desktop.svelte?raw";

// Direct-manipulation windows are gone; navigation now owns page focus and lifecycle.
describe("workbench navigation lifecycle contract", () => {
  it("starts one hash router on mount and stops it on teardown", () => {
    expect(desktopSource.match(/createHashRouter\s*\(/g)).toHaveLength(1);
    expect(desktopSource).toContain("onMount(() => {");
    expect(desktopSource).toContain("router.start()");
    expect(desktopSource).toContain("router?.stop()");
    expect(desktopSource).toContain("router = null");
    expect(desktopSource).toContain('router?.navigate("crawl", { replace: true })');
    expect(desktopSource).toContain("shell.openApplication(change.appId)");
    expect(desktopSource).not.toMatch(/createWindowInteractionEngine|onpointermove|onKeyboardResize|requestAnimationFrame/);
  });

  it("focuses the current page after rendering without moving its scroll position", () => {
    expect(desktopSource).toContain("await tick()");
    expect(desktopSource).toContain("shell.getState().focusedAppId !== appId || aboutOpen");
    expect(desktopSource).toContain('`[data-app-page][data-app-id="${appId}"]`');
    expect(desktopSource).toContain("focus({ preventScroll: true })");
    expect(desktopSource).toContain('data-skip-link inert={aboutOpen || !!picker}');
    expect(desktopSource).toContain('tabindex="-1" aria-label={getApplicationDefinition(appId).title}');
  });

  it("restores the previous document motion preference on teardown", () => {
    expect(desktopSource).toContain("const previousMotion = document.documentElement.dataset.motion");
    expect(desktopSource).toContain("document.documentElement.dataset.motion = preferences.animations");
    expect(desktopSource).toContain("if (previousMotion === undefined) delete document.documentElement.dataset.motion");
    expect(desktopSource).toContain("else document.documentElement.dataset.motion = previousMotion");
  });
});
