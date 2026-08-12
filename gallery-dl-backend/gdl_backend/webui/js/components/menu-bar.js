import { createElement } from "../core/dom.js";
import { getApplicationDefinitionById } from "../core/app-definitions.js";

const MENU_ORDER = Object.freeze(["file", "edit", "view", "window", "help"]);
const MENU_LABELS = Object.freeze({
  file: "文件",
  edit: "编辑",
  view: "显示",
  window: "窗口",
  help: "帮助",
});

export function isShellShortcutTarget(target) {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(
    "input, textarea, select, button, a[href], [contenteditable]:not([contenteditable='false'])",
  ));
}

export function shortcutModifier(event) {
  return Boolean(event?.ctrlKey || event?.metaKey);
}

function shortcutPrefix(platform = globalThis.navigator?.platform || "") {
  return /Mac|iPhone|iPad|iPod/u.test(platform) ? "⌘" : "Ctrl";
}

export function deriveWindowMenu(windowStack, focusedAppId) {
  if (!Array.isArray(windowStack)) throw new TypeError("窗口菜单来源必须是数组");
  return Object.freeze(windowStack.map((record) => {
    const app = getApplicationDefinitionById(record?.appId);
    if (!app) throw new TypeError("窗口菜单应用无效");
    const minimized = record.windowState === "minimized";
    const focused = !minimized && record.appId === focusedAppId;
    return Object.freeze({
      id: `window:${app.id}`,
      appId: app.id,
      label: app.label,
      command: minimized ? "restore" : focused ? "minimize" : "focus",
      checked: focused,
      description: minimized ? "已最小化" : focused ? "当前窗口" : "后台窗口",
    });
  }));
}

