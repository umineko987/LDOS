import { getApplicationById } from "./app-registry.js";
import { applyWindowRect, createWindowDomLifecycle } from "./window-dom-lifecycle.js";
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
import {
  activateTaskbarWindow,
  createTaskbarWindowList,
} from "../components/taskbar-windows.js";

const MOBILE_QUERY = "(max-width: 767px)";

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
  const pendingRectRepairs = new Map();
  let windows = null;
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

  const focusBody = (appId = selectors.focusedAppId(store.getState())) => (
    appId === null ? false : windows.focusBody(appId)
  );

  const interactionController = createWindowInteractionController({
    actions,
    applyRect: applyWindowRect,
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

  windows = createWindowDomLifecycle({
    bindInstanceEvents,
    displayedRect,
    forcedMobileMaximized,
    onBeforeRemove(appId, instance) {
      hideController.invalidate(appId);
      finishPointerInteraction(instance, null, { commit: false });
    },
    onMount,
    onRemoved(appId) {
      pendingRectRepairs.delete(appId);
    },
    onUnmount,
    onVisibilityChange,
    queueNormalRectRepair,
    windowLayer,
    windowTemplate,
  });
  const createInstance = windows.create;
  const removeInstance = windows.remove;
  const syncInstance = windows.sync;

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
      return appId === null ? null : windows.bodyFor(appId);
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
