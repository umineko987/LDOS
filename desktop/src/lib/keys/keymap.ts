// 分层的按键注册表。命令面板（Ctrl+K）和快捷键表（?）都从这里生成，不另写清单。
//
// 层次：overlay（栈，最上面的优先）→ page（当前路由）→ global（外壳）。
// 有 overlay 打开时它是模态的：只有最上面的 overlay 收到按键。
//
// Esc 不走普通绑定，而是一条固定的链，按顺序找第一个处理它的：
//   1. 关闭最上面的 overlay；
//   2. selection：清空选择；
//   3. focus：退出专注视图，没有的话让输入框失焦；
//   4. up：回到上一级路由。

/** 只读文案；传 Paraglide 的消息函数，切换语言后重新取值。 */
export type Text = () => string;

export type BindingScope = "global" | "page";

export type EscapeStep = "selection" | "focus" | "up";

export const ESCAPE_STEPS: readonly EscapeStep[] = ["selection", "focus", "up"];

export interface KeyBinding {
  /** 稳定标识，形如 `nav.library`；e2e 和面板条目用它定位。 */
  readonly id: string;
  /** `mod+k`、`?`、`shift+d`、`arrowdown`；省略时只出现在命令面板里。 */
  readonly keys?: string | readonly string[];
  readonly label: Text;
  /** 面板和快捷键表里的分组标题。 */
  readonly group: Text;
  /** 返回 false 表示没处理，继续找下一个绑定。 */
  readonly run: (event?: KeyboardEventLike) => void | boolean;
  /** 返回 false 时这个绑定暂不可用（不响应按键，也不进面板）。 */
  readonly when?: () => boolean;
  /** 输入框里是否响应。默认：带 mod/alt 的组合键响应，单键不响应。 */
  readonly inInput?: boolean;
  /** 出现在 Ctrl+K 面板里。 */
  readonly palette?: boolean;
  /** 出现在快捷键表里；默认有 keys 就出现。 */
  readonly sheet?: boolean;
  /** 面板里的额外搜索词（拼音、英文别名）。 */
  readonly keywords?: readonly string[];
}

export interface OverlayOptions {
  readonly id: string;
  readonly bindings?: readonly KeyBinding[];
  /** 自己处理 Esc 的 overlay（bits-ui 的 Dialog/Sheet 自己关闭，不用传）。 */
  readonly onEscape?: () => void;
}

/** KeyboardEvent 里注册表用到的部分，测试里可以直接传对象。 */
export interface KeyboardEventLike {
  readonly key: string;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented?: boolean;
  readonly target?: unknown;
  preventDefault?(): void;
}

export interface KeySection {
  readonly title: string;
  readonly items: readonly { readonly id: string; readonly label: string; readonly keys: readonly string[] }[];
}

export interface Keymap {
  readonly isMac: boolean;
  register(scope: BindingScope, bindings: readonly KeyBinding[]): () => void;
  pushOverlay(options: OverlayOptions): () => void;
  /** 处理器返回 true 表示这次 Esc 已被消费。 */
  onEscape(step: EscapeStep, handler: () => boolean): () => void;
  readonly overlayOpen: boolean;
  /** 处理一次 keydown；命中时调用 preventDefault 并返回 true。 */
  handle(event: KeyboardEventLike): boolean;
  /** 当前可用的命令面板条目，按注册顺序（page 在前）。 */
  commands(): KeyBinding[];
  /** 快捷键表：global 和 page 层里带按键的绑定，按分组。 */
  sections(): KeySection[];
  /** 注册表变化时通知（用来让面板和快捷键表重新取值）。 */
  subscribe(listener: () => void): () => void;
}

const MODIFIERS = ["mod", "alt", "shift"] as const;
const KEY_ALIASES: Readonly<Record<string, string>> = { esc: "escape", " ": "space", spacebar: "space" };

function normalizeKey(key: string): string {
  const lower = key.toLowerCase();
  return Object.hasOwn(KEY_ALIASES, lower) ? KEY_ALIASES[lower]! : lower;
}

/** 把 `Mod+Shift+K` 规范成 `mod+shift+k`，修饰键按固定顺序。 */
export function normalizeChord(chord: string): string {
  const parts = chord.split("+").map((part) => part.trim().toLowerCase());
  // `mod++` 里最后一段是按键 `+` 本身。
  const key = chord.endsWith("++") || chord === "+" ? "+" : parts.pop();
  if (!key) throw new TypeError(`invalid_chord: ${chord}`);
  const modifiers = new Set(parts.filter(Boolean));
  for (const modifier of modifiers) {
    if (!(MODIFIERS as readonly string[]).includes(modifier)) throw new TypeError(`invalid_chord: ${chord}`);
  }
  const ordered = MODIFIERS.filter((modifier) => modifiers.has(modifier));
  return [...ordered, normalizeKey(key)].join("+");
}

/**
 * 事件转成规范写法。单个可打印的非字母字符（`?`、`/`）已经体现了 Shift，不再记 shift；
 * 字母则记 shift（`shift+d`）。
 */
export function chordFromEvent(event: KeyboardEventLike, isMac: boolean): string {
  const key = normalizeKey(event.key);
  const printableSymbol = event.key.length === 1 && !/[a-z]/i.test(event.key);
  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey && !printableSymbol) parts.push("shift");
  parts.push(key);
  return parts.join("+");
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  escape: "Esc",
  enter: "Enter",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "Backspace",
  delete: "Del",
  tab: "Tab",
};

