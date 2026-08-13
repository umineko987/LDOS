import { createElement } from "../core/dom.js";
import {
  createGalleryUiState,
  galleryPresentation,
  updateGalleryUiState,
  visibleGalleryItems,
} from "../core/gallery-model.js";
import { createEmptyState } from "./empty-state.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const DISABLED_REASON = "图片库后端能力尚未接入，当前操作不可用。";
const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable]";
const FOCUSABLE_SELECTOR = "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])";

function actionButton(action, label, { disabled = false, reasonId = "gallery-write-reason", primary = false } = {}) {
  const button = createElement("button", {
    className: `gallery-button${primary ? " gallery-button--primary" : ""}`,
    text: label,
    attributes: {
      type: "button",
      "aria-describedby": disabled ? reasonId : null,
      title: disabled ? DISABLED_REASON : null,
    },
    dataset: { galleryAction: action },
  });
  button.disabled = disabled;
  return button;
}

function navButton(collection, label) {
  return createElement("button", {
    className: "gallery-nav-button",
    text: label,
    attributes: { type: "button", "aria-pressed": "false" },
    dataset: { galleryAction: "collection", galleryCollection: collection },
  });
}

function mediaPreview(item, { large = false } = {}) {
  return createElement("div", {
    className: `gallery-media-preview gallery-media-preview--${item.mediaVariant}${large ? " gallery-media-preview--large" : ""}`,
    attributes: { "aria-hidden": "true" },
    dataset: { galleryMediaToken: item.mediaToken, galleryMediaVariant: item.mediaVariant },
  }, [
    createElement("span", { className: "gallery-media-preview__shape gallery-media-preview__shape--one" }),
    createElement("span", { className: "gallery-media-preview__shape gallery-media-preview__shape--two" }),
    createElement("span", { className: "gallery-media-preview__grain" }),
  ]);
}

function mediaCard(item, selected, mode) {
  const card = createElement("button", {
    className: `gallery-media-card gallery-media-card--${mode}`,
    attributes: {
      type: "button",
      role: "option",
      "aria-selected": String(selected),
      "aria-label": `${item.label}，${item.sourceLabel}，${selected ? "已选择" : "未选择"}`,
    },
    dataset: {
      galleryAction: "select",
      galleryMediaId: item.id,
      galleryFocus: `media:${item.id}`,
      selected: String(selected),
    },
  }, [
    mediaPreview(item),
    createElement("span", { className: "gallery-media-card__copy" }, [
      createElement("strong", { text: item.label }),
      createElement("small", { text: `${item.sourceLabel} · ${item.kind}` }),
      createElement("small", { text: `${item.width} × ${item.height}${item.favorite ? " · 已收藏" : ""}` }),
    ]),
  ]);
  return card;
}

function safeErrorText(error) {
  if (!error) return "未提供安全错误事实。";
  return `分类 ${error.category} · 代码 ${error.code} · 状态 ${error.status || "未连接"}`;
}

function phaseState(state, presentation) {
  const definitions = {
    unavailable: [presentation.label, presentation.message],
    loading: [presentation.label, presentation.message],
    empty: [presentation.label, presentation.message],
    error: [presentation.label, `${presentation.message} ${safeErrorText(state.error)}`],
  };
  const [title, message] = definitions[state.phase] || [presentation.label, presentation.message];
  return createEmptyState({
    status: presentation.kind,
    label: presentation.label,
    title,
    message,
  });
}

function focusToken(root) {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || !root.contains(target)) return "";
  return target.dataset.galleryFocus || target.closest("[data-gallery-media-id]")?.dataset.galleryMediaId || "";
}

function restoreFocus(root, token, fallback) {
  if (!token) return;
  const candidates = [...root.querySelectorAll("[data-gallery-focus], [data-gallery-media-id], button, input, select")];
  const target = candidates.find((item) => !item.disabled && (
    item.dataset.galleryFocus === token || item.dataset.galleryMediaId === token
  )) || fallback;
  target?.focus({ preventScroll: true });
}

