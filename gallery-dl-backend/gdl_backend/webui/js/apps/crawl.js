import { isAbortError } from "../core/api.js";
import {
  buildCrawlPayload,
  buildSearchPayload,
  crawlErrorGuidance,
  projectCrawlSearchResponse,
  sanitizeAutocompleteResponse,
} from "../core/crawl-model.js";
import { setElementInert } from "../core/dom.js";
import { actionCreators } from "../core/store.js";
import { createCrawlView } from "../components/crawl-view.js";

export const CRAWL_ENDPOINTS = Object.freeze({
  search: "/api/v1/search",
  autocomplete: "/api/v1/search/autocomplete",
  crawls: "/api/v1/crawls",
});

export const AUTOCOMPLETE_DELAY_MS = 300;

export function createCrawlController(context, {
  createView = createCrawlView,
  initialOperations = null,
} = {}) {
  const { root, api, store, actions } = context;
  const view = createView(context);
  let active = false;
  let destroyed = false;
  let busy = "";
  let lifecycle = 0;
  let autocompleteTimer = null;
  let autocompleteController = null;
  let autocompleteSequence = 0;
  let focusOutTimer = null;
  let operationController = null;
  let operationSequence = 0;
  let addressOperations = initialOperations instanceof Map
    ? new Map(initialOperations)
    : new Map();
  let searchHadError = false;

  const stopAutocomplete = () => {
    if (autocompleteTimer !== null) clearTimeout(autocompleteTimer);
    autocompleteTimer = null;
    autocompleteController?.abort();
    autocompleteController = null;
    autocompleteSequence += 1;
  };

  const stopFocusOut = () => {
    if (focusOutTimer !== null) clearTimeout(focusOutTimer);
    focusOutTimer = null;
  };

  const setBusy = (kind) => {
    busy = kind;
    view.setBusy(kind);
  };

  const showError = (error) => {
    if (!isAbortError(error)) view.showError(crawlErrorGuidance(error));
  };

  const requestAutocomplete = () => {
    stopAutocomplete();
    if (!active || destroyed) return;
    const query = view.elements.keyword.value.trim();
    if (query.length < 2) {
      view.hideSuggestions();
      return;
    }
    const requestLifecycle = lifecycle;
    const sequence = ++autocompleteSequence;
    autocompleteTimer = setTimeout(async () => {
      autocompleteTimer = null;
      const controller = new AbortController();
      autocompleteController = controller;
      try {
        const response = await api.get(
          `${CRAWL_ENDPOINTS.autocomplete}?q=${encodeURIComponent(query)}&limit=10`,
          { signal: controller.signal },
        );
        if (!active || destroyed || controller.signal.aborted || requestLifecycle !== lifecycle ||
            sequence !== autocompleteSequence || view.elements.keyword.value.trim() !== query) return;
        view.setSuggestions(sanitizeAutocompleteResponse(response));
      } catch (error) {
        if (!isAbortError(error) && sequence === autocompleteSequence) view.hideSuggestions();
      } finally {
        if (autocompleteController === controller) autocompleteController = null;
      }
    }, AUTOCOMPLETE_DELAY_MS);
  };

  const runSearch = async () => {
    if (!active || destroyed || busy) return false;
    const validation = view.validateSearchDraft();
    if (!validation.valid) {
      view.refreshValidation("search", { announce: true });
      view.setOperationMessage(validation.reason);
      return false;
    }
    let payload;
    try {
      payload = buildSearchPayload(view.readSearchDraft());
    } catch (error) {
      view.refreshValidation("search", { announce: true });
      view.setOperationMessage("请修正标记项后再搜索。");
      return false;
    }
    const operation = ++operationSequence;
    const requestLifecycle = lifecycle;
    operationController?.abort();
    const controller = new AbortController();
    operationController = controller;
    stopAutocomplete();
    view.hideSuggestions();
    view.clearError();
    view.setSearchState("loading");
    setBusy("search");
    view.setOperationMessage("正在搜索多个站点，离开页面将取消本次搜索……");
    let captured = payload;
    payload = null;
    try {
      const promise = api.post(CRAWL_ENDPOINTS.search, captured, { signal: controller.signal });
      captured = null;
      const response = await promise;
      if (!active || destroyed || controller.signal.aborted || requestLifecycle !== lifecycle ||
          operation !== operationSequence) return false;
      const projection = projectCrawlSearchResponse(response);
      addressOperations = projection.operations;
      view.setOperationalAvailability(true);
      store.dispatch(actionCreators.crawlSearchReceived(response));
      view.normalizeActiveSource();
      view.clearError();
      view.setSearchState(searchHadError ? "recovery" : "settled");
      searchHadError = false;
      view.setOperationMessage(
        `搜索完成：${projection.snapshot.addressCount} 个候选，${projection.snapshot.weakEvidenceCount} 个待核实结果。`,
      );
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return false;
      if (active && requestLifecycle === lifecycle) {
        searchHadError = true;
        showError(error);
        view.setSearchState("error");
        view.setOperationMessage("搜索失败，上次结果已保留。请检查授权或代理后重试。");
      }
      return false;
    } finally {
      captured = null;
      if (operationController === controller) operationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const createBatch = async () => {
    if (!active || destroyed || busy) return false;
    const snapshot = store.getState().crawl;
    if (snapshot.sources.length && addressOperations.size === 0) {
      view.setOperationalAvailability(false);
      view.setOperationMessage("操作地址已安全清理，需要重新搜索后才能创建批次。");
      return false;
    }
    const validation = view.validateCrawlDraft();
    if (!validation.valid) {
      view.refreshValidation("crawl", { announce: true });
      view.setOperationMessage(validation.reason);
      return false;
    }
    let payload;
    try {
      payload = buildCrawlPayload({
        snapshot,
        operations: addressOperations,
        ...view.readCrawlDraft(),
      });
    } catch (error) {
      view.refreshValidation("crawl", { announce: true });
      view.setOperationMessage("请修正标记项后再创建批次。");
      return false;
    }
    const operation = ++operationSequence;
    const requestLifecycle = lifecycle;
    const controller = new AbortController();
    operationController = controller;
    view.clearError();
    setBusy("crawl");
    view.setOperationMessage("正在创建批次，请勿重复提交……");
    let captured = payload;
    payload = null;
    try {
      const promise = api.post(CRAWL_ENDPOINTS.crawls, captured, {
        signal: controller.signal,
        idempotencyKey: true,
      });
      captured = null;
      view.clearOutputInput();
      const batch = await promise;
      if (!active || destroyed || controller.signal.aborted || requestLifecycle !== lifecycle ||
          operation !== operationSequence) return false;
      const batchId = typeof batch?.id === "string" ? batch.id : "";
      actions.setActiveBatchId(batchId);
      store.dispatch(actionCreators.batchSnapshotReceived(batch, { items: [] }));
      view.setOperationMessage("批次已创建，正在打开批次管理。");
      actions.navigateToApp("tasks");
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return false;
      if (active && requestLifecycle === lifecycle) showError(error);
      view.setOperationMessage("批次创建失败，当前选择和顺序已保留。请修正后重试。");
      return false;
    } finally {
      captured = null;
      view.clearOutputInput();
      if (operationController === controller) operationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const onSubmit = async (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    if (event.target.dataset.crawlForm === "search") {
      event.preventDefault();
      await runSearch();
    } else if (event.target.dataset.crawlForm === "submit") {
      event.preventDefault();
      await createBatch();
    }
  };

  const onPointerDown = (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-crawl-action="suggestion"]')) event.preventDefault();
  };

  const onClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-crawl-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.crawlAction;
    if (action === "suggestion") {
      chooseSuggestion(button.dataset.suggestionValue || "");
      return;
    }
    if (action === "open-vault") return actions.navigateToApp("vault");
    if (action === "open-proxy") return actions.navigateToApp("proxy");
    if (action === "source-activate") {
      view.setActiveSource(button.closest("[data-source-key]")?.dataset.sourceKey || "");
      return;
    }
    if (action === "select-visible") {
      const keys = view.visibleCandidateKeys();
      store.dispatch(actionCreators.crawlVisibleSelectionChanged(keys, true));
      return;
    }
    if (action === "clear-source-selection") {
      store.dispatch(actionCreators.crawlVisibleSelectionChanged(
        view.sourceCandidateKeys(view.activeSourceKey()),
        false,
      ));
      return;
    }
    if (action === "eh-clear") {
      store.dispatch(actionCreators.crawlEhFilterCleared());
      view.elements.ehTagQuery.value = "";
      view.setEhQuery("");
      return;
    }
    if (action === "eh-cycle") {
      const next = button.dataset.tagMode === "none"
        ? "include"
        : button.dataset.tagMode === "include"
          ? "exclude"
          : "";
      store.dispatch(actionCreators.crawlEhFilterChanged(button.dataset.tagKey || "", next));
      return;
    }
    const source = button.closest("[data-source-key]");
    const sourceKey = source?.dataset.sourceKey || "";
    if (action === "source-toggle") {
      const keys = view.sourceVisibleKeys(sourceKey);
      const snapshot = store.getState().crawl;
      const candidates = snapshot.sources.find((item) => item.key === sourceKey)?.addresses || [];
      const selectedByKey = new Map(candidates.map((item) => [item.key, item.selected]));
      const selected = keys.some((key) => !selectedByKey.get(key));
      store.dispatch(actionCreators.crawlVisibleSelectionChanged(keys, selected));
      return;
    }
    if (action === "source-up" || action === "source-down") {
      store.dispatch(actionCreators.crawlSourceMoved(sourceKey, action === "source-up" ? -1 : 1));
      return;
    }
    const candidateKey = button.closest("[data-candidate-key]")?.dataset.candidateKey || "";
    if (action === "candidate-up" || action === "candidate-down") {
      store.dispatch(actionCreators.crawlCandidateMoved(
        sourceKey,
        candidateKey,
        action === "candidate-up" ? -1 : 1,
      ));
    }
  };

  const onChange = (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.crawlCandidateToggle) {
      store.dispatch(actionCreators.crawlCandidateSelectionChanged(
        target.dataset.crawlCandidateToggle,
        target.checked,
      ));
      return;
    }
    if (target instanceof HTMLInputElement && target.matches("[data-crawl-weak-toggle]")) {
      store.dispatch(actionCreators.crawlWeakVisibilityChanged(target.checked));
      return;
    }
    if (
      (target instanceof HTMLSelectElement && (
        ["search-proxy", "crawl-proxy"].includes(target.name)
        || target.name.startsWith("source-")
      ))
      || (target instanceof HTMLInputElement && target.name === "crawl-site")
    ) {
      view.renderPreconditions();
    }
    if (target instanceof HTMLInputElement && target.name === "eh-image-mode") {
      const resample = target.value === "resample" && target.checked;
      view.elements.gpPolicy.disabled = resample;
      if (resample) view.elements.gpPolicy.value = "stop";
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
      view.refreshValidation("all");
    }
  };

  const onBeforeInput = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== "output-dir") return;
    const data = typeof event.data === "string" ? event.data : "";
    if (/[\u0000-\u001f\u007f]/.test(data)) target.dataset.crawlControlInvalid = "true";
  };

  const onInput = (event) => {
    const target = event.target;
    if (target === view.elements.keyword) requestAutocomplete();
    if (target === view.elements.ehTagQuery) view.setEhQuery(target.value);
    if (target instanceof HTMLInputElement && target.name === "output-dir" && !event.isTrusted) {
      if (/[\u0000-\u001f\u007f]/.test(target.value)) target.dataset.crawlControlInvalid = "true";
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLSelectElement) {
      view.refreshValidation("all");
    }
  };

  const onInvalid = (event) => {
    if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement)) return;
    event.preventDefault();
    view.handleInvalid(event.target);
  };

  const onFocusOut = (event) => {
    if (event.target !== view.elements.keyword && !view.elements.suggestions.contains(event.target)) return;
    stopFocusOut();
    focusOutTimer = setTimeout(() => {
      focusOutTimer = null;
      if (!active || destroyed) return;
      if (!view.elements.suggestions.contains(document.activeElement)
          && document.activeElement !== view.elements.keyword) view.hideSuggestions();
    }, 0);
  };

  const chooseSuggestion = (value) => {
    if (!value) return false;
    view.elements.keyword.value = value;
    view.hideSuggestions();
    view.elements.keyword.focus({ preventScroll: true });
    return true;
  };

  const onKeyDown = (event) => {
    const suggestionsOpen = !view.elements.suggestions.hidden;
    const inCombobox = event.target === view.elements.keyword
      || view.elements.suggestions.contains(event.target);
    if (!inCombobox) return;
    if (event.key === "Escape" && suggestionsOpen) {
      event.preventDefault();
      view.hideSuggestions();
      view.elements.keyword.focus({ preventScroll: true });
      return;
    }
    if (!suggestionsOpen) return;
    const command = {
      ArrowDown: "next",
      ArrowUp: "previous",
      Home: "first",
      End: "last",
    }[event.key];
    if (command) {
      event.preventDefault();
      view.moveSuggestionFocus(command);
      return;
    }
    if (event.key === "Enter") {
      const value = event.target instanceof HTMLElement
        ? event.target.dataset.suggestionValue || view.activeSuggestionValue()
        : view.activeSuggestionValue();
      if (value) {
        event.preventDefault();
        chooseSuggestion(value);
      }
    }
  };

  root.addEventListener("submit", onSubmit);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("beforeinput", onBeforeInput);
  root.addEventListener("input", onInput);
  root.addEventListener("invalid", onInvalid, true);
  root.addEventListener("focusout", onFocusOut);
  root.addEventListener("keydown", onKeyDown);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      lifecycle += 1;
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.setOperationalAvailability(
        store.getState().crawl.sources.length === 0 || addressOperations.size > 0,
      );
      view.renderPreconditions();
      view.refreshValidation("all");
      view.normalizeActiveSource();
      view.setSearchState(store.getState().crawl.sources.length ? "settled" : "initial");
      view.setOperationMessage(store.getState().crawl.sources.length
        ? "上次搜索结果已保留，可继续选择来源或重新搜索。"
        : "输入关键词并选择搜索来源。" );
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      lifecycle += 1;
      operationSequence += 1;
      stopAutocomplete();
      stopFocusOut();
      operationController?.abort();
      operationController = null;
      busy = "";
      view.setBusy("");
      view.hideSuggestions();
      view.clearOutputInput();
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      lifecycle += 1;
      operationSequence += 1;
      stopAutocomplete();
      stopFocusOut();
      operationController?.abort();
      addressOperations.clear();
      root.removeEventListener("submit", onSubmit);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      root.removeEventListener("beforeinput", onBeforeInput);
      root.removeEventListener("input", onInput);
      root.removeEventListener("invalid", onInvalid, true);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("keydown", onKeyDown);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("CRAWL.EXE 已挂载");
    controller = createCrawlController(context);
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
