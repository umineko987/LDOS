import { describe, expect, it, vi } from "vitest";

import {
  createShellPollingLifecycleSource,
  deriveApplicationGroups,
  deriveDockProjection,
  deriveWindowMenu,
} from "./projections";
import { createShellStore } from "./shell";

describe("single-source shell projections", () => {
  it("derives all application-center groups and order from definitions", () => {
    expect(deriveApplicationGroups().map((group) => ({
      id: group.id,
      title: group.title,
      applications: group.applications.map(({ id }) => id),
    }))).toEqual([
      { id: "workflow", title: "工作流", applications: ["crawl", "tasks", "gallery", "review"] },
      { id: "connections", title: "连接与策略", applications: ["proxy", "vault", "policy"] },
      { id: "system", title: "系统", applications: ["diagnostics", "personalization"] },
    ]);
  });

  it("projects fixed and dynamic Dock items without a copied application list", async () => {
    const shell = createShellStore();
    shell.openApplication("tasks");
    shell.openApplication("proxy");
    await shell.requestMinimize("proxy");
    shell.openApplication("vault");
    shell.openApplication("review");
    const model = deriveDockProjection(shell.getState(), 6);
    expect(model.items.map(({ key, state, activation }) => [key, state, activation])).toEqual([
      ["application-center", "launcher", "open-center"],
      ["app:crawl", "closed", "open"],
      ["app:tasks", "background", "focus"],
      ["app:gallery", "closed", "open"],
      ["app:review", "focused", "minimize"],
      ["app:proxy", "minimized", "restore"],
      ["app:vault", "background", "focus"],
    ]);
    expect(model.visible).toHaveLength(6);
    expect(model.overflow.map(({ key }) => key)).toEqual(["app:vault"]);
    expect(model.items[4].ariaLabel).toContain("当前聚焦；最小化窗口");
    expect(model.items[5].ariaLabel).toContain("已最小化；恢复窗口");
    expect(() => deriveDockProjection(shell.getState(), 0)).toThrow("invalid_dock_limit");
    expect(() => deriveDockProjection(shell.getState(), 1.5)).toThrow("invalid_dock_limit");
  });

  it("derives Window menu commands from the same z-order", async () => {
    const shell = createShellStore();
    shell.openApplication("crawl");
    shell.openApplication("tasks");
    shell.openApplication("proxy");
    await shell.requestMinimize("tasks");
    expect(deriveWindowMenu(shell.getState())).toEqual([
      { appId: "crawl", title: "图片采集", command: "focus", checked: false, description: "后台窗口" },
      { appId: "tasks", title: "批次管理", command: "restore", checked: false, description: "已最小化" },
      { appId: "proxy", title: "代理管理", command: "minimize", checked: true, description: "当前窗口" },
    ]);
  });

  it("projects only focused/open/minimized/closed lifecycle facts for polling", async () => {
    const shell = createShellStore();
    const source = createShellPollingLifecycleSource(shell);
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);
    expect(source.getFocusedScope()).toBeNull();
    expect(source.getScopeState("global")).toBe("unmanaged");
    expect(source.getScopeState("app:unknown")).toBe("unmanaged");
    expect(source.getScopeState("app:tasks")).toBe("closed");
    shell.setApplicationCenter(true);
    expect(listener).not.toHaveBeenCalled();

    shell.openApplication("tasks");
    expect(source.getFocusedScope()).toBe("app:tasks");
    expect(source.getScopeState("app:tasks")).toBe("open");
    expect(listener).toHaveBeenCalledOnce();
    await shell.requestMinimize("tasks");
    expect(source.getFocusedScope()).toBeNull();
    expect(source.getScopeState("app:tasks")).toBe("minimized");
    expect(listener).toHaveBeenCalledTimes(2);
    await shell.requestClose("tasks");
    expect(source.getScopeState("app:tasks")).toBe("closed");
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
    shell.openApplication("crawl");
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
