import { describe, expect, it, vi } from "vitest";

import { isActivationKey, nextDirectionalIndex, restoreFocus, trappedTabIndex } from "./focus";

describe("shell keyboard and focus contracts", () => {
  it("moves through menus, Dock, and application-center grids with wrapping", () => {
    expect(nextDirectionalIndex(1, 4, "ArrowDown")).toBe(2);
    expect(nextDirectionalIndex(3, 4, "ArrowRight")).toBe(0);
    expect(nextDirectionalIndex(0, 4, "ArrowUp")).toBe(3);
    expect(nextDirectionalIndex(2, 4, "ArrowLeft")).toBe(1);
    expect(nextDirectionalIndex(2, 4, "Home")).toBe(0);
    expect(nextDirectionalIndex(2, 4, "End")).toBe(3);
    expect(nextDirectionalIndex(2, 4, "Escape")).toBeNull();
    expect(nextDirectionalIndex(0, 0, "ArrowDown")).toBeNull();
  });

  it("traps Tab only at dialog boundaries", () => {
    expect(trappedTabIndex(0, 3, true)).toBe(2);
    expect(trappedTabIndex(2, 3, false)).toBe(0);
    expect(trappedTabIndex(1, 3, false)).toBeNull();
    expect(trappedTabIndex(1, 3, true)).toBeNull();
    expect(trappedTabIndex(0, 0, false)).toBeNull();
  });

  it("recognizes native activation keys and safely returns focus", () => {
    expect(isActivationKey("Enter")).toBe(true);
    expect(isActivationKey(" ")).toBe(true);
    expect(isActivationKey("Spacebar")).toBe(false);
    const focus = vi.fn();
    expect(restoreFocus({ focus })).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(restoreFocus({ isConnected: false, focus })).toBe(false);
    expect(restoreFocus(null)).toBe(false);
    expect(restoreFocus(undefined)).toBe(false);
  });
});
