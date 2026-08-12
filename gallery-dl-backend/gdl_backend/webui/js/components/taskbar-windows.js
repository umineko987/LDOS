import { getApplicationDefinitionById } from "../core/app-definitions.js";
import { createElement } from "../core/dom.js";
import { createIcon } from "./icons.js";

export const _TASKBAR_VISIBLE_LIMIT = 6;
export const DOCK_FIXED_APP_IDS = Object.freeze(["crawl", "tasks", "gallery", "review"]);

const DOCK_OVERFLOW_LIST_ID = "dock-overflow-list";
const STATE_COPY = Object.freeze({
  closed: "已关闭",
  focused: "当前聚焦",
  background: "正在后台运行",
  minimized: "已最小化",
});

function requireDockApplication(appId) {
  const app = getApplicationDefinitionById(appId);
  if (!app) throw new TypeError("Dock 应用无效");
  return app;
}

function dockApplicationDescriptor(appId, record, focusedAppId) {
  const app = requireDockApplication(appId);
  const state = !record
    ? "closed"
    : record.windowState === "minimized"
      ? "minimized"
      : record.appId === focusedAppId
        ? "focused"
        : "background";
  const activation = {
    closed: "open",
    focused: "minimize",
    background: "focus",
    minimized: "restore",
  }[state];
  return Object.freeze({
    key: `app:${app.id}`,
    appId: app.id,
    label: app.label,
    title: app.windowTitle,
    icon: app.icon,
    state,
    stateLabel: STATE_COPY[state],
    activation,
    ariaLabel: `${app.label}，${STATE_COPY[state]}；${{
      open: "打开应用",
      minimize: "最小化窗口",
      focus: "聚焦窗口",
      restore: "恢复窗口",
    }[activation]}`,
  });
}

export function deriveDockModel(windowStack, focusedAppId, {
  visibleLimit = _TASKBAR_VISIBLE_LIMIT,
} = {}) {
  if (!Array.isArray(windowStack)) throw new TypeError("Dock 窗口栈必须是数组");
  if (!Number.isInteger(visibleLimit) || visibleLimit < 1) {
    throw new TypeError("Dock 可见项上限无效");
  }
  const records = new Map();
  for (const record of windowStack) {
    if (!record || typeof record.appId !== "string" || records.has(record.appId)) {
      throw new TypeError("Dock 窗口栈包含无效或重复应用");
    }
    requireDockApplication(record.appId);
    records.set(record.appId, record);
  }
  const dynamicIds = windowStack
    .map((record) => record.appId)
    .filter((appId) => !DOCK_FIXED_APP_IDS.includes(appId));
  const appIds = [...DOCK_FIXED_APP_IDS, ...dynamicIds];
  const items = Object.freeze([
    Object.freeze({
      key: "application-center",
      appId: null,
      label: "应用中心",
      title: "应用中心",
      icon: "grid",
      state: "launcher",
      stateLabel: "打开应用中心",
      activation: "open-center",
      ariaLabel: "应用中心；打开全部应用列表",
    }),
    ...appIds.map((appId) => dockApplicationDescriptor(
      appId,
      records.get(appId) || null,
      focusedAppId,
    )),
  ]);
  return Object.freeze({
    items,
    visible: Object.freeze(items.slice(0, visibleLimit)),
    overflow: Object.freeze(items.slice(visibleLimit)),
  });
}

export function activateDockItem(item, {
  openApplicationCenter,
  open,
  minimize,
  focus,
  restore,
} = {}) {
  const activation = item?.activation;
  if (activation === "open-center") {
    if (typeof openApplicationCenter !== "function") {
      throw new TypeError("Dock 应用中心处理器无效");
    }
    openApplicationCenter();
    return true;
  }
  if (
    typeof item?.appId !== "string"
    || !getApplicationDefinitionById(item.appId)
    || !["open", "minimize", "focus", "restore"].includes(activation)
  ) return false;
  const callback = { open, minimize, focus, restore }[activation];
  if (typeof callback !== "function") throw new TypeError("Dock 激活处理器无效");
  callback(item.appId);
  return true;
}

