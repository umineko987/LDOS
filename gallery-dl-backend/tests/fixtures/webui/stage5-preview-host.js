import { TESTS_ONLY_STAGE5, stage5Fixture } from "./stage5-preview-fixtures.js";

const APP_DEFINITIONS = Object.freeze({
  gallery: Object.freeze({ id: "gallery", label: "图片库", windowTitle: "图片库" }),
  export: Object.freeze({ id: "export", label: "数据集导出", windowTitle: "数据集导出" }),
});

const GALLERY_MEDIA_PALETTES = Object.freeze({
  mist: Object.freeze(["#91a7b1", "#496878"]),
  ember: Object.freeze(["#b77a5d", "#65434a"]),
  forest: Object.freeze(["#78947d", "#365345"]),
  plum: Object.freeze(["#9a809d", "#55445d"]),
  ocean: Object.freeze(["#7195aa", "#294f69"]),
  sand: Object.freeze(["#c5b48b", "#7d7057"]),
});
const GALLERY_ERROR_MEDIA_TOKEN = "synthetic-gallery-04";
const WINDOW_MODES = new Set(["normal", "maximized"]);

const host = document.querySelector("[data-stage5-host]");
const label = document.querySelector("[data-stage5-fixture-label]");
let controller = null;
let galleryMedia = null;
let adapterState = null;
let appId = "";
let stateName = "";
let windowMode = "maximized";

function assertHarness() {
  if (!TESTS_ONLY_STAGE5 || !(host instanceof HTMLElement) || !(label instanceof HTMLElement)) {
    throw new Error("Stage 5 tests-only harness contract failed");
  }
}