export function createMenuBar({
  root,
  store,
  selectors,
  actions,
  onWindowCommand,
  onOpenApplicationCenter,
  onRefreshSummary,
  documentObject = globalThis.document,
  windowObject = globalThis.window,
}) {
  if (!(root instanceof HTMLElement)) throw new TypeError("菜单栏宿主无效");
  if (!store || typeof store.subscribe !== "function") throw new TypeError("菜单栏需要中央状态");
  if (!selectors || typeof selectors.windowStack !== "function") {
    throw new TypeError("菜单栏需要窗口 selector");
  }
  if (!actions || typeof actions.navigateToApp !== "function") {
    throw new TypeError("菜单栏需要 shell actions");
  }
  if (typeof onWindowCommand !== "function") {
    throw new TypeError("菜单栏需要窗口命令委托");
  }

  const appName = root.querySelector("[data-menu-current-app]");
  const menuHost = root.querySelector("[data-menu-items]");
  if (!(appName instanceof HTMLElement) || !(menuHost instanceof HTMLElement)) {
    throw new Error("菜单栏 DOM 不完整");
  }
  const prefix = shortcutPrefix();
  const buttons = new Map();
  const panels = new Map();
  let openMenuId = null;
  let currentStack = selectors.windowStack(store.getState());
  let focusedAppId = selectors.focusedAppId(store.getState());
  let destroyed = false;

  const menuDefinitions = () => ({
    file: [
      { id: "open-center", label: "打开应用中心", shortcut: `${prefix}+O`, enabled: true },
      { id: "import", label: "导入图片（待后端接入）", enabled: false },
      { id: "export", label: "导出数据集（待后端接入）", enabled: false },
    ],
    edit: [
      { id: "undo", label: "撤销（由当前应用处理）", enabled: false },
      { id: "redo", label: "重做（由当前应用处理）", enabled: false },
    ],
    view: [
      { id: "refresh-summary", label: "刷新系统摘要", shortcut: `${prefix}+R`, enabled: true },
      { id: "diagnostics", label: "打开系统诊断", enabled: true },
    ],
    window: deriveWindowMenu(currentStack, focusedAppId).map((item) => ({
      ...item,
      enabled: true,
    })),
    help: [
      { id: "documentation", label: "使用说明（待后端接入）", enabled: false },
      { id: "diagnostics", label: "系统诊断", enabled: true },
    ],
  });

  const closeMenu = ({ returnFocus = false } = {}) => {
    if (openMenuId === null) return false;
    const button = buttons.get(openMenuId);
    const panel = panels.get(openMenuId);
    button?.setAttribute("aria-expanded", "false");
    if (panel) panel.hidden = true;
    openMenuId = null;
    if (returnFocus) button?.focus({ preventScroll: true });
    return true;
  };

  const enabledItems = (panel) => [...panel.querySelectorAll('[role="menuitem"]')]
    .filter((item) => item.getAttribute("aria-disabled") !== "true");

  const openMenu = (menuId, { focus = "first" } = {}) => {
    if (destroyed || !buttons.has(menuId)) return false;
    closeMenu();
    openMenuId = menuId;
    const button = buttons.get(menuId);
    const panel = panels.get(menuId);
    button.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    const items = enabledItems(panel);
    const target = focus === "last" ? items.at(-1) : items[0];
    target?.focus({ preventScroll: true });
    return true;
  };

  const runCommand = (command) => {
    if (!command || command.enabled !== true) return false;
    if (command.id === "open-center") onOpenApplicationCenter?.();
    else if (command.id === "refresh-summary") onRefreshSummary?.();
    else if (command.id === "diagnostics") actions.navigateToApp("diagnostics");
    else if (command.id?.startsWith("window:")) {
      onWindowCommand(command.command, command.appId);
    } else return false;
    closeMenu();
    return true;
  };

  const renderMenus = () => {
    const definitions = menuDefinitions();
    for (const menuId of MENU_ORDER) {
      const panel = panels.get(menuId);
      const commands = definitions[menuId];
      panel.replaceChildren(...commands.map((command) => {
        const button = createElement("button", {
          className: "menu-popover__item",
          attributes: {
            type: "button",
            role: "menuitem",
            ...(command.enabled ? {} : { disabled: "", "aria-disabled": "true" }),
            ...(command.checked ? { "aria-checked": "true", role: "menuitemcheckbox" } : {}),
            title: command.enabled ? command.label : `${command.label}，不可用`,
          },
          dataset: { menuCommand: command.id },
        });
        button.append(
          createElement("span", { text: command.label }),
          command.shortcut
            ? createElement("kbd", { text: command.shortcut, attributes: { "aria-label": command.shortcut } })
            : createElement("span", { className: "menu-popover__description", text: command.description || "" }),
        );
        return button;
      }));
    }
  };

  for (const menuId of MENU_ORDER) {
    const button = createElement("button", {
      className: "menu-bar__trigger",
      text: MENU_LABELS[menuId],
      attributes: {
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": "false",
        "aria-controls": `shell-menu-${menuId}`,
      },
      dataset: { shellMenuTrigger: menuId },
    });
    const panel = createElement("div", {
      className: "menu-popover",
      attributes: { id: `shell-menu-${menuId}`, role: "menu", hidden: "" },
      dataset: { shellMenuPanel: menuId },
    });
    const wrapper = createElement("div", { className: "menu-bar__menu" }, [button, panel]);
    buttons.set(menuId, button);
    panels.set(menuId, panel);
    menuHost.append(wrapper);
  }
  renderMenus();

  const renderState = () => {
    currentStack = selectors.windowStack(store.getState());
    focusedAppId = selectors.focusedAppId(store.getState());
    appName.textContent = focusedAppId
      ? getApplicationDefinitionById(focusedAppId)?.label || ""
      : "";
    appName.hidden = !focusedAppId;
    renderMenus();
  };
  const unsubscribeStack = store.subscribe(selectors.windowStack, renderState);
  const unsubscribeFocus = store.subscribe(selectors.focusedAppId, renderState, {
    fireImmediately: true,
  });

  const onClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const trigger = event.target.closest("[data-shell-menu-trigger]");
    if (trigger instanceof HTMLButtonElement && root.contains(trigger)) {
      const menuId = trigger.dataset.shellMenuTrigger;
      if (openMenuId === menuId) closeMenu({ returnFocus: true });
      else openMenu(menuId);
      return;
    }
    const commandButton = event.target.closest("[data-menu-command]");
    if (!(commandButton instanceof HTMLButtonElement) || commandButton.disabled) return;
    const command = menuDefinitions()[openMenuId]?.find(
      (item) => item.id === commandButton.dataset.menuCommand,
    );
    runCommand(command);
  };

  const onDocumentKeyDown = (event) => {
    if (openMenuId !== null) {
      const panel = panels.get(openMenuId);
      const items = enabledItems(panel);
      const index = items.indexOf(documentObject.activeElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeMenu({ returnFocus: true });
        return;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const nextIndex = event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : event.key === "ArrowDown"
              ? (index + 1 + items.length) % items.length
              : (index - 1 + items.length) % items.length;
        items[nextIndex]?.focus({ preventScroll: true });
        return;
      }
    }
    if (isShellShortcutTarget(event.target) || !shortcutModifier(event) || event.altKey) return;
    if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      onRefreshSummary?.();
    } else if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      onOpenApplicationCenter?.();
    }
  };
  const onOutsidePointerDown = (event) => {
    if (openMenuId === null || !(event.target instanceof Node) || root.contains(event.target)) return;
    closeMenu();
  };

  root.addEventListener("click", onClick);
  documentObject.addEventListener("keydown", onDocumentKeyDown);
  documentObject.addEventListener("pointerdown", onOutsidePointerDown);

  return Object.freeze({
    render: renderState,
    close: closeMenu,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      closeMenu();
      unsubscribeStack();
      unsubscribeFocus();
      root.removeEventListener("click", onClick);
      documentObject.removeEventListener("keydown", onDocumentKeyDown);
      documentObject.removeEventListener("pointerdown", onOutsidePointerDown);
      menuHost.replaceChildren();
    },
  });
}