// Compatibility projections retained for callers that still consume the pure taskbar names.
export function describeTaskbarWindows(windowStack, focusedAppId) {
  if (!Array.isArray(windowStack)) throw new TypeError("任务栏窗口栈必须是数组");
  return Object.freeze(windowStack.map((record) => {
    const descriptor = dockApplicationDescriptor(record.appId, record, focusedAppId);
    return Object.freeze({
      appId: descriptor.appId,
      label: descriptor.label,
      title: descriptor.title,
      ariaPressed: String(descriptor.state === "focused"),
      minimized: descriptor.state === "minimized",
      activation: descriptor.activation,
    });
  }));
}

export function activateTaskbarWindow(descriptor, {
  canActivate = () => true,
  minimize,
  restore,
  focus,
} = {}) {
  if (typeof canActivate !== "function" || canActivate(descriptor?.appId, descriptor) !== true) {
    return false;
  }
  return activateDockItem(descriptor, { minimize, restore, focus });
}

export function deriveTaskbarWindowModel(windowStack, focusedAppId) {
  const buttons = describeTaskbarWindows(windowStack, focusedAppId);
  return Object.freeze({
    buttons,
    visible: Object.freeze(buttons.slice(0, _TASKBAR_VISIBLE_LIMIT)),
    overflow: Object.freeze(buttons.slice(_TASKBAR_VISIBLE_LIMIT)),
  });
}