function syntheticGallerySvg(mediaToken, mediaVariant) {
  const [start, end] = GALLERY_MEDIA_PALETTES[mediaVariant] || GALLERY_MEDIA_PALETTES.mist;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs>
  <rect width="640" height="480" fill="url(#g)"/>
  <circle cx="170" cy="150" r="96" fill="#fff" fill-opacity=".28"/>
  <path d="M246 390C318 190 430 180 566 338V480H214Z" fill="#141c24" fill-opacity=".24"/>
  <rect x="20" y="20" width="600" height="440" rx="28" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="2"/>
  <metadata>${mediaToken}</metadata>
</svg>`;
}

/* Production Gallery never reaches content and never creates media. This
   explicit tests-only decorator turns the existing allow-listed synthetic
   media tokens into Blob-backed images so Chromium can exercise load/error and
   teardown without adding a URL, filesystem path, API, or demo switch to the
   production module closure. */
function createGalleryMediaFixture(root) {
  const records = new Map();
  const counters = {
    imagesCreated: 0,
    imagesReleased: 0,
    objectUrlsCreated: 0,
    objectUrlsRevoked: 0,
    listenersAdded: 0,
    listenersRemoved: 0,
    loaded: 0,
    errors: 0,
    ignoredLateEvents: 0,
  };
  let active = true;
  let sweepQueued = false;

  const snapshot = () => Object.freeze({
    ...counters,
    activeImages: records.size,
    balancedImages: counters.imagesCreated === counters.imagesReleased + records.size,
    balancedObjectUrls: counters.objectUrlsCreated === counters.objectUrlsRevoked + records.size,
    balancedListeners: counters.listenersAdded === counters.listenersRemoved + (records.size * 2),
    states: Object.freeze([...records.values()].reduce((facts, record) => {
      facts[record.state] = (facts[record.state] || 0) + 1;
      return facts;
    }, {})),
  });

  const releaseRecord = (record) => {
    if (!record.active) return;
    record.active = false;
    record.image.removeEventListener("load", record.onLoad);
    record.image.removeEventListener("error", record.onError);
    counters.listenersRemoved += 2;
    record.image.removeAttribute("src");
    URL.revokeObjectURL(record.objectUrl);
    counters.objectUrlsRevoked += 1;
    counters.imagesReleased += 1;
    records.delete(record.preview);
    if (record.preview.isConnected) record.preview.removeAttribute("data-gallery-media-state");
  };

  const releaseDetached = () => {
    for (const record of [...records.values()]) {
      if (
        !record.preview.isConnected
        || !record.preview.hasAttribute("data-gallery-media-token")
        || record.image.parentElement !== record.preview
      ) releaseRecord(record);
    }
  };

  const hydrate = () => {
    if (!active) return;
    releaseDetached();
    for (const preview of root.querySelectorAll("[data-gallery-media-token]")) {
      if (!(preview instanceof HTMLElement) || records.has(preview)) continue;
      const mediaToken = preview.dataset.galleryMediaToken || "";
      const mediaVariant = preview.dataset.galleryMediaVariant || "mist";
      const image = new Image();
      const record = {
        active: true,
        image,
        mediaToken,
        objectUrl: "",
        onError: null,
        onLoad: null,
        preview,
        state: "loading",
      };
      record.onLoad = () => {
        if (!record.active) {
          counters.ignoredLateEvents += 1;
          return;
        }
        if (
          !preview.isConnected
          || preview.dataset.galleryMediaToken !== mediaToken
          || image.parentElement !== preview
        ) {
          counters.ignoredLateEvents += 1;
          return;
        }
        record.state = "loaded";
        counters.loaded += 1;
        preview.dataset.galleryMediaState = "loaded";
      };
      record.onError = () => {
        if (!record.active) {
          counters.ignoredLateEvents += 1;
          return;
        }
        if (
          !preview.isConnected
          || preview.dataset.galleryMediaToken !== mediaToken
          || image.parentElement !== preview
        ) {
          counters.ignoredLateEvents += 1;
          return;
        }
        record.state = "error";
        counters.errors += 1;
        preview.dataset.galleryMediaState = "error";
      };
      image.className = "gallery-media-image";
      image.alt = "";
      image.decoding = "async";
      image.draggable = false;
      image.addEventListener("load", record.onLoad);
      image.addEventListener("error", record.onError);
      counters.listenersAdded += 2;
      const blob = mediaToken === GALLERY_ERROR_MEDIA_TOKEN
        ? new Blob(["not-an-image"], { type: "application/octet-stream" })
        : new Blob([syntheticGallerySvg(mediaToken, mediaVariant)], { type: "image/svg+xml" });
      record.objectUrl = URL.createObjectURL(blob);
      counters.objectUrlsCreated += 1;
      counters.imagesCreated += 1;
      records.set(preview, record);
      preview.dataset.galleryMediaState = "loading";
      preview.replaceChildren(image);
      image.src = record.objectUrl;
    }
  };

  const queueSweep = () => {
    if (!active || sweepQueued) return;
    sweepQueued = true;
    queueMicrotask(() => {
      sweepQueued = false;
      hydrate();
    });
  };

  const observer = new MutationObserver(queueSweep);
  observer.observe(root, { childList: true, subtree: true });
  hydrate();

  return Object.freeze({
    snapshot,
    async settle() {
      for (let attempt = 0; attempt < 24; attempt += 1) {
        hydrate();
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        await Promise.resolve();
        releaseDetached();
        if ([...records.values()].every((record) => record.state !== "loading")) break;
      }
      return snapshot();
    },
    destroy() {
      if (!active) return snapshot();
      active = false;
      observer.disconnect();
      for (const record of [...records.values()]) releaseRecord(record);
      return snapshot();
    },
  });
}

async function createController(id, initialState) {
  if (id === "gallery") {
    const { createGalleryController } = await import("/__webui__/js/apps/gallery.js");
    return createGalleryController({ root: host, app: APP_DEFINITIONS.gallery }, {
      initialState,
      adapter: Object.freeze({ read: () => adapterState || initialState }),
    });
  }
  if (id === "export") {
    const { createExportController } = await import("/__webui__/js/apps/export.js");
    return createExportController({ root: host, app: APP_DEFINITIONS.export }, {
      initialState,
      adapter: Object.freeze({ read: () => adapterState || initialState }),
    });
  }
  throw new TypeError("未知 Stage 5 fixture app");
}

function setWindowMode(nextMode) {
  if (!WINDOW_MODES.has(nextMode)) throw new TypeError("未知 Stage 5 fixture 窗口模式");
  windowMode = nextMode;
  host.dataset.fixtureWindowMode = nextMode;
  host.toggleAttribute("data-maximized", nextMode === "maximized");
  return snapshot();
}

async function mount(id, nextStateName) {
  assertHarness();
  const state = stage5Fixture(id, nextStateName);
  controller?.destroy();
  galleryMedia?.destroy();
  galleryMedia = null;
  adapterState = state;
  controller = await createController(id, state);
  appId = id;
  stateName = nextStateName;
  if (id === "gallery") galleryMedia = createGalleryMediaFixture(host);
  controller.activate();
  await galleryMedia?.settle();
  label.textContent = `testsOnly=true · ${id} · ${nextStateName}`;
  document.documentElement.dataset.stage5Ready = "true";
  window.dispatchEvent(new CustomEvent("stage5-fixture-ready", { detail: { testsOnly: true, appId, stateName } }));
  return snapshot();
}

function setState(nextStateName) {
  if (!controller) throw new Error("Stage 5 fixture app 尚未挂载");
  const state = stage5Fixture(appId, nextStateName);
  adapterState = state;
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
    windowMode,
    media: galleryMedia?.snapshot() || null,
  });
}

setWindowMode(windowMode);

window.stage5FixtureHarness = Object.freeze({
  testsOnly: true,
  mount,
  setState,
  setWindowMode,
  snapshot,
  async settleMedia() { return galleryMedia?.settle() || null; },
  deactivate() { controller?.deactivate(); return snapshot(); },
  activate() { controller?.activate(); return snapshot(); },
  destroy() {
    controller?.destroy();
    controller = null;
    const media = galleryMedia?.destroy() || null;
    galleryMedia = null;
    adapterState = null;
    appId = "";
    stateName = "";
    host.replaceChildren();
    return Object.freeze({ testsOnly: true, media });
  },
});

const hash = location.hash.replace(/^#\/?/, "");
const [requestedApp = "gallery", requestedState = "loading"] = hash.split("/");
void mount(requestedApp, requestedState).catch(() => {
  document.documentElement.dataset.stage5Ready = "error";
  label.textContent = "testsOnly=true · fixture initialization failed";
});
