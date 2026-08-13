import { setElementInert } from "../core/dom.js";
import {
  createGalleryUnavailableAdapter,
  projectGalleryState,
  toggleGallerySelection,
  updateGalleryUiState,
  visibleGalleryItems,
} from "../core/gallery-model.js";
import { createGalleryView } from "../components/gallery-view.js";

function requireAdapter(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter) || typeof adapter.read !== "function") {
    throw new TypeError("图片库适配器无效");
  }
  return adapter;
}

export function createGalleryController(context, {
  adapter = createGalleryUnavailableAdapter(),
  createView = createGalleryView,
  initialState = null,
} = {}) {
  const { root } = context;
  const source = requireAdapter(adapter);
  let state = initialState ? projectGalleryState(initialState) : projectGalleryState({ phase: "unavailable" });
  let active = false;
  let destroyed = false;
  let lifecycle = 0;
  let view;
  view = createView(context);
  if (!view || typeof view !== "object" || typeof view.render !== "function") {
    throw new TypeError("图片库视图无效");
  }

  const setState = (nextState) => {
    state = projectGalleryState(nextState);
    view.render(state, view.getUiState());
    return state;
  };

  const readAdapter = async () => {
    const ticket = lifecycle;
    const result = await source.read();
    if (!active || destroyed || ticket !== lifecycle) return false;
    setState(result);
    return true;
  };

  const onClick = (event) => {
    if (!active || destroyed || !(event.target instanceof Element)) return;
    const button = event.target.closest("[data-gallery-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.galleryAction;
    let uiState = view.getUiState();
    if (action === "collection") {
      uiState = updateGalleryUiState(uiState, {
        collection: button.dataset.galleryCollection,
        selectedIds: [],
        quickLookId: "",
      }, state.items);
      view.render(state, uiState);
    } else if (action === "mode-grid" || action === "mode-list") {
      view.updateUi({ mode: action === "mode-grid" ? "grid" : "list" });
    } else if (action === "toggle-inspector") {
      view.updateUi({ inspectorOpen: !uiState.inspectorOpen });
    } else if (action === "select") {
      uiState = toggleGallerySelection(uiState, button.dataset.galleryMediaId, state.items, {
        additive: event.ctrlKey || event.metaKey || event.shiftKey,
      });
      view.render(state, uiState);
    } else if (action === "quick-look") {
      view.openQuickLook();
    } else if (action === "quick-look-close") {
      view.closeQuickLook();
    } else if (action === "quick-look-previous") {
      view.stepQuickLook(-1);
    } else if (action === "quick-look-next") {
      view.stepQuickLook(1);
    }
  };

  const onInput = (event) => {
    if (!active || destroyed || !(event.target instanceof HTMLInputElement)) return;
    if (event.target === view.elements.searchInput) view.updateUi({ query: event.target.value });
  };

  const onChange = (event) => {
    if (!active || destroyed || !(event.target instanceof HTMLSelectElement)) return;
    if (event.target === view.elements.sortSelect) view.updateUi({ sort: event.target.value });
  };

  const onKeyDown = (event) => {
    if (!active || destroyed) return;
    if (event.key === "Escape" && view.closeQuickLook()) {
      event.preventDefault();
      return;
    }
    if (view.trapQuickLookFocus(event)) return;
    if (view.isEditableTarget(event.target)) return;
    if (event.key === " " && event.target instanceof Element) {
      const media = event.target.closest("[data-gallery-media-id]");
      if (media instanceof HTMLButtonElement) {
        event.preventDefault();
        const uiState = toggleGallerySelection(view.getUiState(), media.dataset.galleryMediaId, state.items, {
          additive: event.ctrlKey || event.metaKey || event.shiftKey,
        });
        view.render(state, uiState);
      }
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const media = event.target instanceof Element ? event.target.closest("[data-gallery-media-id]") : null;
    if (!(media instanceof HTMLButtonElement)) return;
    const visible = visibleGalleryItems(state, view.getUiState());
    const currentIndex = visible.findIndex((item) => item.id === media.dataset.galleryMediaId);
    if (currentIndex < 0) return;
    const columns = view.getUiState().mode === "grid" ? 3 : 1;
    const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" ? -columns : columns;
    const nextIndex = Math.max(0, Math.min(currentIndex + delta, visible.length - 1));
    if (nextIndex === currentIndex) return;
    const next = root.querySelector(`[data-gallery-media-id="${visible[nextIndex].id}"]`);
    if (next instanceof HTMLElement) {
      event.preventDefault();
      next.focus({ preventScroll: true });
    }
  };

  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onChange);
  root.addEventListener("keydown", onKeyDown);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      lifecycle += 1;
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.render(state, view.getUiState());
      void readAdapter().catch(() => {
        if (active && !destroyed) setState({
          phase: "error",
          error: { code: "adapter_failed", status: 0, requestId: "", category: "capability" },
        });
      });
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      lifecycle += 1;
      view.closeQuickLook({ restore: false });
      view.releaseMedia();
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    setState,
    getState: () => state,
    getUiState: () => view.getUiState(),
    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      lifecycle += 1;
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      root.removeEventListener("change", onChange);
      root.removeEventListener("keydown", onKeyDown);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("图片库已挂载");
    controller = createGalleryController(context);
  },
  activate() {
    controller?.activate();
  },
  deactivate() {
    controller?.deactivate();
  },
  unmount() {
    controller?.destroy();
    controller = null;
  },
});
