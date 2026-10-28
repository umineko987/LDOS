import { describe, expect, it, vi } from "vitest";

import { createShellStore } from "./shell";

describe("workbench shell state", () => {
  it("starts empty and keeps unique applications in first-visit order", () => {
    const writeCurrentApp = vi.fn(() => true);
    const shell = createShellStore({ persistence: { writeCurrentApp } });
    const initial = shell.getState();
    expect(initial).toEqual({ openedAppIds: [], focusedAppId: null });
    expect(writeCurrentApp).not.toHaveBeenCalled();

    expect(shell.openApplication("review")).toBe(true);
    shell.openApplication("crawl");
    shell.openApplication("tasks");
    const openedAppIds = shell.getState().openedAppIds;
    expect(shell.openApplication("review")).toBe(true);
    expect(shell.getState()).toEqual({
      openedAppIds: ["review", "crawl", "tasks"], focusedAppId: "review",
    });
    expect(shell.getState().openedAppIds).toBe(openedAppIds);
    expect(initial.openedAppIds).toEqual([]);
    expect(Object.isFrozen(shell.getState())).toBe(true);
    expect(Object.isFrozen(openedAppIds)).toBe(true);
    expect(writeCurrentApp.mock.calls).toEqual([["review"], ["crawl"], ["tasks"], ["review"]]);
  });

  it("does not publish or persist a repeated open of the focused application", () => {
    const writeCurrentApp = vi.fn(() => true);
    const shell = createShellStore({ persistence: { writeCurrentApp } });
    const listener = vi.fn();
    shell.subscribe(listener);
    shell.openApplication("crawl");
    const state = shell.getState();
    expect(shell.openApplication("crawl")).toBe(false);
    expect(shell.getState()).toBe(state);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(writeCurrentApp).toHaveBeenCalledOnce();
  });

  it("retains dirty drafts across pages, including Vault, without preparing or discarding", () => {
    const shell = createShellStore();
    let vaultDirty = true;
    let reviewDirty = false;
    const vaultReader = vi.fn(() => vaultDirty);
    const discard = vi.fn();
    const prepare = vi.fn(async () => true);
    shell.openApplication("vault");
    shell.registerUnsavedChanges("vault", vaultReader, discard);
    shell.openApplication("review");
    shell.registerUnsavedChanges("review", () => reviewDirty, discard, prepare);
    shell.openApplication("tasks");
    expect(vaultReader).not.toHaveBeenCalled();
    expect(shell.hasUnsavedChanges()).toBe(true);
    expect(vaultDirty).toBe(true);

    vaultDirty = false;
    reviewDirty = true;
    expect(shell.hasUnsavedChanges()).toBe(true);
    shell.openApplication("vault");
    expect(reviewDirty).toBe(true);
    reviewDirty = false;
    expect(shell.hasUnsavedChanges()).toBe(false);
    expect(shell.getState().openedAppIds).toEqual(["vault", "review", "tasks"]);
    expect(discard).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("unregisters only the matching dirty registration, even when a reader is reused", () => {
    const shell = createShellStore();
    const reader = () => true;
    const unregister = shell.registerUnsavedChanges("vault", reader);
    const unregisterReplacement = shell.registerUnsavedChanges("vault", reader);
    unregister();
    unregister();
    expect(shell.hasUnsavedChanges()).toBe(true);
    unregisterReplacement();
    unregisterReplacement();
    expect(shell.hasUnsavedChanges()).toBe(false);
  });

  it("subscribes with the current state and stops notifications after unsubscribe", () => {
    const shell = createShellStore();
    const listener = vi.fn();
    const unsubscribe = shell.subscribe(listener);
    expect(listener).toHaveBeenLastCalledWith(shell.getState());
    shell.openApplication("crawl");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    unsubscribe();
    shell.openApplication("tasks");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("protects unsaved changes when a dirty reader throws", () => {
    const shell = createShellStore();
    shell.registerUnsavedChanges("vault", () => { throw new Error("domain failure"); });
    expect(shell.hasUnsavedChanges()).toBe(true);
  });

  it("destroys subscriptions and dirty registrations and prevents further navigation", () => {
    const writeCurrentApp = vi.fn(() => true);
    const shell = createShellStore({ persistence: { writeCurrentApp } });
    const listener = vi.fn();
    const unsubscribe = shell.subscribe(listener);
    shell.openApplication("vault");
    const reader = vi.fn(() => true);
    const unregister = shell.registerUnsavedChanges("vault", reader);
    const state = shell.getState();
    shell.destroy();
    shell.destroy();
    expect(shell.openApplication("tasks")).toBe(false);
    expect(shell.getState()).toBe(state);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(writeCurrentApp).toHaveBeenCalledOnce();
    const unregisterAfterDestroy = shell.registerUnsavedChanges("review", reader);
    expect(shell.hasUnsavedChanges()).toBe(false);
    expect(reader).not.toHaveBeenCalled();
    unsubscribe();
    unregister();
    unregisterAfterDestroy();
  });
});
