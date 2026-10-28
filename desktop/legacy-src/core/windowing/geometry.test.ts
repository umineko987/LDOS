import { describe, expect, it } from "vitest";

import {
  clampWindowRect,
  dragWindowRect,
  keyboardResizeWindowRect,
  maximizedWindowRect,
  resizeWindowRect,
  sameWindowRect,
} from "./geometry";

const viewport = { width: 1_000, height: 600 };
const rect = { x: 80, y: 60, w: 720, h: 480 };

describe("window geometry", () => {
  it("clamps normal rectangles while preserving a visible edge", () => {
    expect(clampWindowRect(rect, viewport)).toEqual(rect);
    expect(clampWindowRect({ x: -900, y: -900, w: 200, h: 100 }, viewport)).toEqual({
      x: -328,
      y: -208,
      w: 360,
      h: 240,
    });
    expect(clampWindowRect({ x: 2_000, y: 2_000, w: 400, h: 300 }, viewport)).toEqual({
      x: 968,
      y: 300,
      w: 400,
      h: 300,
    });
  });

  it("derives drag feedback from the immutable pointer-down rectangle", () => {
    expect(dragWindowRect(rect, { x: 120, y: -20 }, viewport)).toEqual({ x: 200, y: 40, w: 720, h: 480 });
    expect(dragWindowRect(rect, { x: 5_000, y: 5_000 }, viewport)).toEqual({ x: 968, y: 120, w: 720, h: 480 });
  });

  it("resizes right, bottom, and corner within the workspace", () => {
    expect(resizeWindowRect(rect, { x: 100, y: 100 }, "right", viewport)).toEqual({
      x: 80, y: 60, w: 820, h: 480,
    });
    expect(resizeWindowRect(rect, { x: 100, y: -300 }, "bottom", viewport)).toEqual({
      x: 80, y: 60, w: 720, h: 240,
    });
    expect(resizeWindowRect(rect, { x: 500, y: 500 }, "corner", viewport)).toEqual({
      x: 80, y: 60, w: 920, h: 540,
    });
    expect(resizeWindowRect({ x: 900, y: 500, w: 360, h: 240 }, { x: 10, y: 10 }, "corner", viewport))
      .toEqual({ x: 900, y: 360, w: 360, h: 240 });
  });

  it("uses the same resize policy for keyboard handles", () => {
    expect(keyboardResizeWindowRect(rect, "right", "ArrowRight", viewport)).toEqual({
      x: 80, y: 60, w: 736, h: 480,
    });
    expect(keyboardResizeWindowRect(rect, "bottom", "ArrowDown", viewport)).toEqual({
      x: 80, y: 60, w: 720, h: 496,
    });
    expect(keyboardResizeWindowRect(rect, "corner", "ArrowLeft", viewport)).toEqual({
      x: 80, y: 60, w: 704, h: 480,
    });
    expect(keyboardResizeWindowRect(rect, "right", "ArrowUp", viewport)).toBeNull();
    expect(keyboardResizeWindowRect(rect, "bottom", "ArrowLeft", viewport)).toBeNull();
    expect(keyboardResizeWindowRect(rect, "corner", "Enter", viewport)).toBeNull();
  });

  it("projects maximized geometry and compares all rectangle fields", () => {
    expect(maximizedWindowRect(viewport)).toEqual({ x: 0, y: 0, w: 1_000, h: 600 });
    expect(sameWindowRect(rect, { ...rect })).toBe(true);
    expect(sameWindowRect(rect, { ...rect, x: 81 })).toBe(false);
    expect(sameWindowRect(rect, { ...rect, y: 61 })).toBe(false);
    expect(sameWindowRect(rect, { ...rect, w: 721 })).toBe(false);
    expect(sameWindowRect(rect, { ...rect, h: 481 })).toBe(false);
  });
});
