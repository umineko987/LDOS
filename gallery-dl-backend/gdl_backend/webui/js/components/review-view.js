import { createElement } from "../core/dom.js";
import {
  calculateReviewLayout,
  calculateSynchronizedCrop,
  clamp,
  DEFAULT_MAGNIFICATION,
  formatMagnification,
  getContainContentRect,
  normalizePointerCoordinates,
  selectReferenceImage,
  updateMagnification,
} from "../core/review-loupe.js";
import {
  reviewApplyCounts,
  reviewCanList,
  reviewCompletionPresentation,
  reviewImageUrl,
  REVIEW_FILTERS,
} from "../core/review-model.js";
import { formatBatchTime, shortBatchId, TERMINAL_BATCH_STATUSES } from "../core/tasks-model.js";
import { selectors } from "../core/store.js";
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const KIND_LABELS = Object.freeze({
  duplicate: "重复组",
  single: "独立图片",
  unreadable: "读取失败",
});

const KIND_STATUS = Object.freeze({
  duplicate: "warning",
  single: "ready",
  unreadable: "error",
});

const LOUPE_HIDE_DELAY_MS = 220;
const LAYOUT_GAP_PX = 12;
const DESKTOP_MIN_SHORT_EDGE_PX = 160;
const MAX_CANVAS_DPR = 2;
const CANVAS_ERROR_TEXT = "读取受限";

function button(action, label, {
  primary = false,
  dangerous = false,
  small = false,
  title = "",
  keyShortcuts = "",
} = {}) {
  return createElement("button", {
    className: [
      "review-button",
      primary ? "review-button--primary" : "",
      dangerous ? "review-button--dangerous" : "",
      small ? "review-button--small" : "",
    ].filter(Boolean).join(" "),
    text: label,
    attributes: {
      type: "button",
      title: title || null,
      "aria-keyshortcuts": keyShortcuts || null,
    },
    dataset: { reviewAction: action },
  });
}

function buildDom(context) {
  const { root, app } = context;
  const headingId = "review-heading";
  const batchSelect = createElement("select", {
    attributes: { "aria-label": "已结束批次" },
    dataset: { reviewBatchSelect: "" },
  }, [createElement("option", { text: "暂无已结束批次", attributes: { value: "" } })]);
  const loadButton = button("load-batch", "打开审核", { primary: true });
  const refreshButton = button("refresh", "刷新");
  const tasksButton = button("open-tasks", "打开批次管理");
  const batchControls = createElement("div", { className: "review-picker-row review-batch-controls" }, [
    batchSelect,
    loadButton,
    refreshButton,
    tasksButton,
  ]);
  const errorHost = createElement("div", { className: "review-error-host", dataset: { reviewError: "" } });
  const operationLive = createElement("p", {
    className: "review-operation-live",
    text: "选择一个已结束批次。",
    attributes: { "aria-live": "polite", role: "status" },
    dataset: { reviewLive: "", reviewDirty: "false" },
  });

  const appHeader = createElement("header", { className: "app-header review-app-header" }, [
    createElement("p", { className: "app-executable", text: app.windowTitle }),
    createElement("h1", { text: app.label, attributes: { id: headingId } }),
    createElement("p", {
      className: "app-summary",
      text: "启动分析后，可在当前筛选中连续确认保留项；应用结果前会再次确认。",
    }),
  ]);
  const pickerRowHost = createElement("div", { dataset: { reviewPickerControls: "" } }, [batchControls]);
  const nonDeckLiveHost = createElement("div", {
    className: "review-panel-live",
    dataset: { reviewPanelLive: "" },
  }, [operationLive]);
  const picker = createElement("section", {
    className: "review-panel review-picker",
    attributes: { "aria-labelledby": "review-picker-title" },
  }, [
    createElement("div", { className: "review-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "已结束批次", attributes: { id: "review-picker-title" } }),
        createElement("p", { text: "仅已结束的采集批次可以开始去重分析。" }),
      ]),
      createStatusBadge("running", "分析状态自动刷新"),
    ]),
    pickerRowHost,
    nonDeckLiveHost,
  ]);

  const statusBadge = createStatusBadge("disabled", "尚未载入审核");
  const actionHost = createElement("div", {
    className: "review-status-actions",
    dataset: { reviewStatusActions: "" },
  });
  const stateHost = createElement("div", { className: "review-state-host", dataset: { reviewStateHost: "" } });
  const workspace = createElement("section", {
    className: "review-panel review-workspace",
    attributes: { hidden: "", "aria-labelledby": "review-workspace-title" },
    dataset: { reviewWorkspace: "" },
  }, [
    createElement("div", { className: "review-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "去重审核", attributes: { id: "review-workspace-title" } }),
        createElement("p", { text: "分析、应用与错误恢复继续沿用现有审核流程。" }),
      ]),
      statusBadge,
    ]),
    actionHost,
    stateHost,
  ]);
  const emptyHost = createElement("div", { dataset: { reviewEmpty: "" } });

  const deckStatusBadge = createStatusBadge("disabled", "尚未载入审核");
  const deckBatchId = createElement("strong", { text: "批次 —", dataset: { reviewDeckBatch: "" } });
  const progressText = createElement("strong", { text: "已决 0/0 组", dataset: { reviewProgressText: "" } });
  const progressFill = createElement("span", { className: "review-deck-progress-fill", dataset: { reviewProgressFill: "" } });
  const progressTrack = createElement("span", {
    className: "review-deck-progress-track",
    attributes: {
      role: "progressbar",
      "aria-label": "审核总进度",
      "aria-valuemin": "0",
      "aria-valuemax": "0",
      "aria-valuenow": "0",
    },
  }, [progressFill]);
  const tabs = createElement("div", {
    className: "review-tabs review-deck-tabs",
    attributes: { role: "tablist", "aria-label": "审核分组筛选" },
    dataset: { reviewTabs: "" },
  });
  for (const filter of REVIEW_FILTERS) {
    tabs.append(createElement("button", {
      className: "review-tab",
      text: filter.label,
      attributes: { type: "button", role: "tab", "aria-selected": "false" },
      dataset: { reviewAction: "filter", reviewFilter: filter.id },
    }));
  }

  const groupSelect = createElement("select", {
    attributes: { "aria-label": "选择当前筛选中的审核组" },
    dataset: { reviewGroupSelect: "" },
  }, [createElement("option", { text: "当前筛选没有审核组", attributes: { value: "" } })]);
  const groupPicker = createElement("div", {
    className: "review-group-picker",
    attributes: { "aria-label": "当前筛选全量组选择器" },
    dataset: { reviewGroupPicker: "" },
  }, [groupSelect]);

  const zoomReadout = createElement("output", {
    className: "review-loupe-zoom",
    text: formatMagnification(DEFAULT_MAGNIFICATION),
    attributes: { "aria-live": "polite", "aria-label": "镜片倍率" },
    dataset: { reviewLoupeZoom: "" },
  });
  const loupeToggleButton = button("loupe-toggle", "启动放大镜", {
    title: "快捷键 X：开启或关闭同步放大镜",
  });
  loupeToggleButton.setAttribute("aria-keyshortcuts", "x");
  loupeToggleButton.setAttribute("aria-pressed", "false");
  loupeToggleButton.setAttribute("aria-disabled", "true");
  const loupePinButton = button("loupe-pin", "锁定坐标");
  loupePinButton.setAttribute("aria-pressed", "false");
  loupePinButton.setAttribute("aria-disabled", "true");
  const loupeControls = createElement("div", {
    className: "review-loupe-controls",
    attributes: { "aria-label": "同步放大镜" },
  }, [
    zoomReadout,
    loupeToggleButton,
    loupePinButton,
  ]);

  const deckBatchControlsHost = createElement("div", {
    className: "review-deck-batch-controls",
    dataset: { reviewDeckBatchControls: "" },
  });
  const deckActionHost = createElement("div", {
    className: "review-deck-actions",
    dataset: { reviewDeckActions: "" },
  });
  const deckHeader = createElement("header", { className: "review-deck-header" }, [
    createElement("div", { className: "review-deck-identity" }, [deckBatchId, deckStatusBadge]),
    createElement("div", { className: "review-deck-progress" }, [progressText, progressTrack]),
    tabs,
    groupPicker,
    loupeControls,
    createElement("div", { className: "review-deck-utilities" }, [deckBatchControlsHost, deckActionHost]),
  ]);

  const stage = createElement("section", {
    className: "review-deck-stage",
    attributes: { tabindex: "-1", role: "group", "aria-label": "当前审核组" },
    dataset: { reviewStage: "" },
  });
  const deckBody = createElement("div", {
    className: "review-deck-body",
    dataset: { reviewDeckBody: "" },
  }, [stage]);

  const commandHost = createElement("div", {
    className: "review-deck-command-list",
    attributes: { "aria-label": "组导航" },
    dataset: { reviewCommands: "" },
  }, [
    button("prev-group", "上一组", {
      small: true,
      title: "快捷键 Backspace：返回上一组",
      keyShortcuts: "Backspace",
    }),
    button("next-group", "下一组", { small: true }),
    createElement("div", {
      className: "review-shortcut-hints",
      attributes: { "aria-label": "审核快捷键" },
    }, [
      createElement("span", { text: "方向键  移动选中" }),
      createElement("span", { text: "Space  切换保留" }),
      createElement("span", {
        text: "Enter  采纳并前进",
        dataset: { reviewEnterHint: "" },
      }),
    ]),
  ]);
  const deckLiveHost = createElement("div", {
    className: "review-deck-live-host",
    dataset: { reviewDeckLive: "" },
  }, [operationLive]);
  const statusBar = createElement("footer", { className: "review-deck-statusbar" }, [commandHost, deckLiveHost]);
  const deck = createElement("section", {
    className: "review-deck",
    attributes: { hidden: "", "aria-label": "专注分拣台" },
    dataset: { reviewDeck: "", loupeEnabled: "false", loupeActive: "false" },
  }, [deckHeader, deckBody, statusBar]);

  root.classList.add("app-view", "review-app");
  root.dataset.mode = "panel";
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(appHeader, errorHost, picker, emptyHost, workspace, deck);

  return {
    appHeader,
    batchSelect,
    loadButton,
    refreshButton,
    tasksButton,
    batchControls,
    pickerRowHost,
    picker,
    errorHost,
    operationLive,
    statusBadge,
    actionHost,
    stateHost,
    nonDeckLiveHost,
    workspace,
    emptyHost,
    deck,
    deckHeader,
    deckStatusBadge,
    deckBatchId,
    progressText,
    progressTrack,
    progressFill,
    tabs,
    groupPicker,
    groupSelect,
    loupeControls,
    zoomReadout,
    loupeToggleButton,
    loupePinButton,
    deckBatchControlsHost,
    deckActionHost,
    deckBody,
    stage,
    commandHost,
    deckLiveHost,
    statusBar,
  };
}

