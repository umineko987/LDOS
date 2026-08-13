import { TESTS_ONLY_STAGE5, stage5Fixture } from "./stage5-preview-fixtures.js";

const APP_DEFINITIONS = Object.freeze({
  gallery: Object.freeze({ id: "gallery", label: "图片库", windowTitle: "图片库" }),
  schedule: Object.freeze({ id: "schedule", label: "定时任务", windowTitle: "定时任务" }),
  export: Object.freeze({ id: "export", label: "数据集导出", windowTitle: "数据集导出" }),
});

const host = document.querySelector("[data-stage5-host]");
const label = document.querySelector("[data-stage5-fixture-label]");
let controller = null;
let appId = "";
let stateName = "";

function assertHarness() {
  if (!TESTS_ONLY_STAGE5 || !(host instanceof HTMLElement) || !(label instanceof HTMLElement)) {
    throw new Error("Stage 5 tests-only harness contract failed");
  }
}

async function createController(id, initialState) {
  if (id === "gallery") {
    const { createGalleryController } = await import("/__webui__/js/apps/gallery.js");
    return createGalleryController({ root: host, app: APP_DEFINITIONS.gallery }, {
      initialState,
      adapter: Object.freeze({ read: () => initialState }),
    });
  }
  if (id === "schedule") {
    const { createScheduleController } = await import("/__webui__/js/apps/schedule.js");
    return createScheduleController({ root: host, app: APP_DEFINITIONS.schedule }, {
      initialState,
      adapter: Object.freeze({ read: () => initialState }),
    });
  }
  if (id === "export") {
    const { createExportController } = await import("/__webui__/js/apps/export.js");
    return createExportController({ root: host, app: APP_DEFINITIONS.export }, {
      initialState,
      adapter: Object.freeze({ read: () => initialState }),
    });
  }
  throw new TypeError("未知 Stage 5 fixture app");
}

async function mount(id, nextStateName) {
  assertHarness();
  const state = stage5Fixture(id, nextStateName);
  controller?.destroy();
  controller = await createController(id, state);
  appId = id;
  stateName = nextStateName;
  controller.activate();
  label.textContent = `testsOnly=true · ${id} · ${nextStateName}`;
  document.documentElement.dataset.stage5Ready = "true";
  window.dispatchEvent(new CustomEvent("stage5-fixture-ready", { detail: { testsOnly: true, appId, stateName } }));
  return snapshot();
}

function setState(nextStateName) {
  if (!controller) throw new Error("Stage 5 fixture app 尚未挂载");
  const state = stage5Fixture(appId, nextStateName);
  controller.setState(state);
  stateName = nextStateName;
  label.textContent = `testsOnly=true · ${appId} · ${stateName}`;
  return snapshot();
}

function snapshot() {
  return Object.freeze({
    testsOnly: true,
    appId,
    stateName,
    phase: controller?.getState?.().phase || "",
    uiState: controller?.getUiState?.() || null,
  });
}

window.stage5FixtureHarness = Object.freeze({
  testsOnly: true,
  mount,
  setState,
  snapshot,
  deactivate() { controller?.deactivate(); return snapshot(); },
  activate() { controller?.activate(); return snapshot(); },
  destroy() { controller?.destroy(); controller = null; appId = ""; stateName = ""; host.replaceChildren(); },
});

const hash = location.hash.replace(/^#\/?/, "");
const [requestedApp = "gallery", requestedState = "loading"] = hash.split("/");
void mount(requestedApp, requestedState).catch(() => {
  document.documentElement.dataset.stage5Ready = "error";
  label.textContent = "testsOnly=true · fixture initialization failed";
});
