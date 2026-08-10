import { getApplicationById } from "./app-registry.js";
import {
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} from "./window-geometry.js";
import { createWindowHideController } from "./window-hide-controller.js";
import { createWindowInteractionController } from "./window-interaction.js";
import {
  deriveWindowManagerSnapshot,
  deriveWindowRenderPlan,
  deriveWindowViews,
  displayedWindowRect,
  isEffectivelyMaximized,
  isForcedMobileMaximized,
  normalWindowRect,
  sameWindowRect,
} from "./window-policy.js";
import { selectors } from "./store.js";

export { deriveWindowViews };
import { createIcon } from "../components/icons.js";
import {
  activateTaskbarWindow,
  createTaskbarWindowList,
} from "../components/taskbar-windows.js";

const MOBILE_QUERY = "(max-width: 767px)";

function requireCloneElement(root, selector, Constructor = HTMLElement) {
  const element = root.querySelector(selector);
  if (!(element instanceof Constructor)) {
    throw new Error(`窗口模板缺少元素：${selector}`);
  }
  return element;
}

export function createWindowManager({
  windowLayer,
  windowTemplate,
  taskList,
  store,
  actions,
  onMount,
  onUnmount,
  onVisibilityChange,
  onCloseFocus,
  onBeforeHide,
}) {
  const mobileViewport = window.matchMedia(MOBILE_QUERY);
  const windows = new Map();
  const pendingRectRepairs = new Map();
  let currentStack = selectors.windowStack(store.getState());
  let currentView = selectors.windowView(store.getState());
  let taskbarWindows = null;
  let destroying = false;
  let destroyed = false;

  const viewportSnapshot = () => ({
    width: Math.max(32, window.innerWidth || document.documentElement.clientWidth || 1280),
    height: Math.max(32, window.innerHeight || document.documentElement.clientHeight || 720),
  });

  const geometryOptions = (viewport = viewportSnapshot()) => {
    let taskbarHeight = 0;
    try {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--imageweave-taskbar-height");
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) taskbarHeight = parsed;
    } catch {
      // CSS Token 不可读时使用零高度，窗口仍由纯几何函数保持至少 32px 可见。
    }
    return {
      minW: WINDOW_MIN_WIDTH,
      minH: WINDOW_MIN_HEIGHT,
      taskbarHeight: Math.min(taskbarHeight, Math.max(0, viewport.height - 32)),
    };
  };

  const recordFor = (appId) => (
    selectors.windowStack(store.getState()).find((record) => record.appId === appId) || null
  );

  const forcedMobileMaximized = (record) => (
    isForcedMobileMaximized(record, mobileViewport.matches)
  );

  const effectivelyMaximized = (record) => (
    isEffectivelyMaximized(record, mobileViewport.matches)
  );

  const normalRect = (record) => {
    const viewport = viewportSnapshot();
    return normalWindowRect(record, viewport, geometryOptions(viewport));
  };

  const queueNormalRectRepair = (record, rect) => {
    if (sameWindowRect(record.rect, rect)) return;
    const repair = { rect };
    pendingRectRepairs.set(record.appId, repair);
    queueMicrotask(() => {
      if (
        destroying
        || destroyed
        || pendingRectRepairs.get(record.appId) !== repair
      ) return;
      pendingRectRepairs.delete(record.appId);
      const current = recordFor(record.appId);
      const instance = windows.get(record.appId);
      if (
        !current
        || instance?.interaction
        || current.windowState !== "normal"
        || effectivelyMaximized(current)
      ) return;
      const normalized = normalRect(current);
      if (!sameWindowRect(current.rect, normalized)) actions.moveWindow(current.appId, normalized);
    });
  };

  const displayedRect = (record, maximized = effectivelyMaximized(record)) => {
    const viewport = viewportSnapshot();
    return displayedWindowRect(
      record,
      viewport,
      geometryOptions(viewport),
      mobileViewport.matches,
      maximized,
    );
  };

  const applyRect = (element, rect) => {
    element.style.transform = "none";
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${rect.w}px`;
    element.style.height = `${rect.h}px`;
  };

  const notifyVisibility = (visible, app) => {
    if (!app || typeof onVisibilityChange !== "function") return;
    try {
      onVisibilityChange(visible, app);
    } catch {
      console.error("ImageWeave 应用生命周期执行失败");
    }
  };

  const focusBody = (appId = selectors.focusedAppId(store.getState())) => {
    if (appId === null) return false;
    const instance = windows.get(appId);
    if (!instance || instance.element.hidden) return false;
    instance.bodyEl.focus({ preventScroll: true });
    return true;
  };

  const interactionController = createWindowInteractionController({
    actions,
    applyRect,
    displayedRect,
    effectivelyMaximized,
    getRecord: recordFor,
    getViewport: viewportSnapshot,
    getGeometryOptions: geometryOptions,
    isMobileViewport: () => mobileViewport.matches,
    isUnavailable: () => destroying || destroyed,
    isDestroying: () => destroying,
    normalRect,
  });
  const {
    finish: finishPointerInteraction,
    move: movePointerInteraction,
    resizeFromKeyboard,
    start: startPointerInteraction,
  } = interactionController;

  const hideController = createWindowHideController({
    getApplication: getApplicationById,
    getInstance: (appId) => windows.get(appId),
    getRecord: recordFor,
    isUnavailable: () => destroying || destroyed,
    onBeforeHide,
  });
  const requestHide = hideController.request;

  const bindInstanceEvents = (instance) => {
    const {
      element,
      titlebarEl,
      buttons: { minimize, maximize, close, resize },
    } = instance;

    const onWindowPointerDown = () => {
      if (!destroying && !destroyed) actions.focusWindow(instance.appId);
    };
    const onTitlebarPointerDown = (event) => {
      if (!(event.target instanceof Element) || event.target.closest("button")) return;
      startPointerInteraction(instance, event, "drag");
    };
    const onPointerMove = (event) => movePointerInteraction(instance, event);
    const onPointerEnd = (event) => finishPointerInteraction(instance, event);
    const onLostPointerCapture = (event) => finishPointerInteraction(instance, event);
    const onMinimize = () => requestHide(instance, "minimized", () => {
      actions.minimizeWindow(instance.appId);
      taskbarWindows?.focusButton(instance.appId);
    });
    const onMaximize = (event) => {
      const record = recordFor(instance.appId);
      if (!record || forcedMobileMaximized(record)) return;
      actions.toggleWindowMaximized(instance.appId);
      if (event.detail === 0) focusBody(instance.appId);
    };
    const onClose = () => requestHide(instance, "closed", (app) => {
      actions.closeWindow(instance.appId);
      if (app && typeof onCloseFocus === "function") onCloseFocus(app);
    });

    element.addEventListener("pointerdown", onWindowPointerDown, { capture: true });
    titlebarEl.addEventListener("pointerdown", onTitlebarPointerDown);
    titlebarEl.addEventListener("pointermove", onPointerMove);
    titlebarEl.addEventListener("pointerup", onPointerEnd);
    titlebarEl.addEventListener("pointercancel", onPointerEnd);
    titlebarEl.addEventListener("lostpointercapture", onLostPointerCapture);
    minimize.addEventListener("click", onMinimize);
    maximize.addEventListener("click", onMaximize);
    close.addEventListener("click", onClose);

    const cleanups = [
      () => element.removeEventListener("pointerdown", onWindowPointerDown, { capture: true }),
      () => titlebarEl.removeEventListener("pointerdown", onTitlebarPointerDown),
      () => titlebarEl.removeEventListener("pointermove", onPointerMove),
      () => titlebarEl.removeEventListener("pointerup", onPointerEnd),
      () => titlebarEl.removeEventListener("pointercancel", onPointerEnd),
      () => titlebarEl.removeEventListener("lostpointercapture", onLostPointerCapture),
      () => minimize.removeEventListener("click", onMinimize),
      () => maximize.removeEventListener("click", onMaximize),
      () => close.removeEventListener("click", onClose),
    ];

    for (const [direction, handle] of resize) {
      const onResizePointerDown = (event) => {
        startPointerInteraction(instance, event, "resize", direction);
      };
      const onResizeKeyDown = (event) => resizeFromKeyboard(instance, direction, event);
      handle.addEventListener("pointerdown", onResizePointerDown);
      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", onPointerEnd);
      handle.addEventListener("pointercancel", onPointerEnd);
      handle.addEventListener("lostpointercapture", onLostPointerCapture);
      handle.addEventListener("keydown", onResizeKeyDown);
      cleanups.push(
        () => handle.removeEventListener("pointerdown", onResizePointerDown),
        () => handle.removeEventListener("pointermove", onPointerMove),
        () => handle.removeEventListener("pointerup", onPointerEnd),
        () => handle.removeEventListener("pointercancel", onPointerEnd),
        () => handle.removeEventListener("lostpointercapture", onLostPointerCapture),
        () => handle.removeEventListener("keydown", onResizeKeyDown),
      );
    }
    instance.cleanupEvents = () => {
      for (const cleanup of cleanups) cleanup();
    };
  };

  const createInstance = (appId) => {
    const app = getApplicationById(appId);
    if (!app) throw new TypeError("窗口应用 ID 无效");
    const fragment = windowTemplate.content.cloneNode(true);
    const element = requireCloneElement(fragment, "[data-application-window]");
    const titlebarEl = requireCloneElement(element, "[data-window-titlebar]");
    const titleEl = requireCloneElement(element, "[data-window-title]");
    const bodyEl = requireCloneElement(element, "[data-window-body]");
    const minimize = requireCloneElement(element, "[data-window-minimize]", HTMLButtonElement);
    const maximize = requireCloneElement(element, "[data-window-maximize]", HTMLButtonElement);
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
    minimize.replaceChildren(createIcon("minus", { size: 17, strokeWidth: 2 }));
    close.replaceChildren(createIcon("close", { size: 17, strokeWidth: 2 }));

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
    windows.set(app.id, instance);
    return instance;
  };

  const removeInstance = (appId) => {
    const instance = windows.get(appId);
    if (!instance) return;
    hideController.invalidate(appId);
    finishPointerInteraction(instance, null, { commit: false });
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
    windows.delete(appId);
    pendingRectRepairs.delete(appId);
  };

  const syncInstance = (instance, record, view, index, focusedAppId) => {
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
    instance.element.style.zIndex = String(index);
    if (!instance.interaction) {
      const rect = displayedRect(record, view.maximized);
      applyRect(instance.element, rect);
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
    instance.buttons.maximize.title = forced
      ? "手机端所有窗口始终最大化"
      : view.maximized
        ? "还原"
        : "最大化";
    instance.buttons.maximize.replaceChildren(
      createIcon(view.maximized ? "restore" : "square", { size: 15, strokeWidth: 2 }),
    );
    for (const handle of instance.buttons.resize.values()) {
      handle.hidden = forced;
      handle.disabled = view.maximized;
      handle.tabIndex = forced ? -1 : 0;
    }

    // 移动端的展示抑制不等同于最小化；只有真实 minimized 才停用应用。
    if (instance.visible !== view.open) {
      instance.visible = view.open;
      notifyVisibility(view.open, app);
    }
  };

  const renderStack = (stack) => {
    if (destroying || destroyed) return;
    currentStack = stack;
    currentView = selectors.windowView(store.getState());
    const nextIds = new Set(stack.map((record) => record.appId));
    for (const appId of [...windows.keys()]) {
      if (!nextIds.has(appId)) removeInstance(appId);
    }
    for (const record of stack) {
      if (!windows.has(record.appId)) createInstance(record.appId);
    }
    const focusedAppId = selectors.focusedAppId(store.getState());
    const renderPlan = deriveWindowRenderPlan(stack, focusedAppId, mobileViewport.matches);
    for (const { record, view, zIndex } of renderPlan) {
      syncInstance(windows.get(record.appId), record, view, zIndex, focusedAppId);
    }
    taskbarWindows?.render(stack, focusedAppId);
  };

  const onTaskWindowActivate = (descriptor) => {
    activateTaskbarWindow(descriptor, {
      canActivate: (appId) => Boolean(recordFor(appId) && windows.has(appId)),
      minimize: (appId) => {
        const instance = windows.get(appId);
        if (!instance) return;
        requestHide(instance, "minimized", () => {
          actions.minimizeWindow(appId);
          taskbarWindows?.focusButton(appId);
        });
      },
      restore: (appId) => {
        actions.restoreWindow(appId);
        focusBody(appId);
      },
      focus: (appId) => {
        actions.focusWindow(appId);
        focusBody(appId);
      },
    });
  };

  const onViewportChange = () => {
    if (destroying || destroyed) return;
    for (const instance of windows.values()) {
      finishPointerInteraction(instance, null, { commit: false });
    }
    renderStack(selectors.windowStack(store.getState()));
  };

  let unsubscribe = () => {};
  try {
    taskbarWindows = createTaskbarWindowList({
      container: taskList,
      onActivate: onTaskWindowActivate,
    });
    mobileViewport.addEventListener("change", onViewportChange);
    window.addEventListener("resize", onViewportChange);
    renderStack(currentStack);
    unsubscribe = store.subscribe(selectors.windowStack, renderStack);
  } catch (error) {
    destroying = true;
    for (const appId of [...windows.keys()]) removeInstance(appId);
    taskbarWindows?.destroy();
    mobileViewport.removeEventListener("change", onViewportChange);
    window.removeEventListener("resize", onViewportChange);
    throw error;
  }

  return Object.freeze({
    getSnapshot() {
      return deriveWindowManagerSnapshot(
        currentView,
        recordFor(currentView.appId),
        mobileViewport.matches,
      );
    },
    getFocusedBody() {
      const appId = selectors.focusedAppId(store.getState());
      return appId === null ? null : windows.get(appId)?.bodyEl || null;
    },
    focusBody,
    destroy() {
      if (destroyed) return;
      destroying = true;
      for (const instance of windows.values()) finishPointerInteraction(instance);
      unsubscribe();
      mobileViewport.removeEventListener("change", onViewportChange);
      window.removeEventListener("resize", onViewportChange);
      for (const appId of [...windows.keys()]) removeInstance(appId);
      hideController.destroy();
      taskbarWindows?.destroy();
      pendingRectRepairs.clear();
      currentStack = [];
      destroying = false;
      destroyed = true;
    },
  });
}
