import { describe, expect, it, vi } from "vitest";

import {
  chordFromEvent,
  createKeymap,
  detectMac,
  formatChord,
  isEditableTarget,
  normalizeChord,
  type KeyBinding,
  type KeyboardEventLike,
} from "./keymap.ts";

const group = () => "通用";

function binding(id: string, keys: KeyBinding["keys"], extra: Partial<KeyBinding> = {}): KeyBinding {
  return { id, keys, label: () => id, group, run: vi.fn(), ...extra };
}

function press(key: string, init: Partial<KeyboardEventLike> = {}) {
  return { key, preventDefault: vi.fn(), ...init } satisfies KeyboardEventLike;
}

const input = { tagName: "INPUT", type: "text", blur: vi.fn() };

describe("chord helpers", () => {
  it("规范化写法和事件", () => {
    expect(normalizeChord("Shift+Mod+K")).toBe("mod+shift+k");
    expect(normalizeChord("Esc")).toBe("escape");
    expect(normalizeChord("mod++")).toBe("mod++");
    expect(normalizeChord("+")).toBe("+");
    expect(() => normalizeChord("hyper+k")).toThrow("invalid_chord");
    expect(() => normalizeChord("mod+")).toThrow("invalid_chord");

    expect(chordFromEvent({ key: "k", ctrlKey: true }, false)).toBe("mod+k");
    expect(chordFromEvent({ key: "k", ctrlKey: true }, true)).toBe("k");
    expect(chordFromEvent({ key: "k", metaKey: true }, true)).toBe("mod+k");
    expect(chordFromEvent({ key: "?", shiftKey: true }, false)).toBe("?");
    expect(chordFromEvent({ key: "D", shiftKey: true, altKey: true }, false)).toBe("alt+shift+d");
    expect(chordFromEvent({ key: " " }, false)).toBe("space");
    expect(chordFromEvent({ key: "constructor" }, false)).toBe("constructor");
  });

  it("按平台格式化显示", () => {
    expect(formatChord("mod+shift+k", false)).toEqual(["Ctrl", "Shift", "K"]);
    expect(formatChord("mod+alt+k", true)).toEqual(["⌘", "⌥", "K"]);
    expect(formatChord("shift+arrowdown", true)).toEqual(["⇧", "↓"]);
    expect(formatChord("escape", false)).toEqual(["Esc"]);
    expect(formatChord("f2", false)).toEqual(["F2"]);
    expect(formatChord("mod++", false)).toEqual(["Ctrl", "+"]);
  });

  it("识别可编辑目标和 mac", () => {
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget({ tagName: "input", type: "checkbox" })).toBe(false);
    expect(isEditableTarget({ tagName: "TEXTAREA" })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(detectMac("MacIntel")).toBe(true);
    expect(detectMac("Linux x86_64")).toBe(false);
    expect(detectMac(undefined)).toBe(false);
    expect(typeof detectMac()).toBe("boolean");
  });
});

