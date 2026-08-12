import { getApplicationById } from "./app-registry.js";

function requireCloneElement(root, selector, Constructor = HTMLElement) {
  const element = root.querySelector(selector);
  if (!(element instanceof Constructor)) {
    throw new Error(`窗口模板缺少元素：${selector}`);
  }
  return element;
}

export function applyWindowRect(element, rect) {
  element.style.transform = "none";
  element.style.left = `${rect.x}px`;
  element.style.top = `${rect.y}px`;
  element.style.width = `${rect.w}px`;
  element.style.height = `${rect.h}px`;
}

export function createWindowDomLifecycle({
  bindInstanceEvents,
  displayedRect,
  forcedMobileMaximized,
  onBeforeRemove,
  onMount,
  onRemoved,
  onUnmount,
  onVisibilityChange,
  queueNormalRectRepair,
  windowLayer,
  windowTemplate,
}) {
  const instances = new Map();

  const notifyVisibility = (visible, app) => {
    if (!app || typeof onVisibilityChange !== "function") return;
    try {
      onVisibilityChange(visible, app);
    } catch {
      console.error("ImageWeave 应用生命周期执行失败");
    }
  };

  const create = (appId) => {
    const app = getApplicationById(appId);
    if (!app) throw new TypeError("窗口应用 ID 无效");
    const fragment = windowTemplate.content.cloneNode(true);
    const element = requireCloneElement(fragment, "[data-application-window]");
    const titlebarEl = requireCloneElement(element, "[data-window-titlebar]");
    const titleEl = requireCloneElement(element, "[data-window-title]");
    const bodyEl = requireCloneElement(element, "[data-window-body]");
    const minimize = requireCloneElement(
      element,
      "[data-window-minimize]",
      HTMLButtonElement,
    );
    const maximize = requireCloneElement(
      element,
      "[data-window-maximize]",
      HTMLButtonElement,
    );
    const close = requireCloneElement(element, "[data-window-close]", HTMLButtonElement);
    const resize = new Map();
    for (const direction of ["right", "bottom", "corner"]) {
      resize.set(direction, requireCloneElement(
        element,
        `[data-window-resize="${direction}"]`,
        HTMLButtonElement,
      ));
    }

    const titleId = `window-title-${app.id}`;
    const bodyId = `app-content-${app.id}`;
    element.dataset.appId = app.id;
    element.setAttribute("aria-labelledby", titleId);
    titleEl.id = titleId;
    titleEl.textContent = app.windowTitle;
    titleEl.title = app.windowTitle;
    bodyEl.id = bodyId;
    // 交通灯圆点由 CSS 绘制，避免视觉 glyph 缩小按钮的可点击命中区。

    const instance = {
      appId: app.id,
      element,
      titlebarEl,
      titleEl,
      bodyEl,
      buttons: { minimize, maximize, close, resize },
      visible: false,
      interaction: null,
      cleanupEvents: () => {},
    };
    bindInstanceEvents(instance);
    windowLayer.append(fragment);
    try {
      onMount?.(app, bodyEl);
    } catch (error) {
      instance.cleanupEvents();
      element.remove();
      throw error;
    }
    instances.set(app.id, instance);
    return instance;
  };

  const remove = (appId) => {
    const instance = instances.get(appId);
    if (!instance) return false;
    onBeforeRemove?.(appId, instance);
    const app = getApplicationById(appId);
    if (instance.visible) {
      instance.visible = false;
      notifyVisibility(false, app);
    }
    try {
      onUnmount?.(app, instance.bodyEl);
    } catch {
      console.error("ImageWeave 应用卸载失败");
    }
    instance.cleanupEvents();
    instance.element.remove();
    instances.delete(appId);
    onRemoved?.(appId, instance);
    return true;
  };

  const sync = (instance, record, view, zIndex, focusedAppId) => {
    const app = getApplicationById(record.appId);
    const forced = forcedMobileMaximized(record);
    instance.element.hidden = !view.visible;
    instance.element.dataset.windowVisibility = view.open ? "open" : "minimized";
    instance.element.dataset.windowState = record.windowState;
    instance.element.toggleAttribute("data-maximized", view.maximized);
    instance.element.toggleAttribute("data-window-focused", record.appId === focusedAppId);
    instance.element.toggleAttribute(
      "data-mobile-suppressed",
      forced && view.open && !view.visible,
    );
    // 数组就是 z 序的唯一事实源；zIndex 只投影到 DOM。
    instance.element.style.zIndex = String(zIndex);
    if (!instance.interaction) {
      const rect = displayedRect(record, view.maximized);
      applyWindowRect(instance.element, rect);
      if (view.open && !view.maximized) queueNormalRectRepair(record, rect);
    }

    instance.buttons.maximize.disabled = !app || forced;
    instance.buttons.maximize.setAttribute(
      "aria-disabled",
      String(instance.buttons.maximize.disabled),
    );
    instance.buttons.maximize.setAttribute("aria-pressed", String(view.maximized));
    instance.buttons.maximize.setAttribute(
      "aria-label",
      view.maximized ? "还原窗口" : "最大化窗口",
    );
    instance.buttons.maximize.title = view.maximized ? "还原窗口" : "最大化窗口";
    for (const handle of instance.buttons.resize.values()) {
      handle.hidden = false;
      handle.disabled = view.maximized;
      handle.tabIndex = view.maximized ? -1 : 0;
    }

    // 只有真实 minimized 才停用应用。
    if (instance.visible !== view.open) {
      instance.visible = view.open;
      notifyVisibility(view.open, app);
    }
  };

  return Object.freeze({
    bodyFor(appId) {
      return instances.get(appId)?.bodyEl || null;
    },
    create,
    focusBody(appId) {
      const instance = instances.get(appId);
      if (!instance || instance.element.hidden) return false;
      instance.bodyEl.focus({ preventScroll: true });
      return true;
    },
    get(appId) {
      return instances.get(appId);
    },
    has(appId) {
      return instances.has(appId);
    },
    keys() {
      return instances.keys();
    },
    remove,
    sync,
    values() {
      return instances.values();
    },
  });
}
