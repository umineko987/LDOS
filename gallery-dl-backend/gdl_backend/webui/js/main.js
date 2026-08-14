import { createApiClient } from "./core/api.js";
import { initializeDesktop } from "./core/desktop.js";
import { createMotionController } from "./core/motion.js";
import { createPersonalizationRuntime } from "./core/personalization.js";
import { cleanupLegacyCustomWallpaper } from "./core/wallpaper-storage.js";
import { createPollingManager } from "./core/polling.js";
import { createStorePollingFocusSource } from "./core/polling-focus-source.js";
import { createStorageService } from "./core/storage.js";
import {
  measureWindowLayerViewport,
  windowLayerGeometryOptions,
} from "./core/window-workspace.js";
import { createInitialState, createStore } from "./core/store.js";
import { createDialogController } from "./components/dialog.js";
import { createStatusBadge } from "./components/status.js";
import { initializeTaskbarSummary } from "./components/taskbar-summary.js";

let desktopController = null;
let motionController = null;
let personalizationController = null;
let summaryController = null;
let refreshSummary = null;
let polling = null;
let dialogs = null;
let destroyed = false;

const destroy = () => {
  if (destroyed) return;
  destroyed = true;
  summaryController?.destroy();
  desktopController?.destroy();
  dialogs?.destroy();
  polling?.destroy();
  personalizationController?.destroy();
  motionController?.destroy();
  window.removeEventListener("pagehide", destroy);
};

// One compatibility-cycle migration. Its rejection is contained independently
// from shell startup, and the seam never becomes Personalization state.
void cleanupLegacyCustomWallpaper().catch(() => {});

try {
  const storage = createStorageService();
  try {
    motionController = createMotionController({
      root: document.documentElement,
      storage,
    });
  } catch {
    console.warn("动效偏好初始化失败；桌面将使用安全的静态回退");
  }
  const windowLayer = document.querySelector("[data-window-layer]");
  personalizationController = createPersonalizationRuntime({
    wallpaper: document.querySelector("[data-desktop-wallpaper]"),
    storage,
    motion: motionController,
  });
  const api = createApiClient();
  storage.readWindowPlacements(
    measureWindowLayerViewport(windowLayer, document),
    windowLayerGeometryOptions(),
  );
  const store = createStore({ initialState: createInitialState({ windows: [] }) });
  polling = createPollingManager({
    focusSource: createStorePollingFocusSource(store),
  });
  dialogs = createDialogController();
  desktopController = initializeDesktop(document, {
    api,
    store,
    polling,
    storage,
    dialogs,
    motion: motionController,
    personalization: personalizationController,
    refreshSummary: () => refreshSummary?.(),
  });
  summaryController = initializeTaskbarSummary(document, {
    api,
    store,
    actions: desktopController.actions,
    polling,
    onReady: (refresh) => { refreshSummary = refresh; },
  });
  window.addEventListener("pagehide", destroy);
} catch {
  destroy();
  console.error("ImageWeave 桌面壳层初始化失败");
  const notice = document.createElement("section");
  notice.className = "shell-error";
  notice.setAttribute("role", "alert");
  notice.append(
    createStatusBadge("error", "桌面初始化失败"),
    Object.assign(document.createElement("p"), {
      textContent: "请刷新页面；若问题持续存在，请检查静态资源是否完整。",
    }),
  );
  document.body.append(notice);
}