describe("createKeymap", () => {
  it("page 层优先于 global，后注册的优先，返回 false 时继续找", () => {
    const keymap = createKeymap({ isMac: false });
    const globalRun = vi.fn();
    const pageRun = vi.fn(() => false);
    const nestedRun = vi.fn();
    keymap.register("global", [binding("global.k", "mod+k", { run: globalRun })]);
    const disposePage = keymap.register("page", [binding("page.k", "mod+k", { run: pageRun })]);
    const disposeNested = keymap.register("page", [binding("nested.k", "mod+k", { run: nestedRun })]);

    const event = press("k", { ctrlKey: true });
    expect(keymap.handle(event)).toBe(true);
    expect(nestedRun).toHaveBeenCalledWith(event);
    expect(event.preventDefault).toHaveBeenCalled();

    disposeNested();
    disposeNested();
    expect(keymap.handle(press("k", { ctrlKey: true }))).toBe(true);
    expect(pageRun).toHaveBeenCalledTimes(1);
    expect(globalRun).toHaveBeenCalledTimes(1);

    disposePage();
    const miss = press("j", { ctrlKey: true });
    expect(keymap.handle(miss)).toBe(false);
    expect(miss.preventDefault).not.toHaveBeenCalled();
  });

  it("输入框里单键不响应，组合键和显式 inInput 响应；when 为假时跳过", () => {
    const keymap = createKeymap({ isMac: false });
    const sheet = vi.fn();
    const palette = vi.fn();
    const slash = vi.fn();
    let enabled = false;
    keymap.register("global", [
      binding("sheet", "?", { run: sheet }),
      binding("palette", "mod+k", { run: palette }),
      binding("search", "/", { run: slash, inInput: true }),
      binding("gated", "g", { when: () => enabled }),
    ]);
    expect(keymap.handle(press("?", { shiftKey: true, target: input }))).toBe(false);
    expect(keymap.handle(press("k", { ctrlKey: true, target: input }))).toBe(true);
    expect(keymap.handle(press("/", { target: input }))).toBe(true);
    expect(keymap.handle(press("g"))).toBe(false);
    enabled = true;
    expect(keymap.handle(press("g"))).toBe(true);
    expect(keymap.handle(press("?", { shiftKey: true }))).toBe(true);
    expect([sheet, palette, slash].map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("忽略已处理和输入法组合中的事件", () => {
    const keymap = createKeymap({ isMac: false });
    keymap.register("global", [binding("x", "x")]);
    expect(keymap.handle(press("x", { defaultPrevented: true }))).toBe(false);
    expect(keymap.handle(press("x", { isComposing: true }))).toBe(false);
  });

  it("overlay 打开时是模态的，只有最上层收到按键", () => {
    const keymap = createKeymap({ isMac: false });
    const globalRun = vi.fn();
    const overlayRun = vi.fn();
    keymap.register("global", [binding("global.k", "mod+k", { run: globalRun })]);
    const close = keymap.pushOverlay({ id: "palette", bindings: [binding("overlay.k", "mod+k", { run: overlayRun })] });
    const closeSheet = keymap.pushOverlay({ id: "sheet" });
    expect(keymap.overlayOpen).toBe(true);
    expect(keymap.handle(press("k", { ctrlKey: true }))).toBe(false);
    closeSheet();
    expect(keymap.handle(press("k", { ctrlKey: true }))).toBe(true);
    expect(overlayRun).toHaveBeenCalledTimes(1);
    close();
    expect(keymap.overlayOpen).toBe(false);
    keymap.handle(press("k", { ctrlKey: true }));
    expect(globalRun).toHaveBeenCalledTimes(1);
  });

  it("Esc 依次：关闭 overlay → 清空选择 → 退出专注/输入框失焦 → 上一级", () => {
    const keymap = createKeymap({ isMac: false });
    const order: string[] = [];
    let selected = 2;
    let focusMode = true;
    keymap.onEscape("up", () => (order.push("up"), true));
    keymap.onEscape("focus", () => {
      if (!focusMode) return false;
      focusMode = false;
      order.push("focus");
      return true;
    });
    keymap.onEscape("selection", () => {
      if (selected === 0) return false;
      selected = 0;
      order.push("selection");
      return true;
    });
    const onEscape = vi.fn(() => order.push("overlay"));
    const closeOverlay = keymap.pushOverlay({ id: "dialog", onEscape });
    const bitsDialog = keymap.pushOverlay({ id: "bits" });

    expect(keymap.handle(press("Escape"))).toBe(true); // bits-ui 自己关闭，这里只是不让 Esc 漏到页面
    bitsDialog();
    keymap.handle(press("Escape"));
    closeOverlay();
    keymap.handle(press("Escape"));
    keymap.handle(press("Escape"));
    const blur = vi.fn();
    keymap.handle(press("Escape", { target: { tagName: "TEXTAREA", blur } }));
    expect(blur).toHaveBeenCalledTimes(1);
    keymap.handle(press("Escape"));
    expect(order).toEqual(["overlay", "selection", "focus", "up"]);
  });

  it("没有处理器时 Esc 不被消费", () => {
    const keymap = createKeymap({ isMac: false });
    const event = press("Escape");
    expect(keymap.handle(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("命令面板条目去重、按 page → global 排序并尊重 when", () => {
    const keymap = createKeymap({ isMac: false });
    keymap.register("global", [
      binding("nav.datasets", "mod+1", { palette: true }),
      binding("nav.library", undefined, { palette: true }),
      binding("shell.sheet", "?"),
      binding("nav.hidden", undefined, { palette: true, when: () => false }),
    ]);
    keymap.register("page", [binding("page.export", undefined, { palette: true }), binding("nav.library", "l", { palette: true })]);
    expect(keymap.commands().map((command) => command.id)).toEqual(["page.export", "nav.library", "nav.datasets"]);
  });

  it("快捷键表按分组列出带按键的绑定", () => {
    const keymap = createKeymap({ isMac: false });
    keymap.register("global", [
      binding("palette", "mod+k", { group: () => "通用" }),
      binding("nav.library", undefined, { palette: true }),
      binding("hidden", "h", { sheet: false }),
    ]);
    keymap.register("page", [binding("select.all", ["mod+a", "shift+A"], { group: () => "选择" })]);
    expect(keymap.sections()).toEqual([
      { title: "通用", items: [{ id: "palette", label: "palette", keys: ["mod+k"] }] },
      { title: "选择", items: [{ id: "select.all", label: "select.all", keys: ["mod+a", "shift+a"] }] },
    ]);
  });

  it("注册表变化时通知订阅者", () => {
    const keymap = createKeymap({ isMac: false });
    const listener = vi.fn();
    const unsubscribe = keymap.subscribe(listener);
    const dispose = keymap.register("global", []);
    const pop = keymap.pushOverlay({ id: "x" });
    const off = keymap.onEscape("up", () => false);
    dispose();
    pop();
    off();
    expect(listener).toHaveBeenCalledTimes(5);
    unsubscribe();
    keymap.register("page", []);
    expect(listener).toHaveBeenCalledTimes(5);
    expect(createKeymap().isMac).toBe(false);
  });
});