function currentGroup(review, focusedIndex) {
  return review.groups[focusedIndex] || null;
}

function findByDataset(container, selector, key, value) {
  return [...container.querySelectorAll(selector)].find((element) => element.dataset[key] === value) || null;
}

function nonDeckState(summary) {
  const presentations = {
    not_started: ["等待开始", "尚未开始去重分析", "开始后会先分析相似图片，再进入人工审核。"],
    waiting_for_crawl: ["等待采集结束", "批次尚未准备好", "采集结束后即可开始去重分析。"],
    pending: ["分析已排队", "正在等待分析资源", "状态会自动刷新，无需重复提交。"],
    analyzing: ["正在分析", "正在计算近似图片分组", "分析完成后会自动进入专注分拣台。"],
    auto_applying: ["自动处理中", "正在应用无需人工确认的结果", "完成后会继续刷新审核状态。"],
    failed: ["分析失败", "去重分析未能完成", "可重试分析；若持续失败，请打开系统诊断。"],
    disabled: ["审核未启用", "当前服务未启用去重审核", "请先在服务配置中启用相应能力。"],
  };
  return presentations[summary.status] || [summary.statusLabel, "审核状态已更新", "请刷新或稍后重试。"];
}

function requestFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, 16);
}

function cancelFrame(handle) {
  if (!handle) return;
  if (typeof globalThis.cancelAnimationFrame === "function") globalThis.cancelAnimationFrame(handle);
  else globalThis.clearTimeout(handle);
}