/** 快捷键表和面板里显示用的按键序列，例如 `["Ctrl", "K"]`、`["⌘", "K"]`。 */
export function formatChord(chord: string, isMac: boolean): string[] {
  return normalizeChord(chord)
    .split(/\+(?=.)/)
    .map((part) => {
      if (part === "mod") return isMac ? "⌘" : "Ctrl";
      if (part === "alt") return isMac ? "⌥" : "Alt";
      if (part === "shift") return isMac ? "⇧" : "Shift";
      if (Object.hasOwn(KEY_LABELS, part)) return KEY_LABELS[part]!;
      return part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1);
    });
}

function chordsOf(binding: KeyBinding): string[] {
  if (binding.keys === undefined) return [];
  return (typeof binding.keys === "string" ? [binding.keys] : binding.keys).map(normalizeChord);
}

interface EditableTarget {
  readonly isContentEditable?: boolean;
  readonly tagName?: string;
  readonly type?: string;
  blur?(): void;
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as EditableTarget;
  if (element.isContentEditable) return true;
  const tag = element.tagName?.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  return tag === "INPUT" && TEXT_INPUT_TYPES.has((element.type ?? "").toLowerCase());
}

export function detectMac(platform: string | undefined = globalThis.navigator?.platform): boolean {
  return /mac|iphone|ipad/i.test(platform ?? "");
}

interface Entry {
  readonly bindings: readonly KeyBinding[];
  readonly chords: ReadonlyMap<KeyBinding, readonly string[]>;
}

function entry(bindings: readonly KeyBinding[]): Entry {
  return { bindings, chords: new Map(bindings.map((binding) => [binding, chordsOf(binding)])) };
}

export function createKeymap({ isMac = detectMac() }: { isMac?: boolean } = {}): Keymap {
  const layers: Record<BindingScope, Entry[]> = { global: [], page: [] };
  const overlays: (OverlayOptions & { entry: Entry })[] = [];
  const escapes: Record<EscapeStep, (() => boolean)[]> = { selection: [], focus: [], up: [] };
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const remover = <T>(list: T[], item: T) => () => {
    const index = list.indexOf(item);
    if (index === -1) return;
    list.splice(index, 1);
    notify();
  };

  const available = (binding: KeyBinding) => binding.when?.() !== false;

  // 后注册的优先：页面里嵌套的组件可以覆盖外层的同名按键。
  const activeEntries = (): Entry[] => {
    const top = overlays.at(-1);
    if (top) return [top.entry];
    return [...layers.page].reverse().concat([...layers.global].reverse());
  };

  function runEscape(event: KeyboardEventLike): boolean {
    const top = overlays.at(-1);
    if (top) {
      top.onEscape?.();
      return true;
    }
    for (const step of ESCAPE_STEPS) {
      for (const handler of [...escapes[step]].reverse()) {
        if (handler()) return true;
      }
      if (step === "focus" && isEditableTarget(event.target)) {
        (event.target as EditableTarget).blur?.();
        return true;
      }
    }
    return false;
  }

  function runBinding(event: KeyboardEventLike, chord: string): boolean {
    const editable = isEditableTarget(event.target);
    const modified = chord.startsWith("mod+") || chord.includes("alt+");
    for (const { bindings, chords } of activeEntries()) {
      for (const binding of [...bindings].reverse()) {
        if (!chords.get(binding)!.includes(chord)) continue;
        if (editable && !(binding.inInput ?? modified)) continue;
        if (!available(binding)) continue;
        if (binding.run(event) !== false) return true;
      }
    }
    return false;
  }

  return {
    isMac,

    register(scope, bindings) {
      const item = entry(bindings);
      layers[scope].push(item);
      notify();
      return remover(layers[scope], item);
    },

    pushOverlay(options) {
      const item = { ...options, entry: entry(options.bindings ?? []) };
      overlays.push(item);
      notify();
      return remover(overlays, item);
    },

    onEscape(step, handler) {
      escapes[step].push(handler);
      return remover(escapes[step], handler);
    },

    get overlayOpen() {
      return overlays.length > 0;
    },

    handle(event) {
      if (event.defaultPrevented || event.isComposing) return false;
      const chord = chordFromEvent(event, isMac);
      const handled = chord === "escape" ? runEscape(event) : runBinding(event, chord);
      if (handled) event.preventDefault?.();
      return handled;
    },

    commands() {
      const seen = new Set<string>();
      const result: KeyBinding[] = [];
      for (const scope of ["page", "global"] as const) {
        for (const { bindings } of layers[scope]) {
          for (const binding of bindings) {
            if (!binding.palette || seen.has(binding.id) || !available(binding)) continue;
            seen.add(binding.id);
            result.push(binding);
          }
        }
      }
      return result;
    },

    sections() {
      const sections = new Map<string, { id: string; label: string; keys: string[] }[]>();
      for (const scope of ["global", "page"] as const) {
        for (const { bindings, chords } of layers[scope]) {
          for (const binding of bindings) {
            const keys = chords.get(binding)!;
            if (keys.length === 0 || binding.sheet === false) continue;
            const title = binding.group();
            const items = sections.get(title) ?? [];
            items.push({ id: binding.id, label: binding.label(), keys: [...keys] });
            sections.set(title, items);
          }
        }
      }
      return [...sections].map(([title, items]) => ({ title, items }));
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
