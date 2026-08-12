import { applications, getApplicationById } from "./app-registry.js";
import { createShellActions } from "./actions.js";
import { createHashRouter } from "./router.js";
import { createElement, requireElement, setElementInert } from "./dom.js";
import { selectors } from "./store.js";
import { createWindowManager } from "./window-manager.js";
import { createApplicationCenter } from "../components/application-center.js";
import { createIcon } from "../components/icons.js";
import { createMenuBar } from "../components/menu-bar.js";

function startClock(clockElement) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let timerId;

  const tick = () => {
    const now = new Date();
    clockElement.textContent = formatter.format(now);
    clockElement.dateTime = now.toISOString();
    timerId = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 100);
  };
  tick();
  return () => window.clearTimeout(timerId);
}

function validateServices({ api, store, polling, storage, dialogs }) {
  if (!api || typeof api.get !== "function") throw new TypeError("桌面缺少 API 服务");
  if (!store || typeof store.dispatch !== "function") throw new TypeError("桌面缺少状态仓库");
  if (!polling || typeof polling.stopScope !== "function") throw new TypeError("桌面缺少轮询服务");
  if (
    !storage
    || typeof storage.writeCurrentApp !== "function"
    || typeof storage.writeWindowLayout !== "function"
  ) {
    throw new TypeError("桌面缺少安全存储服务");
  }
  if (!dialogs || typeof dialogs.open !== "function") throw new TypeError("桌面缺少对话框服务");
}