export function createReviewView(context) {
  const { root, store, actions } = context;
  const elements = buildDom(context);
  let busy = "";
  let renderedError = null;
  let focusedIndex = 0;
  let activeImageId = "";
  let confirmedIds = new Set();
  let completionVisible = false;
  let renderedWorkspaceKey = "";
  let adjacentPreviews = [];
  let imagesReleased = false;
  let resizeObserver = null;
  let layoutFrame = 0;
  let interactionsActive = false;
  let stageGeneration = 0;
  let loupeAvailable = false;
  const loupe = {
    enabled: false,
    active: false,
    pinned: false,
    sourceImageId: "",
    u: 0.5,
    v: 0.5,
    magnification: DEFAULT_MAGNIFICATION,
    drawFrame: 0,
    hideTimer: 0,
  };

  const reviewState = () => store.getState().review;
  const workspaceKey = (review) => `${review.batchId}\u0000${review.filter}`;
  const editable = (review = reviewState()) => review.summary?.status === "ready" && !busy && Boolean(
    currentGroup(review, focusedIndex)?.images.length,
  );
  const loupeEffective = () => loupe.enabled && loupeAvailable;

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (guidance) => {
    clearError();
    renderedError = createErrorView({
      code: guidance.code,
      message: guidance.message,
      requestId: guidance.requestId,
    }, {
      statusLabel: guidance.title,
      nextStep: guidance.nextStep,
      onAction: () => actions.navigateToApp("diagnostics"),
    });
    elements.errorHost.replaceChildren(renderedError.element);
  };

  const cancelHide = () => {
    if (loupe.hideTimer) globalThis.clearTimeout(loupe.hideTimer);
    loupe.hideTimer = 0;
  };

  const cancelDraw = () => {
    cancelFrame(loupe.drawFrame);
    loupe.drawFrame = 0;
  };

  const cancelLayout = () => {
    cancelFrame(layoutFrame);
    layoutFrame = 0;
  };

  const disconnectLayoutObserver = () => {
    resizeObserver?.disconnect();
    resizeObserver = null;
    cancelLayout();
  };

  const updateSourceMarkers = () => {
    for (const card of elements.stage.querySelectorAll("[data-review-image]")) {
      card.dataset.loupeSource = String(Boolean(
        loupe.active && loupe.sourceImageId && card.dataset.reviewImage === loupe.sourceImageId
      ));
    }
  };

  const updateLoupeUi = () => {
    const effective = loupeEffective();
    const active = effective && loupe.active;
    const label = formatMagnification(loupe.magnification);
    elements.deck.dataset.loupeEnabled = String(effective);
    elements.deck.dataset.loupeActive = String(active);
    elements.zoomReadout.textContent = label;
    elements.loupeToggleButton.setAttribute("aria-pressed", String(loupe.enabled));
    elements.loupeToggleButton.textContent = loupeAvailable
      ? loupe.enabled ? "关闭放大镜" : "启动放大镜"
      : "放大镜不可用";
    elements.loupePinButton.setAttribute("aria-pressed", String(loupe.pinned));
    elements.loupePinButton.textContent = loupe.pinned ? "解除锁定" : "锁定坐标";
    elements.loupeToggleButton.disabled = !loupeAvailable || Boolean(busy);
    elements.loupePinButton.disabled = !loupeAvailable || !loupe.enabled || Boolean(busy);
    elements.loupeToggleButton.setAttribute("aria-disabled", String(elements.loupeToggleButton.disabled));
    elements.loupePinButton.setAttribute("aria-disabled", String(elements.loupePinButton.disabled));
    updateSourceMarkers();
  };

  const resetLoupePosition = ({ preserveEnabled = true } = {}) => {
    cancelHide();
    cancelDraw();
    loupe.active = false;
    loupe.pinned = false;
    loupe.sourceImageId = "";
    loupe.u = 0.5;
    loupe.v = 0.5;
    if (!preserveEnabled) loupe.enabled = false;
    hideLoupeArtifacts();
    updateLoupeUi();
  };

  const releasePreloads = () => {
    for (const image of adjacentPreviews) image.removeAttribute("src");
    adjacentPreviews = [];
  };

  const clearCanvasDiagnostics = (canvas) => {
    for (const key of [
      "sourceLeft", "sourceTop", "sourceWidth", "sourceHeight",
      "edgeClamped", "sampleU", "sampleV",
    ]) {
      delete canvas.dataset[key];
    }
  };

  const hideLoupeArtifacts = () => {
    for (const crosshair of elements.stage.querySelectorAll("[data-review-crosshair]")) {
      crosshair.dataset.visible = "false";
    }
    for (const canvas of elements.stage.querySelectorAll("[data-review-lens]")) {
      canvas.dataset.visible = "false";
      clearCanvasDiagnostics(canvas);
      canvas.width = 1;
      canvas.height = 1;
    }
    for (const errorLabel of elements.stage.querySelectorAll("[data-review-loupe-error]")) {
      errorLabel.hidden = true;
    }
  };

  const releaseStageImages = () => {
    stageGeneration += 1;
    for (const image of elements.stage.querySelectorAll("img")) {
      image.dataset.reviewDecoded = "false";
      image.removeAttribute("src");
    }
    for (const canvas of elements.stage.querySelectorAll("canvas")) {
      clearCanvasDiagnostics(canvas);
      canvas.width = 1;
      canvas.height = 1;
    }
  };

  const releaseImages = () => {
    resetLoupePosition({ preserveEnabled: true });
    disconnectLayoutObserver();
    releaseStageImages();
    releasePreloads();
    imagesReleased = true;
  };

  const scheduleDraw = () => {
    if (loupe.drawFrame || !loupeEffective() || !loupe.active) return;
    loupe.drawFrame = requestFrame(() => drawLoupeNow());
  };

  const markPreviewDecoded = async (preview, generation) => {
    try {
      if (typeof preview.decode === "function") await preview.decode();
      if (generation !== stageGeneration || !preview.isConnected || !preview.naturalWidth || !preview.naturalHeight) return;
      preview.dataset.reviewDecoded = "true";
      scheduleDraw();
    } catch {
      if (generation === stageGeneration && preview.isConnected) preview.dataset.reviewDecoded = "false";
    }
  };

  const loadImageWindow = (review) => {
    if (!interactionsActive) {
      imagesReleased = true;
      return;
    }
    releasePreloads();
    const group = currentGroup(review, focusedIndex);
    if (!group) {
      imagesReleased = false;
      return;
    }
    const generation = stageGeneration;
    for (const preview of elements.stage.querySelectorAll("[data-review-preview-image]")) {
      if (preview.dataset.previewFailed === "true" || preview.hasAttribute("src")) continue;
      const imageId = preview.dataset.reviewPreviewImage;
      if (!group.images.some((image) => image.id === imageId && image.readable)) continue;
      preview.dataset.reviewDecoded = "false";
      preview.setAttribute("src", reviewImageUrl(review.batchId, imageId));
      if (preview.complete && preview.naturalWidth) void markPreviewDecoded(preview, generation);
    }
    const neighborIndex = focusedIndex + 1 < review.groups.length
      ? focusedIndex + 1
      : focusedIndex > 0
        ? focusedIndex - 1
        : -1;
    if (neighborIndex >= 0) {
      for (const image of review.groups[neighborIndex].images) {
        if (!image.readable) continue;
        const preview = createElement("img", {
          attributes: { alt: "", "aria-hidden": "true", decoding: "async", loading: "eager" },
        });
        preview.setAttribute("src", reviewImageUrl(review.batchId, image.id));
        adjacentPreviews.push(preview);
      }
    }
    imagesReleased = false;
  };

  const placeSharedElements = (deckMode, hasReview = false) => {
    if (deckMode) {
      elements.deckBatchControlsHost.append(elements.batchControls);
      elements.deckActionHost.append(elements.actionHost);
      elements.deckLiveHost.prepend(elements.operationLive);
    } else {
      elements.pickerRowHost.append(elements.batchControls);
      elements.workspace.insertBefore(elements.actionHost, elements.stateHost);
      elements[hasReview ? "workspace" : "picker"].append(elements.nonDeckLiveHost);
      elements.nonDeckLiveHost.append(elements.operationLive);
    }
  };

  const renderBatches = (recent) => {
    const selected = reviewState().batchId || store.getState().batches.activeId || elements.batchSelect.value;
    const terminal = recent.filter((batch) => TERMINAL_BATCH_STATUSES.has(batch.status));
    const options = [createElement("option", {
      text: terminal.length ? "选择已结束批次" : "暂无已结束批次",
      attributes: { value: "" },
    })];
    for (const batch of terminal) {
      const option = createElement("option", {
        text: `${batch.statusLabel} · ${shortBatchId(batch.id)} · ${formatBatchTime(batch.createdAt)}`,
        attributes: { value: batch.id },
      });
      option.selected = batch.id === selected;
      options.push(option);
    }
    elements.batchSelect.replaceChildren(...options);
    elements.batchSelect.disabled = Boolean(busy);
  };

  const renderActions = (review) => {
    const status = review.summary.status;
    const controls = [];
    if (["not_started", "waiting_for_crawl"].includes(status)) {
      controls.push(button("start", "开始去重分析", { primary: true }));
    }
    if (status === "failed") controls.push(button("retry", "重试分析", { primary: true }));
    if (review.dirty && status !== "ready") {
      controls.push(button("discard-reload", "放弃更改并重新加载", { dangerous: true }));
    }
    if (["ready", "apply_failed"].includes(status)) {
      controls.push(button("apply", status === "apply_failed" ? "重试整理文件" : "应用并整理文件", {
        dangerous: true,
      }));
    }
    elements.actionHost.replaceChildren(...controls);
  };

  const renderNonDeckState = (review) => {
    const [label, title, message] = nonDeckState(review.summary);
    elements.stateHost.replaceChildren(createEmptyState({ label, title, message }));
  };

  const groupOptionText = (group, index, count) => {
    const state = group.kind === "unreadable"
      ? "读取失败"
      : group.decided || confirmedIds.has(group.id)
        ? "已确认"
        : "待提交";
    return `${index + 1}/${count} · 组 ${group.ordinal} · ${KIND_LABELS[group.kind]} · ${state}`;
  };

  const renderGroupSelector = (review) => {
    if (!review.groups.length) {
      elements.groupSelect.replaceChildren(createElement("option", {
        text: "当前筛选没有审核组",
        attributes: { value: "" },
      }));
      return;
    }
    const options = review.groups.map((group, index) => {
      const option = createElement("option", {
        text: groupOptionText(group, index, review.groups.length),
        attributes: { value: String(index) },
      });
      option.selected = index === focusedIndex;
      return option;
    });
    elements.groupSelect.replaceChildren(...options);
    elements.groupSelect.value = String(focusedIndex);
  };

  const renderDeckHeader = (review) => {
    const summary = review.summary;
    elements.deckBatchId.textContent = `批次 ${shortBatchId(review.batchId)}`;
    updateStatusBadge(elements.deckStatusBadge, summary.statusKind, summary.statusLabel);
    const total = summary.totalGroupCount;
    const decided = Math.min(summary.decidedGroupCount, total);
    const percentage = total ? (decided / total) * 100 : 0;
    elements.progressText.textContent = `已决 ${decided}/${total} 组`;
    elements.progressTrack.setAttribute("aria-valuemax", String(total));
    elements.progressTrack.setAttribute("aria-valuenow", String(decided));
    elements.progressTrack.setAttribute("aria-valuetext", `已确认 ${decided}，共 ${total} 组`);
    elements.progressFill.style.width = `${percentage.toFixed(2)}%`;
    for (const tab of elements.tabs.querySelectorAll("[data-review-filter]")) {
      const selected = tab.dataset.reviewFilter === review.filter;
      tab.setAttribute("aria-selected", String(selected));
      tab.classList.toggle("review-tab--active", selected);
    }
    renderGroupSelector(review);
  };

  const buildImageCard = (review, group, image, index, generation) => {
    const fallback = createElement("span", {
      className: "review-image-fallback",
      text: image.readable ? "预览加载失败" : "图片不可读",
      attributes: image.readable ? { hidden: "" } : {},
      dataset: { reviewImageFallback: image.id },
    });
    const mediaChildren = [];
    if (image.readable) {
      const preview = createElement("img", {
        attributes: {
          alt: `组 ${group.ordinal} 图片 ${index + 1}`,
          loading: "eager",
          decoding: "async",
          draggable: "false",
        },
        dataset: { reviewPreviewImage: image.id, reviewDecoded: "false" },
      });
      preview.addEventListener("load", () => {
        void markPreviewDecoded(preview, generation);
      });
      preview.addEventListener("error", () => {
        if (generation !== stageGeneration || !preview.isConnected) return;
        preview.dataset.previewFailed = "true";
        preview.dataset.reviewDecoded = "false";
        preview.hidden = true;
        preview.removeAttribute("src");
        fallback.hidden = false;
        const failedMedia = preview.closest("[data-review-media]");
        const failedCanvas = failedMedia?.querySelector("[data-review-lens]");
        if (failedCanvas instanceof HTMLCanvasElement) {
          clearCanvasDiagnostics(failedCanvas);
          failedCanvas.width = 1;
          failedCanvas.height = 1;
        }
        failedMedia?.querySelector("[data-review-crosshair]")?.remove();
        failedCanvas?.remove();
        failedMedia?.querySelector("[data-review-loupe-error]")?.remove();
        loupeAvailable = group.images.some((candidate) => {
          if (!candidate.readable) return false;
          const candidatePreview = findByDataset(
            elements.stage,
            "[data-review-preview-image]",
            "reviewPreviewImage",
            candidate.id,
          );
          return Boolean(candidatePreview && candidatePreview.dataset.previewFailed !== "true");
        });
        if (!loupeAvailable) resetLoupePosition({ preserveEnabled: true });
        syncControlAvailability(reviewState());
        scheduleDraw();
      }, { once: true });
      mediaChildren.push(preview);
    }
    mediaChildren.push(
      fallback,
      createElement("span", {
        className: "review-image-index",
        text: String(index + 1),
        attributes: { "aria-hidden": "true" },
      }),
      createElement("span", {
        className: "review-image-active-marker",
        text: "当前选中",
        attributes: { "aria-hidden": "true" },
      }),
    );
    if (image.recommended) {
      mediaChildren.push(createElement("span", { className: "review-recommended", text: "★ 推荐" }));
    }
    mediaChildren.push(createElement("span", {
      className: "review-image-stamp",
      text: image.selected ? "✓ 保留" : "✗ 移除",
      dataset: { reviewStamp: image.id, state: image.selected ? "keep" : "drop" },
    }));
    if (image.readable) {
      mediaChildren.push(
        createElement("span", {
          className: "review-loupe-crosshair",
          attributes: { "aria-hidden": "true" },
          dataset: { reviewCrosshair: image.id, visible: "false" },
        }),
        createElement("canvas", {
          className: "review-loupe-lens",
          attributes: { "aria-hidden": "true" },
          dataset: { reviewLens: image.id, visible: "false", renderMode: "nearest" },
        }),
        createElement("span", {
          className: "review-loupe-error",
          text: CANVAS_ERROR_TEXT,
          attributes: { hidden: "", "aria-hidden": "true" },
          dataset: { reviewLoupeError: image.id },
        }),
      );
    }
    const media = createElement("div", {
      className: "review-image-media",
      dataset: { reviewMedia: image.id },
    }, mediaChildren);
    const selectedLabel = image.selected ? "保留" : "移除";
    const recommendation = image.recommended ? "，推荐项" : "";
    return createElement("article", {
      className: "review-image-card",
      attributes: {
        role: "checkbox",
        tabindex: "0",
        "aria-checked": String(image.selected),
        "aria-current": String(image.id === activeImageId),
        "aria-disabled": String(!editable(review)),
        "aria-label": `图 ${index + 1}${recommendation}，当前${selectedLabel}`,
      },
      dataset: {
        reviewImage: image.id,
        reviewImageGroup: group.id,
        reviewImageIndex: index,
        selected: String(image.selected),
        active: String(image.id === activeImageId),
        loupeSource: "false",
      },
    }, [media]);
  };

  const renderCompletion = () => {
    elements.stage.querySelector("[data-review-complete]")?.remove();
    if (!completionVisible) return;
    const review = reviewState();
    const presentation = reviewCompletionPresentation(review.summary, review.filter);
    const overlay = createElement("div", {
      className: "review-deck-complete",
      attributes: { role: "dialog", "aria-labelledby": "review-complete-title" },
      dataset: { reviewComplete: "", batchComplete: String(presentation.batchComplete) },
    }, [createElement("div", { className: "review-deck-complete-box" }, [
      createElement("h2", { text: presentation.title, attributes: { id: "review-complete-title" } }),
      createElement("p", { text: presentation.message }),
      createElement("div", { className: "review-deck-complete-actions" }, [
        button("apply", "应用并整理文件", { primary: true, dangerous: true }),
        button("return-review", "返回复查"),
      ]),
    ])]);
    elements.stage.append(overlay);
    if (!busy) {
      queueMicrotask(() => {
        if (!completionVisible || busy || !root.contains(overlay)) return;
        overlay.querySelector(
          presentation.batchComplete
            ? '[data-review-action="apply"]'
            : '[data-review-action="return-review"]',
        )?.focus({ preventScroll: true });
      });
    }
  };

  const layoutImages = (group) => group.images.map((image) => ({
    width: image.width > 0 ? image.width : 1,
    height: image.height > 0 ? image.height : 1,
    readable: Boolean(image.readable && image.width > 0 && image.height > 0),
    recommended: image.recommended,
  }));

  const applyLayout = () => {
    layoutFrame = 0;
    const review = reviewState();
    const group = currentGroup(review, focusedIndex);
    const cards = elements.stage.querySelector("[data-review-cards]");
    if (!group || !cards || !cards.clientWidth || !cards.clientHeight) return;
    const minimumShortEdge = DESKTOP_MIN_SHORT_EDGE_PX;
    const layout = calculateReviewLayout(
      layoutImages(group),
      cards.clientWidth,
      cards.clientHeight,
      LAYOUT_GAP_PX,
      minimumShortEdge,
    );
    if (!layout.columns) return;
    let tileWidth = layout.tileWidth;
    let tileHeight = layout.tileHeight;
    const shortEdge = Math.min(tileWidth, tileHeight);
    if (shortEdge < minimumShortEdge) {
      const scale = minimumShortEdge / Math.max(1, shortEdge);
      tileWidth *= scale;
      tileHeight *= scale;
    }
    const roundedWidth = Math.max(1, Math.floor(tileWidth));
    const roundedHeight = Math.max(1, Math.floor(tileHeight));
    cards.style.gridTemplateColumns = `repeat(${layout.columns}, ${roundedWidth}px)`;
    cards.style.gridAutoRows = `${roundedHeight}px`;
    cards.style.setProperty("--review-tile-width", `${roundedWidth}px`);
    cards.style.setProperty("--review-tile-height", `${roundedHeight}px`);
    cards.dataset.layoutReadable = String(layout.readable);
    scheduleDraw();
  };

  const scheduleLayout = () => {
    if (layoutFrame) return;
    layoutFrame = requestFrame(applyLayout);
  };

  const observeCards = () => {
    disconnectLayoutObserver();
    if (!interactionsActive) return;
    const cards = elements.stage.querySelector("[data-review-cards]");
    if (!cards) return;
    if (typeof globalThis.ResizeObserver === "function") {
      resizeObserver = new globalThis.ResizeObserver(() => {
        if (interactionsActive) scheduleLayout();
      });
      resizeObserver.observe(cards);
    }
    scheduleLayout();
  };

  const renderStage = (review) => {
    const group = currentGroup(review, focusedIndex);
    const previousGroupId = elements.stage.dataset.reviewGroup || "";
    if (previousGroupId !== (group?.id || "")) resetLoupePosition({ preserveEnabled: true });
    disconnectLayoutObserver();
    releaseStageImages();
    releasePreloads();
    elements.stage.replaceChildren();
    elements.stage.dataset.reviewGroup = group?.id || "";
    loupeAvailable = Boolean(group?.images.some((image) => image.readable));
    if (!group) {
      elements.stage.setAttribute("aria-label", "当前筛选没有审核组");
      elements.stage.append(createEmptyState({
        label: "暂无匹配结果",
        title: "没有可显示的审核组",
        message: "可切换筛选或选择其他批次。",
      }));
      imagesReleased = false;
      updateLoupeUi();
      return;
    }
    if (!group.images.some((image) => image.id === activeImageId)) {
      activeImageId = group.images[0]?.id || "";
    }
    const readonlyLabel = review.summary.status === "ready" ? "" : "，只读";
    elements.stage.setAttribute(
      "aria-label",
      `组 ${group.ordinal}，${KIND_LABELS[group.kind]}，共 ${group.imageCount} 张${readonlyLabel}`,
    );
    const heading = createElement("div", { className: "review-deck-stage-heading" }, [
      createElement("strong", { text: `组 ${group.ordinal}` }),
      createStatusBadge(KIND_STATUS[group.kind], KIND_LABELS[group.kind], { compact: true }),
      createElement("span", {
        className: "review-deck-selection-count",
        text: `${group.selectedImageCount}/${group.imageCount} 保留`,
        dataset: { reviewGroupCount: "" },
      }),
      ...(review.summary.status === "ready" ? [] : [createElement("span", {
        className: "review-deck-readonly",
        text: "只读浏览",
      })]),
    ]);
    if (!group.images.length) {
      elements.stage.append(heading, createEmptyState({
        label: "空审核组",
        title: "当前组没有可显示图片",
        message: "该组没有可用图片元数据；请切换其他组或刷新权威快照。",
      }));
      imagesReleased = false;
      updateLoupeUi();
      renderCompletion();
      return;
    }
    const cards = createElement("div", {
      className: "review-deck-cards",
      dataset: { reviewCards: "", count: group.imageCount, layoutReadable: "false" },
    });
    const generation = stageGeneration;
    for (const [index, image] of group.images.entries()) {
      cards.append(buildImageCard(review, group, image, index, generation));
    }
    elements.stage.append(heading, cards);
    if (interactionsActive) loadImageWindow(review);
    else imagesReleased = true;
    observeCards();
    updateLoupeUi();
    renderCompletion();
  };

  const syncActiveImage = () => {
    for (const card of elements.stage.querySelectorAll("[data-review-image]")) {
      const active = card.dataset.reviewImage === activeImageId;
      card.dataset.active = String(active);
      card.setAttribute("aria-current", String(active));
    }
  };

  const applySelectionToCard = (image) => {
    const card = findByDataset(elements.stage, "[data-review-image]", "reviewImage", image.id);
    if (card) {
      card.dataset.selected = String(image.selected);
      card.setAttribute("aria-checked", String(image.selected));
      card.setAttribute("aria-disabled", String(!editable()));
      const imageNumber = Number(card.dataset.reviewImageIndex) + 1;
      const recommendation = image.recommended ? "，推荐项" : "";
      card.setAttribute(
        "aria-label",
        `图 ${imageNumber}${recommendation}，当前${image.selected ? "保留" : "移除"}`,
      );
      const stamp = findByDataset(card, "[data-review-stamp]", "reviewStamp", image.id);
      if (stamp) {
        stamp.dataset.state = image.selected ? "keep" : "drop";
        stamp.textContent = image.selected ? "✓ 保留" : "✗ 移除";
      }
    }
  };

  const syncSelections = (review) => {
    const group = currentGroup(review, focusedIndex);
    if (group && elements.stage.dataset.reviewGroup !== group.id) {
      renderStage(review);
      renderGroupSelector(review);
      return;
    }
    if (group) {
      const count = elements.stage.querySelector("[data-review-group-count]");
      if (count) count.textContent = `${group.selectedImageCount}/${group.imageCount} 保留`;
      for (const image of group.images) applySelectionToCard(image);
    }
    renderGroupSelector(review);
    elements.operationLive.dataset.reviewDirty = String(review.dirty);
    syncActiveImage();
    updateSourceMarkers();
    if (imagesReleased) loadImageWindow(review);
    if (completionVisible) renderCompletion();
  };

  const resetLocalDeckState = (review, index = 0) => {
    confirmedIds = new Set();
    completionVisible = false;
    focusedIndex = review.groups.length ? Math.max(0, Math.min(index, review.groups.length - 1)) : 0;
    activeImageId = currentGroup(review, focusedIndex)?.images[0]?.id || "";
    resetLoupePosition({ preserveEnabled: true });
  };

  const controlDisabled = (action, review) => {
    if (busy) return true;
    const hasGroups = Boolean(review.groups.length);
    const ready = review.summary?.status === "ready";
    if (["load-batch", "refresh", "open-tasks", "start", "retry", "discard-reload"].includes(action)) return false;
    if (action === "filter") return false;
    if (action === "prev-group") return !hasGroups || focusedIndex <= 0;
    if (action === "next-group") return !hasGroups || focusedIndex + 1 >= review.groups.length;
    if (action === "return-review") return !hasGroups;
    if (action === "loupe-toggle") return !loupeAvailable;
    if (action === "loupe-pin") return !loupeAvailable || !loupe.enabled;
    if (action === "apply") {
      if (!["ready", "apply_failed"].includes(review.summary?.status)) return true;
      return ready && review.summary.decidedGroupCount < review.summary.totalGroupCount && !review.dirty;
    }
    return false;
  };

  const syncControlAvailability = (review) => {
    const enterHint = elements.commandHost.querySelector("[data-review-enter-hint]");
    if (enterHint) {
      enterHint.textContent = reviewCanList(review.summary) && review.summary.status !== "ready"
        ? "Enter  下一组"
        : "Enter  采纳并前进";
    }
    for (const control of root.querySelectorAll("button, select, input")) control.disabled = false;
    elements.batchSelect.disabled = Boolean(busy);
    elements.groupSelect.disabled = Boolean(busy || !review.groups.length);
    for (const control of root.querySelectorAll("[data-review-action]")) {
      const disabled = controlDisabled(control.dataset.reviewAction, review);
      control.disabled = disabled;
      control.setAttribute("aria-disabled", String(disabled));
    }
    elements.commandHost.hidden = !review.groups.length;
    for (const card of elements.stage.querySelectorAll("[data-review-image]")) {
      card.setAttribute("aria-disabled", String(!editable(review)));
    }
    if (busy) {
      for (const control of root.querySelectorAll("button, select, input")) {
        control.disabled = true;
        control.setAttribute("aria-disabled", "true");
      }
    }
    updateLoupeUi();
  };

  const renderReview = (review, previous, metadata) => {
    const hasReview = Boolean(review.batchId && review.summary);
    const deckMode = hasReview && reviewCanList(review.summary);
    root.dataset.mode = deckMode ? "deck" : "panel";
    elements.appHeader.hidden = deckMode;
    elements.picker.hidden = deckMode;
    elements.deck.hidden = !deckMode;
    elements.workspace.hidden = !hasReview || deckMode;
    elements.emptyHost.replaceChildren(...(!hasReview ? [createEmptyState({
      label: "尚未选择审核批次",
      title: "选择已结束批次后打开审核",
      message: "打开批次不会自动开始分析。",
    })] : []));
    elements.emptyHost.hidden = deckMode || hasReview;
    placeSharedElements(deckMode, hasReview);

    if (!hasReview) {
      renderedWorkspaceKey = "";
      loupeAvailable = false;
      releaseImages();
      syncControlAvailability(review);
      return;
    }

    renderActions(review);
    if (!deckMode) {
      renderedWorkspaceKey = "";
      loupeAvailable = false;
      releaseImages();
      updateStatusBadge(elements.statusBadge, review.summary.statusKind, review.summary.statusLabel);
      renderNonDeckState(review);
      elements.operationLive.dataset.reviewDirty = String(review.dirty);
      syncControlAvailability(review);
      return;
    }

    const nextWorkspaceKey = workspaceKey(review);
    const contextChanged = renderedWorkspaceKey !== nextWorkspaceKey;
    if (contextChanged) {
      resetLocalDeckState(review, 0);
      renderedWorkspaceKey = nextWorkspaceKey;
    } else if (focusedIndex >= review.groups.length) {
      focusedIndex = Math.max(0, review.groups.length - 1);
    }
    renderDeckHeader(review);
    const group = currentGroup(review, focusedIndex);
    const stageShapeMatches = !contextChanged && elements.stage.dataset.reviewGroup === (group?.id || "") &&
      [...elements.stage.querySelectorAll("[data-review-image]")].map((card) => card.dataset.reviewImage).join("\u0000") ===
      (group?.images || []).map((image) => image.id).join("\u0000");
    const statusChanged = previous?.summary?.status !== review.summary.status;
    const selectionOnly = [
      "review/imageSelectionChanged",
      "review/groupConfirmed",
      "review/pageSaved",
      "review/summaryReceived",
      "busy",
    ].includes(metadata?.type);
    if (!stageShapeMatches || statusChanged || (!selectionOnly && metadata?.type !== "review/workspaceReceived")) {
      renderStage(review);
    } else {
      syncSelections(review);
    }
    elements.operationLive.dataset.reviewDirty = String(review.dirty);
    syncControlAvailability(review);
  };

  const focusStage = () => {
    if (elements.deck.hidden || !reviewState().groups.length) return false;
    try {
      elements.stage.focus({ preventScroll: true });
    } catch {
      elements.stage.focus();
    }
    return true;
  };

  const setFocusedIndex = (index) => {
    const review = reviewState();
    if (!reviewCanList(review.summary) || !review.groups.length || !Number.isInteger(index)) return false;
    const next = Math.max(0, Math.min(index, review.groups.length - 1));
    completionVisible = false;
    if (next !== focusedIndex || elements.stage.dataset.reviewGroup !== review.groups[next].id) {
      focusedIndex = next;
      activeImageId = review.groups[next].images[0]?.id || "";
      renderGroupSelector(review);
      renderStage(review);
      syncControlAvailability(review);
    } else {
      renderCompletion();
      renderGroupSelector(review);
      if (imagesReleased) loadImageWindow(review);
    }
    focusStage();
    return true;
  };

  const setActiveImage = (imageId, { focus = false } = {}) => {
    const group = currentGroup(reviewState(), focusedIndex);
    if (!group?.images.some((image) => image.id === imageId)) return false;
    activeImageId = imageId;
    syncActiveImage();
    if (focus) {
      const card = findByDataset(elements.stage, "[data-review-image]", "reviewImage", imageId);
      try {
        card?.focus({ preventScroll: true });
      } catch {
        card?.focus();
      }
    }
    return true;
  };

  const markConfirmed = (groupId) => {
    if (!reviewState().groups.some((group) => group.id === groupId)) return false;
    confirmedIds.add(groupId);
    renderGroupSelector(reviewState());
    return true;
  };

  const resetWorkspaceState = (index = 0, { focus = true } = {}) => {
    const review = reviewState();
    resetLocalDeckState(review, index);
    if (reviewCanList(review.summary)) {
      renderDeckHeader(review);
      renderStage(review);
      syncControlAvailability(review);
      if (focus) focusStage();
    }
  };

  const showCompletion = () => {
    if (!reviewState().groups.length) return false;
    completionVisible = true;
    renderCompletion();
    syncControlAvailability(reviewState());
    return true;
  };

  const hideCompletion = () => {
    if (!completionVisible) return false;
    completionVisible = false;
    renderCompletion();
    return true;
  };

  const previewContentRect = (preview) => {
    if (!preview || preview.dataset.reviewDecoded !== "true" || !preview.naturalWidth || !preview.naturalHeight) {
      return null;
    }
    const box = preview.getBoundingClientRect();
    return getContainContentRect(
      { width: preview.naturalWidth, height: preview.naturalHeight, readable: true },
      { left: box.left, top: box.top, width: box.width, height: box.height },
    );
  };

  const mediaFromEvent = (event) => {
    if (!(event.target instanceof Element)) return null;
    const media = event.target.closest("[data-review-media]");
    return media && root.contains(media) ? media : null;
  };

  const updatePointerPosition = (event, media) => {
    const preview = media?.querySelector("[data-review-preview-image]");
    const content = previewContentRect(preview);
    if (!content) return false;
    const inside = event.clientX >= content.left && event.clientX <= content.left + content.width &&
      event.clientY >= content.top && event.clientY <= content.top + content.height;
    if (!inside) return false;
    const coordinates = normalizePointerCoordinates(
      { clientX: event.clientX, clientY: event.clientY },
      content,
    );
    loupe.sourceImageId = media.dataset.reviewMedia || "";
    loupe.u = coordinates.u;
    loupe.v = coordinates.v;
    return true;
  };

  const setLoupeActive = (active) => {
    loupe.active = Boolean(active && loupeEffective());
    if (!loupe.active) {
      if (!loupe.pinned) loupe.sourceImageId = "";
      hideLoupeArtifacts();
    }
    updateLoupeUi();
  };

  const scheduleHide = () => {
    cancelHide();
    if (loupe.pinned) return;
    loupe.hideTimer = globalThis.setTimeout(() => {
      loupe.hideTimer = 0;
      if (!loupe.pinned) setLoupeActive(false);
    }, LOUPE_HIDE_DELAY_MS);
  };

  const resizeCanvas = (canvas) => {
    const cssWidth = Math.max(1, Math.round(canvas.clientWidth));
    const cssHeight = Math.max(1, Math.round(canvas.clientHeight));
    const density = Math.min(MAX_CANVAS_DPR, globalThis.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(cssWidth * density));
    const height = Math.max(1, Math.round(cssHeight * density));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { cssWidth, cssHeight, density };
  };

  const drawCanvasError = (canvas) => {
    clearCanvasDiagnostics(canvas);
    const errorLabel = findByDataset(
      canvas.parentElement,
      "[data-review-loupe-error]",
      "reviewLoupeError",
      canvas.dataset.reviewLens || "",
    );
    if (errorLabel) {
      errorLabel.style.left = canvas.style.left;
      errorLabel.style.top = canvas.style.top;
      errorLabel.hidden = false;
    }
    try {
      const { density } = resizeCanvas(canvas);
      const context2d = canvas.getContext("2d");
      if (!context2d) return;
      context2d.setTransform(1, 0, 0, 1, 0, 0);
      context2d.fillStyle = "Canvas";
      context2d.fillRect(0, 0, canvas.width, canvas.height);
      context2d.fillStyle = "CanvasText";
      context2d.font = `${13 * density}px monospace`;
      context2d.textAlign = "center";
      context2d.textBaseline = "middle";
      context2d.fillText(CANVAS_ERROR_TEXT, canvas.width / 2, canvas.height / 2);
    } catch {
      // 固定 DOM 文本已经提供安全降级，不回显异常正文。
    }
  };

  const referenceDimensions = (group) => {
    const candidates = group.images.map((image) => {
      const preview = findByDataset(elements.stage, "[data-review-preview-image]", "reviewPreviewImage", image.id);
      const decoded = preview?.dataset.reviewDecoded === "true";
      return {
        width: decoded ? preview.naturalWidth : image.width,
        height: decoded ? preview.naturalHeight : image.height,
        readable: Boolean(image.readable && (decoded || (image.width > 0 && image.height > 0))),
        recommended: image.recommended,
      };
    });
    return selectReferenceImage(candidates);
  };

  function drawLoupeNow() {
    loupe.drawFrame = 0;
    if (!loupeEffective() || !loupe.active) {
      updateLoupeUi();
      return;
    }
    const review = reviewState();
    const group = currentGroup(review, focusedIndex);
    if (!group) return;
    const reference = referenceDimensions(group);
    if (!reference.available) return;
    for (const image of group.images) {
      if (!image.readable) continue;
      const media = findByDataset(elements.stage, "[data-review-media]", "reviewMedia", image.id);
      const preview = findByDataset(elements.stage, "[data-review-preview-image]", "reviewPreviewImage", image.id);
      const crosshair = findByDataset(elements.stage, "[data-review-crosshair]", "reviewCrosshair", image.id);
      const canvas = findByDataset(elements.stage, "[data-review-lens]", "reviewLens", image.id);
      const errorLabel = findByDataset(elements.stage, "[data-review-loupe-error]", "reviewLoupeError", image.id);
      const content = previewContentRect(preview);
      const visible = Boolean(media && preview && crosshair && canvas && content);
      if (crosshair) crosshair.dataset.visible = String(visible);
      if (canvas) canvas.dataset.visible = String(visible);
      if (!visible) {
        if (canvas) clearCanvasDiagnostics(canvas);
        continue;
      }
      const mediaRect = media.getBoundingClientRect();
      const x = content.left - mediaRect.left + loupe.u * content.width;
      const y = content.top - mediaRect.top + loupe.v * content.height;
      crosshair.style.left = `${x}px`;
      crosshair.style.top = `${y}px`;
      const lensHalfWidth = canvas.clientWidth / 2;
      const lensHalfHeight = canvas.clientHeight / 2;
      const minimumX = Math.min(mediaRect.width / 2, lensHalfWidth + 5);
      const maximumX = Math.max(minimumX, mediaRect.width - lensHalfWidth - 5);
      const minimumY = Math.min(mediaRect.height / 2, lensHalfHeight + 5);
      const maximumY = Math.max(minimumY, mediaRect.height - lensHalfHeight - 5);
      canvas.style.left = `${clamp(x, minimumX, maximumX)}px`;
      canvas.style.top = `${clamp(y, minimumY, maximumY)}px`;
      try {
        const { cssWidth, cssHeight, density } = resizeCanvas(canvas);
        const crop = calculateSynchronizedCrop({
          targetImage: {
            width: preview.naturalWidth,
            height: preview.naturalHeight,
            readable: true,
            recommended: image.recommended,
          },
          referenceImage: reference.image,
          outputWidth: cssWidth,
          outputHeight: cssHeight,
          magnification: loupe.magnification,
          u: loupe.u,
          v: loupe.v,
        });
        if (!crop) continue;
        const context2d = canvas.getContext("2d");
        if (!context2d) throw new TypeError("canvas_context_unavailable");
        context2d.setTransform(1, 0, 0, 1, 0, 0);
        context2d.clearRect(0, 0, canvas.width, canvas.height);
        context2d.imageSmoothingEnabled = false;
        context2d.imageSmoothingQuality = "low";
        context2d.drawImage(
          preview,
          crop.x,
          crop.y,
          crop.sourceWidth,
          crop.sourceHeight,
          0,
          0,
          cssWidth * density,
          cssHeight * density,
        );
        canvas.dataset.renderMode = "nearest";
        canvas.dataset.sourceLeft = String(crop.x);
        canvas.dataset.sourceTop = String(crop.y);
        canvas.dataset.sourceWidth = String(crop.sourceWidth);
        canvas.dataset.sourceHeight = String(crop.sourceHeight);
        canvas.dataset.sampleU = String(loupe.u);
        canvas.dataset.sampleV = String(loupe.v);
        const idealLeft = loupe.u * preview.naturalWidth - crop.sourceWidth / 2;
        const idealTop = loupe.v * preview.naturalHeight - crop.sourceHeight / 2;
        canvas.dataset.edgeClamped = String(
          Math.abs(crop.x - idealLeft) > 1e-6 || Math.abs(crop.y - idealTop) > 1e-6,
        );
        if (errorLabel) errorLabel.hidden = true;
      } catch {
        drawCanvasError(canvas);
      }
    }
    updateLoupeUi();
  }

  const toggleLoupe = () => {
    if (!loupeAvailable) return null;
    loupe.enabled = !loupe.enabled;
    resetLoupePosition({ preserveEnabled: true });
    syncControlAvailability(reviewState());
    return loupe.enabled;
  };

  const toggleLoupePin = () => {
    if (!loupeEffective()) return "";
    cancelHide();
    if (!loupe.active) {
      const group = currentGroup(reviewState(), focusedIndex);
      const source = group?.images.find((image) => image.readable && image.recommended)
        || group?.images.find((image) => image.readable)
        || null;
      loupe.u = 0.5;
      loupe.v = 0.5;
      loupe.sourceImageId = source?.id || "";
      loupe.active = true;
    }
    loupe.pinned = !loupe.pinned;
    if (!loupe.pinned) scheduleHide();
    updateLoupeUi();
    scheduleDraw();
    syncControlAvailability(reviewState());
    return loupe.pinned ? "pinned" : "unpinned";
  };

  const onPointerOver = (event) => {
    if (mediaFromEvent(event) && loupeEffective()) cancelHide();
  };

  const onPointerOut = (event) => {
    const media = mediaFromEvent(event);
    if (!media || !loupeEffective()) return;
    if (event.relatedTarget instanceof Node && media.contains(event.relatedTarget)) return;
    scheduleHide();
  };

  const onPointerMove = (event) => {
    if (event.pointerType && event.pointerType !== "mouse") return;
    const media = mediaFromEvent(event);
    if (!media || !loupeEffective() || loupe.pinned) return;
    if (!updatePointerPosition(event, media)) {
      scheduleHide();
      return;
    }
    cancelHide();
    setLoupeActive(true);
    scheduleDraw();
  };

  const onWheel = (event) => {
    const media = mediaFromEvent(event);
    if (!media || !loupeEffective()) return;
    const valid = loupe.pinned && loupe.active ? true : updatePointerPosition(event, media);
    if (!valid) return;
    event.preventDefault();
    cancelHide();
    loupe.magnification = updateMagnification(loupe.magnification, event.deltaY, {
      deltaMode: event.deltaMode,
      pageSize: Math.max(1, elements.stage.clientHeight || 800),
    });
    loupe.active = true;
    updateLoupeUi();
    scheduleDraw();
  };

  const attachInteractions = () => {
    if (interactionsActive) return;
    interactionsActive = true;
    root.addEventListener("pointerover", onPointerOver);
    root.addEventListener("pointerout", onPointerOut);
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("wheel", onWheel, { passive: false });
    observeCards();
  };

  const detachInteractions = () => {
    const wasActive = interactionsActive;
    interactionsActive = false;
    if (wasActive) {
      root.removeEventListener("pointerover", onPointerOver);
      root.removeEventListener("pointerout", onPointerOut);
      root.removeEventListener("pointermove", onPointerMove);
      root.removeEventListener("wheel", onWheel);
    }
    disconnectLayoutObserver();
    resetLoupePosition({ preserveEnabled: false });
  };

  const onFocusIn = (event) => {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest("[data-review-image]");
    if (card && root.contains(card)) setActiveImage(card.dataset.reviewImage || "");
  };

  root.addEventListener("focusin", onFocusIn);
  const unsubscribeRecent = store.subscribe((state) => state.batches.recent, renderBatches, { fireImmediately: true });
  const unsubscribeReview = store.subscribe(selectors.review, renderReview, { fireImmediately: true });

  return Object.freeze({
    elements,
    selectedBatchId: () => elements.batchSelect.value,
    clearError,
    showError,
    setOperationMessage(message) {
      elements.operationLive.textContent = message;
    },
    setBusy(kind) {
      busy = kind;
      root.toggleAttribute("aria-busy", Boolean(kind));
      renderReview(reviewState(), reviewState(), { type: "busy" });
    },
    activate() {
      attachInteractions();
      if (imagesReleased && reviewCanList(reviewState().summary)) loadImageWindow(reviewState());
    },
    deactivate() {
      detachInteractions();
      releaseImages();
    },
    releaseImages,
    applyConfirmationText() {
      const counts = reviewApplyCounts(reviewState().summary);
      return `自动移除 ${counts.automatic} 张；最终保留 ${counts.selected} 张，预计移出 ${counts.rejected} 张。`;
    },
    getFocusedIndex: () => focusedIndex,
    getFocusedGroup: () => currentGroup(reviewState(), focusedIndex),
    getActiveImageId: () => activeImageId,
    isLoupeAvailable: () => loupeAvailable,
    setFocusedIndex,
    setActiveImage,
    focusStage,
    markConfirmed,
    resetWorkspaceState,
    showCompletion,
    hideCompletion,
    isCompletionVisible: () => completionVisible,
    toggleLoupe,
    toggleLoupePin,
    destroy() {
      detachInteractions();
      unsubscribeRecent();
      unsubscribeReview();
      root.removeEventListener("focusin", onFocusIn);
      releaseImages();
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
      root.removeAttribute("data-mode");
    },
  });
}