function quickLookFocusable(overlay) {
  return [...overlay.querySelectorAll(FOCUSABLE_SELECTOR)].filter((element) => !element.hidden);
}

export function createGalleryView({ root, app }, { onStateChange = () => {}, onMediaRelease = () => {} } = {}) {
  const headingId = "gallery-heading";
  const headerBadge = createStatusBadge("disabled", "后端能力尚未接入");
  const libraryButton = navButton("library", "图库");
  const favoritesButton = navButton("favorites", "收藏");
  const sourcesButton = navButton("sources", "来源");
  const searchInput = createElement("input", {
    className: "gallery-search",
    attributes: {
      type: "search",
      placeholder: "搜索标签、来源或类型",
      "aria-label": "搜索图片库",
    },
    dataset: { galleryFocus: "search" },
  });
  const sortSelect = createElement("select", {
    className: "gallery-select",
    attributes: { "aria-label": "图片排序" },
    dataset: { galleryFocus: "sort" },
  }, [
    createElement("option", { text: "最近优先", attributes: { value: "recent" } }),
    createElement("option", { text: "最早优先", attributes: { value: "oldest" } }),
    createElement("option", { text: "名称排序", attributes: { value: "label" } }),
  ]);
  const gridButton = actionButton("mode-grid", "网格");
  gridButton.dataset.galleryFocus = "mode:grid";
  const listButton = actionButton("mode-list", "列表");
  listButton.dataset.galleryFocus = "mode:list";
  const inspectorButton = actionButton("toggle-inspector", "折叠检查器");
  inspectorButton.dataset.galleryFocus = "inspector-toggle";
  const quickLookButton = actionButton("quick-look", "Quick Look");
  quickLookButton.dataset.galleryFocus = "quick-look";
  const reason = createElement("p", {
    className: "gallery-disabled-reason",
    text: DISABLED_REASON,
    attributes: { id: "gallery-write-reason" },
  });
  const writeActions = createElement("div", { className: "gallery-write-actions" }, [
    actionButton("import", "导入", { disabled: true }),
    actionButton("delete", "删除", { disabled: true }),
    actionButton("reveal", "在文件夹中显示", { disabled: true }),
    actionButton("tag-write", "写入标签", { disabled: true }),
    actionButton("export", "导出所选", { disabled: true }),
  ]);
  const workspaceState = createElement("section", {
    className: "gallery-workspace-state",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
    dataset: { galleryWorkspaceState: "unavailable" },
  }, [
    createStatusBadge("disabled", "后端能力尚未接入"),
    createElement("p", { text: "图片库后端能力尚未接入。" }),
  ]);
  const mediaHost = createElement("div", {
    className: "gallery-media-host gallery-media-host--grid",
    attributes: { role: "listbox", "aria-label": "图片库媒体", "aria-multiselectable": "true" },
    dataset: { galleryMediaHost: "", galleryMode: "grid" },
  });
  const phaseHost = createElement("div", { className: "gallery-phase-host", dataset: { galleryPhaseHost: "" } });
  const inspectorHost = createElement("div", { className: "gallery-inspector-host", dataset: { galleryInspectorHost: "" } });
  const selectionFact = createElement("p", { className: "gallery-selection-fact", text: "未选择媒体。" });

  const navigationColumn = createElement("aside", {
    className: "gallery-column gallery-column--navigation",
    attributes: { "aria-labelledby": "gallery-navigation-heading" },
  }, [
    createElement("header", { className: "gallery-column-header" }, [
      createElement("p", { className: "gallery-column-kicker", text: "01 · 浏览" }),
      createElement("h2", { text: "图片库分区", attributes: { id: "gallery-navigation-heading" } }),
      createElement("p", { text: "仅包含图库、收藏与来源，不列出其他应用。" }),
    ]),
    createElement("div", { className: "gallery-column-scroll" }, [
      createElement("nav", { className: "gallery-nav", attributes: { "aria-label": "图片库分区" } }, [
        libraryButton, favoritesButton, sourcesButton,
      ]),
      createElement("section", { className: "gallery-panel" }, [
        createElement("h3", { text: "服务边界" }),
        createElement("p", { text: "正式运行只使用 unavailable adapter，不请求业务 API，也不读取本机下载目录。" }),
      ]),
      reason,
      writeActions,
    ]),
  ]);

  const contentColumn = createElement("main", {
    className: "gallery-column gallery-column--content",
    attributes: { "aria-labelledby": "gallery-content-heading" },
  }, [
    createElement("header", { className: "gallery-column-header" }, [
      createElement("p", { className: "gallery-column-kicker", text: "02 · 内容" }),
      createElement("h2", { text: "搜索与选择", attributes: { id: "gallery-content-heading" } }),
      createElement("p", { text: "合成预览仅表达颜色与构图，不引用运行时图片。" }),
    ]),
    createElement("div", { className: "gallery-content-layout" }, [
      createElement("div", { className: "gallery-toolbar" }, [
        searchInput,
        sortSelect,
        createElement("div", { className: "gallery-segmented", attributes: { role: "group", "aria-label": "图片布局" } }, [gridButton, listButton]),
      ]),
      workspaceState,
      phaseHost,
      mediaHost,
    ]),
  ]);

  const inspectorColumn = createElement("aside", {
    className: "gallery-column gallery-column--inspector",
    attributes: { "aria-labelledby": "gallery-inspector-heading" },
    dataset: { galleryInspector: "open" },
  }, [
    createElement("header", { className: "gallery-column-header" }, [
      createElement("p", { className: "gallery-column-kicker", text: "03 · 检查器" }),
      createElement("h2", { text: "安全媒体事实", attributes: { id: "gallery-inspector-heading" } }),
      createElement("p", { text: "不显示文件名、路径、URL 或用户图片字段。" }),
    ]),
    createElement("div", { className: "gallery-column-scroll" }, [
      createElement("div", { className: "gallery-inspector-actions" }, [inspectorButton, quickLookButton]),
      selectionFact,
      inspectorHost,
    ]),
  ]);

  const track = createElement("div", { className: "gallery-workspace-track" }, [navigationColumn, contentColumn, inspectorColumn]);
  const workspace = createElement("section", {
    className: "gallery-workspace",
    attributes: { tabindex: "0", "aria-label": "图片库三栏工作区；普通窗口可横向滚动" },
    dataset: { galleryWorkspace: "" },
  }, [track]);

  root.classList.add("app-view", "gallery-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header gallery-app-header" }, [
      createElement("div", {}, [
        createElement("p", { className: "app-executable", text: app.windowTitle }),
        createElement("h1", { text: app.label, attributes: { id: headingId } }),
      ]),
      headerBadge,
    ]),
    workspace,
  );

  let currentState = { phase: "unavailable", items: [], error: null };
  let uiState = createGalleryUiState();
  let quickLookOverlay = null;
  let quickLookReturnFocus = null;
  let releasedMedia = 0;
  let destroyed = false;

  const releaseMedia = () => {
    const previews = [...root.querySelectorAll("[data-gallery-media-token]")];
    for (const preview of previews) {
      preview.removeAttribute("data-gallery-media-token");
      preview.replaceChildren();
    }
    releasedMedia += previews.length;
    onMediaRelease(previews.length);
    return previews.length;
  };

  const closeQuickLook = ({ restore = true, notify = true } = {}) => {
    if (!quickLookOverlay) return false;
    const overlay = quickLookOverlay;
    quickLookOverlay = null;
    const returnTarget = quickLookReturnFocus;
    quickLookReturnFocus = null;
    overlay.querySelectorAll("[data-gallery-media-token]").forEach((preview) => {
      preview.removeAttribute("data-gallery-media-token");
      preview.replaceChildren();
      releasedMedia += 1;
      onMediaRelease(1);
    });
    overlay.remove();
    uiState = updateGalleryUiState(uiState, { quickLookId: "" }, currentState.items);
    if (notify) onStateChange(uiState);
    if (restore && returnTarget instanceof HTMLElement && root.contains(returnTarget)) {
      returnTarget.focus({ preventScroll: true });
    }
    return true;
  };

  const openQuickLook = (itemId = uiState.selectedIds[0]) => {
    if (!itemId || currentState.phase !== "content") return false;
    const item = currentState.items.find((candidate) => candidate.id === itemId);
    if (!item) return false;
    closeQuickLook({ restore: false, notify: false });
    quickLookReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : quickLookButton;
    uiState = updateGalleryUiState(uiState, { quickLookId: item.id }, currentState.items);
    const closeButton = actionButton("quick-look-close", "关闭 Quick Look", { primary: true });
    closeButton.dataset.galleryFocus = "quick-look-close";
    const previousButton = actionButton("quick-look-previous", "上一张");
    const nextButton = actionButton("quick-look-next", "下一张");
    quickLookOverlay = createElement("section", {
      className: "gallery-quick-look",
      attributes: {
        role: "dialog",
        "aria-modal": "true",
        "aria-labelledby": "gallery-quick-look-title",
        "aria-describedby": "gallery-quick-look-description",
        tabindex: "-1",
      },
      dataset: { galleryQuickLook: item.id },
    }, [
      createElement("div", { className: "gallery-quick-look__scrim", attributes: { "aria-hidden": "true" } }),
      createElement("div", { className: "gallery-quick-look__dialog" }, [
        createElement("header", {}, [
          createElement("div", {}, [
            createElement("p", { className: "gallery-column-kicker", text: "QUICK LOOK" }),
            createElement("h2", { text: item.label, attributes: { id: "gallery-quick-look-title" } }),
          ]),
          closeButton,
        ]),
        mediaPreview(item, { large: true }),
        createElement("p", {
          id: "gallery-quick-look-description",
          text: `${item.sourceLabel} · ${item.kind} · ${item.width} × ${item.height}。这是安全合成预览。`,
        }),
        createElement("div", { className: "gallery-quick-look__actions" }, [previousButton, nextButton]),
      ]),
    ]);
    root.append(quickLookOverlay);
    closeButton.focus({ preventScroll: true });
    onStateChange(uiState);
    return true;
  };

  const stepQuickLook = (direction) => {
    if (!quickLookOverlay || currentState.phase !== "content") return false;
    const visible = visibleGalleryItems(currentState, uiState);
    if (!visible.length) return false;
    const index = Math.max(0, visible.findIndex((item) => item.id === uiState.quickLookId));
    const target = visible[Math.max(0, Math.min(index + direction, visible.length - 1))];
    if (!target || target.id === uiState.quickLookId) return false;
    const returnFocus = quickLookReturnFocus;
    openQuickLook(target.id);
    quickLookReturnFocus = returnFocus;
    return true;
  };

  const render = (state = currentState, nextUi = uiState) => {
    const token = focusToken(root);
    closeQuickLook({ restore: false, notify: false });
    releaseMedia();
    currentState = state;
    uiState = updateGalleryUiState(nextUi, { quickLookId: "" }, state.items);
    const presentation = galleryPresentation(state);
    workspaceState.dataset.galleryWorkspaceState = presentation.state;
    const stateBadge = workspaceState.children[0];
    const stateMessage = workspaceState.children[1];
    updateStatusBadge(stateBadge, presentation.kind, presentation.label);
    updateStatusBadge(headerBadge, presentation.kind, presentation.label);
    stateMessage.textContent = presentation.message;
    libraryButton.setAttribute("aria-pressed", String(uiState.collection === "library"));
    favoritesButton.setAttribute("aria-pressed", String(uiState.collection === "favorites"));
    sourcesButton.setAttribute("aria-pressed", String(uiState.collection === "sources"));
    searchInput.value = uiState.query;
    sortSelect.value = uiState.sort;
    gridButton.setAttribute("aria-pressed", String(uiState.mode === "grid"));
    listButton.setAttribute("aria-pressed", String(uiState.mode === "list"));
    mediaHost.className = `gallery-media-host gallery-media-host--${uiState.mode}`;
    mediaHost.dataset.galleryMode = uiState.mode;
    inspectorColumn.dataset.galleryInspector = uiState.inspectorOpen ? "open" : "closed";
    inspectorButton.textContent = uiState.inspectorOpen ? "折叠检查器" : "展开检查器";
    inspectorButton.setAttribute("aria-expanded", String(uiState.inspectorOpen));

    if (state.phase !== "content") {
      phaseHost.replaceChildren(phaseState(state, presentation));
      mediaHost.replaceChildren();
      inspectorHost.replaceChildren(createEmptyState({
        status: presentation.kind,
        label: presentation.label,
        title: "检查器暂无媒体事实",
        message: presentation.message,
      }));
      selectionFact.textContent = "未选择媒体。";
      quickLookButton.disabled = true;
      quickLookButton.setAttribute("aria-describedby", "gallery-write-reason");
      restoreFocus(root, token, workspace);
      return;
    }

    phaseHost.replaceChildren();
    const visible = visibleGalleryItems(state, uiState);
    mediaHost.replaceChildren(...visible.map((item) => mediaCard(item, uiState.selectedIds.includes(item.id), uiState.mode)));
    if (!visible.length) {
      phaseHost.replaceChildren(createEmptyState({
        label: "筛选结果为空",
        title: "没有匹配的媒体",
        message: "调整搜索、排序或图片库分区后重试。",
      }));
    }
    const selected = state.items.filter((item) => uiState.selectedIds.includes(item.id));
    selectionFact.textContent = selected.length ? `已选择 ${selected.length} 项安全媒体事实。` : "未选择媒体。";
    quickLookButton.disabled = selected.length === 0;
    if (quickLookButton.disabled) quickLookButton.setAttribute("aria-describedby", "gallery-write-reason");
    else quickLookButton.removeAttribute("aria-describedby");
    inspectorHost.replaceChildren(...(selected.length ? selected.map((item) => createElement("article", {
      className: "gallery-inspector-card",
      dataset: { galleryInspectorItem: item.id },
    }, [
      mediaPreview(item),
      createElement("h3", { text: item.label }),
      createElement("dl", { className: "gallery-facts" }, [
        createElement("div", {}, [createElement("dt", { text: "来源" }), createElement("dd", { text: item.sourceLabel })]),
        createElement("div", {}, [createElement("dt", { text: "类型" }), createElement("dd", { text: item.kind })]),
        createElement("div", {}, [createElement("dt", { text: "尺寸" }), createElement("dd", { text: `${item.width} × ${item.height}` })]),
        createElement("div", {}, [createElement("dt", { text: "标签" }), createElement("dd", { text: item.tags.join("、") || "无" })]),
      ]),
    ])) : [createEmptyState({
      label: "未选择",
      title: "选择一项查看检查器",
      message: "检查器只显示白名单媒体事实。",
    })]));
    restoreFocus(root, token, workspace);
  };

  return Object.freeze({
    elements: {
      workspace, mediaHost, phaseHost, inspectorHost, searchInput, sortSelect,
      gridButton, listButton, inspectorButton, quickLookButton, writeActions,
    },
    getUiState: () => uiState,
    render,
    updateUi(patch) {
      uiState = updateGalleryUiState(uiState, patch, currentState.items);
      onStateChange(uiState);
      render(currentState, uiState);
      return uiState;
    },
    openQuickLook,
    closeQuickLook,
    stepQuickLook,
    releaseMedia,
    releasedMediaCount: () => releasedMedia,
    isEditableTarget(target) {
      return target instanceof Element && Boolean(target.closest(EDITABLE_SELECTOR));
    },
    trapQuickLookFocus(event) {
      if (!quickLookOverlay || event.key !== "Tab") return false;
      const focusable = quickLookFocusable(quickLookOverlay);
      if (!focusable.length) return false;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return true;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
        return true;
      }
      return false;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      closeQuickLook({ restore: false, notify: false });
      releaseMedia();
      root.replaceChildren();
    },
  });
}