export function createDock({
  container,
  onActivate,
  onOpenApplicationCenter,
  documentObject = globalThis.document,
}) {
  if (!(container instanceof HTMLElement)) throw new TypeError("Dock 容器无效");
  if (typeof onActivate !== "function") throw new TypeError("Dock 窗口激活回调无效");
  if (typeof onOpenApplicationCenter !== "function") {
    throw new TypeError("Dock 应用中心回调无效");
  }
  if (!documentObject || typeof documentObject.addEventListener !== "function") {
    throw new TypeError("Dock 需要可用的 document");
  }

  const primary = createElement("div", {
    className: "dock__primary",
    attributes: { role: "list", "aria-label": "常用和运行中的应用" },
    dataset: { dockPrimary: "" },
  });
  const overflowButton = createElement("button", {
    className: "dock__overflow-button",
    text: "更多",
    attributes: {
      type: "button",
      "aria-label": "更多 Dock 应用",
      "aria-controls": DOCK_OVERFLOW_LIST_ID,
      "aria-expanded": "false",
      title: "更多 Dock 应用",
      hidden: "",
    },
    dataset: { dockOverflowButton: "" },
  });
  const overflowPanel = createElement("div", {
    className: "dock__overflow",
    attributes: { id: DOCK_OVERFLOW_LIST_ID, hidden: "" },
    dataset: { dockOverflow: "" },
  });
  const overflowList = createElement("ul", {
    className: "dock__overflow-list",
    attributes: { "aria-label": "更多 Dock 应用" },
  });
  overflowPanel.append(overflowList);
  container.replaceChildren(primary, overflowButton, overflowPanel);

  let currentModel = deriveDockModel([], null);
  let destroyed = false;

  const createDockButton = (item) => {
    const button = createElement("button", {
      className: "dock__item",
      attributes: {
        type: "button",
        role: "listitem",
        "aria-label": item.ariaLabel,
        "aria-pressed": String(item.state === "focused"),
        title: item.ariaLabel,
      },
      dataset: { dockItem: item.key, dockState: item.state },
    });
    button.append(
      createElement("span", { className: "dock__icon", attributes: { "aria-hidden": "true" } }, [
        createIcon(item.icon, { size: 25, strokeWidth: 1.7 }),
      ]),
      createElement("span", { className: "dock__label", text: item.label }),
      createElement("span", {
        className: "dock__state",
        text: item.stateLabel,
        attributes: { "aria-hidden": "true" },
      }),
    );
    return button;
  };

  const closeOverflow = ({ returnFocus = false } = {}) => {
    const wasOpen = overflowButton.getAttribute("aria-expanded") === "true";
    overflowButton.setAttribute("aria-expanded", "false");
    overflowPanel.hidden = true;
    if (returnFocus && wasOpen && !overflowButton.hidden) {
      overflowButton.focus({ preventScroll: true });
    }
    return wasOpen;
  };

  const render = (windowStack, focusedAppId, options = {}) => {
    if (destroyed) return;
    closeOverflow();
    currentModel = deriveDockModel(windowStack, focusedAppId, options);
    primary.replaceChildren(...currentModel.visible.map(createDockButton));
    overflowList.replaceChildren(...currentModel.overflow.map((item) => {
      const listItem = createElement("li");
      listItem.append(createDockButton(item));
      return listItem;
    }));
    overflowButton.hidden = currentModel.overflow.length === 0;
    container.toggleAttribute("data-has-overflow", currentModel.overflow.length > 0);
  };

  const itemFromEvent = (event) => {
    if (!(event.target instanceof Element)) return null;
    const button = event.target.closest("[data-dock-item]");
    if (!(button instanceof HTMLButtonElement) || !container.contains(button)) return null;
    const item = currentModel.items.find((candidate) => candidate.key === button.dataset.dockItem);
    return item ? { item, button } : null;
  };
  const onClick = (event) => {
    if (event.target === overflowButton) return;
    const match = itemFromEvent(event);
    if (!match) return;
    closeOverflow();
    activateDockItem(match.item, {
      openApplicationCenter: () => onOpenApplicationCenter(match.button),
      open: (appId) => onActivate("open", appId),
      minimize: (appId) => onActivate("minimize", appId),
      focus: (appId) => onActivate("focus", appId),
      restore: (appId) => onActivate("restore", appId),
    });
  };
  const onOverflowClick = () => {
    const open = overflowButton.getAttribute("aria-expanded") !== "true";
    overflowButton.setAttribute("aria-expanded", String(open));
    overflowPanel.hidden = !open;
    if (open) overflowList.querySelector("button")?.focus({ preventScroll: true });
  };
  const onOutsidePointerDown = (event) => {
    if (
      overflowButton.getAttribute("aria-expanded") === "true"
      && event.target instanceof Node
      && !container.contains(event.target)
    ) closeOverflow();
  };
  const onKeyDown = (event) => {
    if (event.key !== "Escape" || overflowButton.getAttribute("aria-expanded") !== "true") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeOverflow({ returnFocus: true });
  };

  container.addEventListener("click", onClick);
  overflowButton.addEventListener("click", onOverflowClick);
  documentObject.addEventListener("pointerdown", onOutsidePointerDown);
  documentObject.addEventListener("keydown", onKeyDown);

  return Object.freeze({
    render,
    closeOverflow,
    focusButton(appId) {
      const key = appId === null ? "application-center" : `app:${appId}`;
      const visibleButton = primary.querySelector(`[data-dock-item="${key}"]`);
      if (visibleButton instanceof HTMLButtonElement) {
        visibleButton.focus({ preventScroll: true });
        return true;
      }
      const overflowItem = currentModel.overflow.some((item) => item.key === key);
      if (overflowItem && !overflowButton.hidden) {
        overflowButton.focus({ preventScroll: true });
        return true;
      }
      return false;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      container.removeEventListener("click", onClick);
      overflowButton.removeEventListener("click", onOverflowClick);
      documentObject.removeEventListener("pointerdown", onOutsidePointerDown);
      documentObject.removeEventListener("keydown", onKeyDown);
      container.replaceChildren();
    },
  });
}

export function createTaskbarWindowList({ container, onActivate, documentObject = globalThis.document }) {
  return createDock({
    container,
    documentObject,
    onOpenApplicationCenter() {},
    onActivate(activation, appId) {
      onActivate({ appId, activation });
    },
  });
}