export function initializeDesktop(root = document, services = {}) {
  validateServices(services);
  const {
    api,
    store,
    polling,
    storage,
    dialogs,
    motion = null,
    personalization = null,
    refreshSummary = null,
  } = services;
  const desktop = requireElement("[data-desktop]", root);
  const menuBarElement = requireElement("[data-menu-bar]", desktop);
  const applicationCenterHost = requireElement("[data-application-center-host]", desktop);
  const windowLayer = requireElement("[data-window-layer]", desktop);
  const windowTemplate = requireElement("[data-window-template]", desktop);
  if (!(windowTemplate instanceof HTMLTemplateElement)) {
    throw new Error("窗口模板节点无效");
  }
  const taskList = requireElement("[data-task-window-list]", desktop);
  const clock = requireElement("[data-clock]", desktop);
  const clockIcon = requireElement("[data-clock-icon]", desktop);
  const skipLink = requireElement("[data-skip-link]", root);
  const announcer = requireElement("[data-route-announcer]", root);

  const mountedApplications = new Map();
  let currentApp = null;
  let router;
  let actions;
  let windowManager = null;
  let applicationCenter = null;
  let menuBar = null;
  let routeTransitionVersion = 0;
  let focusBodyAfterRouteAppId = null;

  const mountApplication = (app, windowBody) => {
    if (mountedApplications.has(app.id)) return mountedApplications.get(app.id);

    const appRoot = createElement("section", {
      className: "app-view",
      attributes: { hidden: "", inert: "" },
      dataset: { appId: app.id },
    });
    windowBody.append(appRoot);
    const context = Object.freeze({
      app,
      root: appRoot,
      api,
      store,
      actions,
      polling,
      pollingScope: `app:${app.id}`,
      storage,
      dialogs,
      motion,
      personalization,
      navigate: actions.navigateToApp,
    });
    try {
      app.mount(context);
    } catch (error) {
      appRoot.remove();
      throw error;
    }
    setElementInert(appRoot, true);
    const mounted = { context, active: false, windowBody };
    mountedApplications.set(app.id, mounted);
    return mounted;
  };

  const setLifecycleActive = (app, active) => {
    const mounted = mountedApplications.get(app.id);
    if (!mounted) throw new Error("应用窗口尚未挂载");
    if (mounted.active === active) return;
    if (active) {
      app.activate(mounted.context);
      mounted.active = true;
      return;
    }
    try {
      app.deactivate(mounted.context);
    } finally {
      mounted.active = false;
      polling.stopScope(mounted.context.pollingScope);
    }
  };

  const unmountApplication = (app) => {
    const mounted = mountedApplications.get(app.id);
    if (!mounted) return;
    try {
      if (mounted.active) setLifecycleActive(app, false);
      app.unmount(mounted.context);
    } finally {
      polling.stopScope(mounted.context.pollingScope);
      mounted.context.root.remove();
      mountedApplications.delete(app.id);
    }
  };


  const activateRoute = (app, navigation = {}) => {
    const transition = ++routeTransitionVersion;
    void (async () => {
      const previous = currentApp;
      const previousMounted = previous ? mountedApplications.get(previous.id) : null;
      if (
        navigation.skipBeforeLeave !== true
        && previous
        && previousMounted
        && previous.id !== app?.id
        && typeof previous.beforeLeave === "function"
      ) {
        let allowed = false;
        try {
          allowed = await previous.beforeLeave(previousMounted.context, app);
        } catch {
          allowed = false;
        }
        if (transition !== routeTransitionVersion) return;
        if (!allowed) {
          focusBodyAfterRouteAppId = null;
          announcer.textContent = `无法离开${previous.label}；请先处理未保存内容。`;
          router.restore(previous.id);
          windowManager?.focusBody(previous.id);
          return;
        }
      }
      if (transition !== routeTransitionVersion) return;
      if (!app) {
        const previousRecord = previous
          ? selectors.windowStack(store.getState()).find((record) => record.appId === previous.id)
          : null;
        if (previousRecord && previousRecord.windowState !== "minimized") {
          actions.minimizeWindow(previous.id, { syncRoute: false });
        }
        currentApp = null;
        actions.desktopResolved();
        document.title = "ImageWeave";
        announcer.textContent = navigation.malformed
          ? "无法识别该地址，已返回 ImageWeave 桌面。"
          : "已返回 ImageWeave 桌面。";
        return;
      }
      currentApp = app;
      actions.routeResolved(app);
      if (focusBodyAfterRouteAppId === app.id) {
        focusBodyAfterRouteAppId = null;
        windowManager?.focusBody(app.id);
      }
      document.title = `ImageWeave — ${app.label}`;
      announcer.textContent = `已打开${app.label}，${app.windowTitle}`;
    })().catch(() => {
      focusBodyAfterRouteAppId = null;
      announcer.textContent = "应用切换失败；当前窗口保持不变。";
      router.restore(currentApp?.id ?? null);
    });
  };

  router = createHashRouter(activateRoute);
  actions = createShellActions({
    store,
    router,
    storage,
    getRegisteredApplicationById: getApplicationById,
  });

  applicationCenter = createApplicationCenter({
    host: applicationCenterHost,
    definitions: applications,
    onLaunch(appId) {
      focusBodyAfterRouteAppId = appId;
      actions.navigateToApp(appId);
    },
  });
  windowManager = createWindowManager({
    windowLayer,
    windowTemplate,
    taskList,
    store,
    actions,
    onMount(app, bodyElement) {
      mountApplication(app, bodyElement);
    },
    onUnmount(app) {
      unmountApplication(app);
    },
    onVisibilityChange(visible, app) {
      setLifecycleActive(app, visible);
    },
    onOpenApplicationCenter: (trigger) => applicationCenter.open(trigger),
    onBeforeHide(app, visibility) {
      if (typeof app?.beforeWindowHide !== "function") return true;
      const mounted = mountedApplications.get(app.id);
      return mounted
        ? app.beforeWindowHide(mounted.context, visibility)
        : true;
    },
  });

  menuBar = createMenuBar({
    root: menuBarElement,
    store,
    selectors,
    actions,
    onWindowCommand: (command, appId) => windowManager.activate(command, appId),
    onOpenApplicationCenter: (trigger) => applicationCenter.open(trigger),
    onRefreshSummary: () => refreshSummary?.(),
  });
  const onSkip = () => {
    if (windowManager.focusBody()) return;
    const snapshot = windowManager.getSnapshot();
    if (snapshot.appId) windowManager.focusBody(snapshot.appId);
  };

  skipLink.addEventListener("click", onSkip);
  clockIcon.replaceChildren(createIcon("clock", { size: 16, strokeWidth: 2 }));
  const stopClock = startClock(clock);

  router.start();
  document.documentElement.dataset.webuiReady = "true";

  return Object.freeze({
    actions,
    router,
    windowManager,
    destroy() {
      routeTransitionVersion += 1;
      focusBodyAfterRouteAppId = null;
      router.stop();
      stopClock();
      windowManager.destroy();
      menuBar?.destroy();
      applicationCenter?.destroy();
      skipLink.removeEventListener("click", onSkip);
      for (const appId of [...mountedApplications.keys()]) {
        const app = applications.find((candidate) => candidate.id === appId);
        if (app) unmountApplication(app);
      }
      actions.destroy();
      mountedApplications.clear();
      delete document.documentElement.dataset.webuiReady;
    },
  });
}
