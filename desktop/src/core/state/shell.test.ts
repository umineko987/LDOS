import { describe, expect, it, vi } from "vitest";

import type { ApplicationId } from "../applications/definitions";
import { createShellStore, isDockHidden, type ShellPersistence, type WindowPlacement } from "./shell";

function persistenceWith(placements: readonly WindowPlacement[] = []): ShellPersistence & {
  readWindowPlacement: ReturnType<typeof vi.fn>;
  writeWindowPlacement: ReturnType<typeof vi.fn>;
  writeCurrentApp: ReturnType<typeof vi.fn>;
} {
  const byId = new Map(placements.map((placement) => [placement.appId, placement]));
  return {
    readWindowPlacement: vi.fn((appId: ApplicationId) => byId.get(appId) ?? null),
    writeWindowPlacement: vi.fn(() => true),
    writeCurrentApp: vi.fn(() => true),
  };
}

const unknown = "unknown" as ApplicationId;

describe("desktop shell state owner", () => {
  it("owns the one stable z-order and derives Dock visibility from only the focused window", () => {
    const shell = createShellStore();
    expect(shell.openApplication("review")).toBe(true);
    expect(shell.getState().windows).toEqual([
      { appId: "review", state: "maximized", rect: { x: 160, y: 64, w: 800, h: 560 } },
    ]);
    expect(isDockHidden(shell.getState())).toBe(true);
    expect(isDockHidden({ ...shell.getState(), focusedAppId: unknown })).toBe(false);

    shell.openApplication("crawl");
    shell.openApplication("tasks");
    expect(shell.getState().windows.map(({ appId }) => appId)).toEqual(["review", "crawl", "tasks"]);
    expect(shell.getState().focusedAppId).toBe("tasks");
    expect(isDockHidden(shell.getState())).toBe(false);

    expect(shell.focusApplication("review")).toBe(true);
    expect(shell.getState().windows.map(({ appId }) => appId)).toEqual(["crawl", "tasks", "review"]);
    expect(isDockHidden(shell.getState())).toBe(true);
    expect(shell.focusApplication("review")).toBe(false);
    expect(shell.focusApplication(unknown)).toBe(false);
    expect(shell.openApplication("review")).toBe(false);
  });

  it("opens from placement preferences without restoring a workspace", () => {
    const persistence = persistenceWith([
      { appId: "crawl", rect: { x: 48, y: 36, w: 720, h: 480 }, maximized: true },
      { appId: "tasks", rect: { x: 90, y: 40, w: 700, h: 460 }, maximized: false },
    ]);
    const shell = createShellStore({ persistence });
    expect(shell.getState().windows).toEqual([]);
    shell.openApplication("crawl");
    expect(shell.getState().windows).toEqual([
      { appId: "crawl", state: "maximized", rect: { x: 48, y: 36, w: 720, h: 480 } },
    ]);
    shell.openApplication("tasks");
    expect(shell.getState().windows.at(-1)).toEqual({
      appId: "tasks", state: "normal", rect: { x: 90, y: 40, w: 700, h: 460 },
    });
    expect(persistence.readWindowPlacement).toHaveBeenCalledTimes(2);
    expect(persistence.writeCurrentApp).toHaveBeenLastCalledWith("tasks");
  });

  it("handles open, minimize, restore, maximize, move, close, and focus fallback", async () => {
    const persistence = persistenceWith();
    const shell = createShellStore({ persistence });
    shell.openApplication("review");
    shell.openApplication("crawl");

    expect(shell.toggleMaximized("crawl")).toBe(true);
    expect(shell.getState().windows.at(-1)?.state).toBe("maximized");
    expect(shell.commitWindowRect("crawl", { x: 10, y: 10, w: 700, h: 500 })).toBe(false);
    expect(shell.toggleMaximized("crawl")).toBe(true);
    expect(shell.commitWindowRect("crawl", { x: 72, y: 48, w: 760, h: 510 })).toBe(true);
    expect(shell.commitWindowRect("crawl", { x: 72, y: 48, w: 760, h: 510 })).toBe(false);
    expect(shell.commitWindowRect(unknown, { x: 0, y: 0, w: 400, h: 300 })).toBe(false);

    const beforeMinimize = vi.fn(() => {
      expect(shell.getState().windows.find(({ appId }) => appId === "crawl")?.state).toBe("normal");
    });
    await expect(shell.requestMinimize("crawl", beforeMinimize)).resolves.toBe(true);
    expect(beforeMinimize).toHaveBeenCalledOnce();
    expect(shell.getState().focusedAppId).toBe("review");
    expect(shell.getState().windows.find(({ appId }) => appId === "crawl")?.state).toBe("minimized");
    expect(shell.focusApplication("crawl")).toBe(false);
    expect(shell.toggleMaximized("crawl")).toBe(false);
    await expect(shell.requestMinimize("crawl")).resolves.toBe(false);

    expect(shell.restoreApplication("crawl")).toBe(true);
    expect(shell.getState().windows.at(-1)?.state).toBe("normal");
    const beforeClose = vi.fn(() => {
      expect(shell.getState().windows.some(({ appId }) => appId === "crawl")).toBe(true);
    });
    await expect(shell.requestClose("crawl", beforeClose)).resolves.toBe(true);
    expect(beforeClose).toHaveBeenCalledOnce();
    expect(shell.getState().focusedAppId).toBe("review");
    await expect(shell.requestClose("crawl")).resolves.toBe(false);
    await expect(shell.requestLeave("crawl")).resolves.toBe(false);
    await expect(shell.requestMinimize(unknown)).resolves.toBe(false);
    expect(shell.toggleMaximized(unknown)).toBe(false);
    expect(persistence.writeWindowPlacement).toHaveBeenCalledWith(expect.objectContaining({
      appId: "crawl",
      maximized: false,
    }));
  });

  it("keeps application-center, menu, and Dock overflow state in the same owner", () => {
    const shell = createShellStore();
    const snapshots: boolean[] = [];
    const unsubscribe = shell.subscribe((state) => snapshots.push(state.applicationCenterOpen));
    shell.setApplicationCenter(true);
    shell.setApplicationCenter(true);
    expect(shell.getState()).toMatchObject({ applicationCenterOpen: true, openMenu: null });
    shell.setOpenMenu("window");
    shell.setOpenMenu("window");
    expect(shell.getState()).toMatchObject({ applicationCenterOpen: false, openMenu: "window" });
    shell.setDockOverflow(true);
    shell.setDockOverflow(true);
    expect(shell.getState()).toMatchObject({ openMenu: null, dockOverflowOpen: true });
    shell.openApplication("review");
    shell.setDockOverflow(true);
    expect(shell.getState().dockOverflowOpen).toBe(false);
    unsubscribe();
    shell.setApplicationCenter(true);
    expect(snapshots.at(-1)).toBe(false);
  });

  it("uses one single-flight unsaved confirmation for close, minimize, and leave", async () => {
    const shell = createShellStore({ hasUnsavedChanges: (appId) => appId === "policy" });
    shell.openApplication("policy");
    shell.openApplication("tasks");

    const first = shell.requestMinimize("policy");
    const duplicate = shell.requestMinimize("policy");
    expect(duplicate).toBe(first);
    expect(shell.getState().confirmation).toMatchObject({
      appId: "policy",
      intent: "minimize",
      confirmLabel: "放弃并最小化",
    });
    await expect(shell.requestClose("policy")).resolves.toBe(false);
    await expect(shell.requestClose("tasks")).resolves.toBe(true);
    expect(shell.resolveConfirmation(false)).toBe(true);
    await expect(first).resolves.toBe(false);
    expect(shell.getState().windows.find(({ appId }) => appId === "policy")?.state).toBe("normal");

    const beforeConfirmedClose = vi.fn();
    const close = shell.requestClose("policy", beforeConfirmedClose);
    expect(beforeConfirmedClose).not.toHaveBeenCalled();
    expect(shell.resolveConfirmation(true)).toBe(true);
    await expect(close).resolves.toBe(true);
    expect(beforeConfirmedClose).toHaveBeenCalledOnce();
    expect(shell.getState().confirmation).toBeNull();
    expect(shell.resolveConfirmation(true)).toBe(false);

    shell.openApplication("policy");
    const leave = shell.requestLeave("policy");
    expect(shell.getState().confirmation?.intent).toBe("leave");
    shell.resolveConfirmation(true);
    await expect(leave).resolves.toBe(true);
  });

  it("fails closed when the unsaved boundary throws and cancels pending work on destroy", async () => {
    const shell = createShellStore({ hasUnsavedChanges: () => { throw new Error("domain failure"); } });
    shell.openApplication("vault");
    const pending = shell.requestClose("vault");
    expect(shell.getState().confirmation?.title).toBe("关闭窗口？");
    shell.destroy();
    shell.destroy();
    await expect(pending).resolves.toBe(false);
    shell.setApplicationCenter(true);
    expect(shell.getState().applicationCenterOpen).toBe(false);
  });
});
