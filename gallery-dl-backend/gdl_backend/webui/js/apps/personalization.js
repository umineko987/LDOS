import { setElementInert } from "../core/dom.js";
import { restoreDefaultPersonalizationPreferences } from "../core/personalization-model.js";
import { createPersonalizationView } from "../components/personalization-view.js";

const CLEAN_MESSAGE = "设置已保存。";
const DIRTY_MESSAGE = "有未应用的更改。";
const LIVE_DRAFT_CONTROL_SELECTOR = [
  "[data-personalization-scene]",
  "[data-personalization-motion]",
].join(", ");

function createPersonalizationController(context) {
  const { root, dialogs, personalization } = context;
  if (
    !personalization
    || typeof personalization.getState !== "function"
    || typeof personalization.preview !== "function"
    || typeof personalization.commit !== "function"
    || typeof personalization.cancel !== "function"
    || typeof personalization.subscribe !== "function"
  ) {
    throw new TypeError("外观设置缺少全局个性化运行时");
  }

  const view = createPersonalizationView(context);
  let active = false;
  let destroyed = false;
  let activeOperation = null;
  let operationSequence = 0;
  let lifecycleVersion = 0;

  const render = (state = personalization.getState()) => {
    try {
      view.renderState(state);
    } catch {
      try {
        view.elements.applyButton.disabled = true;
        view.setStatus("error", "无法显示部分设置，当前预览已保留。");
      } catch {
        // A partially detached view must not interrupt shell lifecycle cleanup.
      }
    }
    return state;
  };

  const hasUnappliedDraft = (state = personalization.getState()) => state.dirty === true;
  const operationBusy = () => (
    activeOperation !== null || personalization.getState().busy === true
  );

  const beginViewOperation = (kind) => {
    if (!active || destroyed || operationBusy()) return null;
    operationSequence += 1;
    const operation = Object.freeze({
      id: operationSequence,
      kind,
      lifecycle: lifecycleVersion,
    });
    activeOperation = operation;
    root.setAttribute("aria-busy", "true");
    view.setBusy(true);
    return operation;
  };

  const operationIsCurrent = (operation) => (
    active
    && !destroyed
    && activeOperation === operation
    && operation.lifecycle === lifecycleVersion
  );

  const finishViewOperation = (operation) => {
    if (!operationIsCurrent(operation)) return false;
    activeOperation = null;
    root.removeAttribute("aria-busy");
    view.setBusy(false);
    return true;
  };

  const invalidateViewOperations = () => {
    lifecycleVersion += 1;
    activeOperation = null;
    root.removeAttribute("aria-busy");
    view.setBusy(false);
  };

  const showDraftStatus = (state, message = "") => {
    view.setStatus(
      state.dirty ? "dirty" : "clean",
      message || (state.dirty ? DIRTY_MESSAGE : CLEAN_MESSAGE),
    );
  };

  let runtimeWasBusy = personalization.getState().busy === true;
  const unsubscribe = personalization.subscribe((state) => {
    if (active && !destroyed) {
      render(state);
      if (runtimeWasBusy && !state.busy && activeOperation === null) {
        showDraftStatus(state);
      }
    }
    runtimeWasBusy = state.busy === true;
  });

  const previewFormDraft = () => {
    if (!active || destroyed || operationBusy()) return null;
    try {
      const current = personalization.getState();
      const next = personalization.preview(view.readDraft(current.draft));
      render(next);
      showDraftStatus(next);
      return next;
    } catch {
      const restored = render(personalization.getState());
      view.setStatus(
        "error",
        restored.dirty
          ? "设置值无效，已保留上次预览。"
          : "设置值无效，当前设置未改变。",
      );
      return null;
    }
  };

  const cancelDraft = (message = "未应用的更改已取消，设置已恢复。") => {
    if (destroyed) return false;
    let state;
    try {
      state = personalization.cancel();
    } catch {
      state = personalization.getState();
      if (active) {
        render(state);
        view.setStatus("error", "无法清除草稿，当前设置已保留，请稍后重试。");
      }
      return false;
    }
    if (active) {
      render(state);
      view.setStatus("clean", message);
    }
    return true;
  };

  const restoreDefaults = () => {
    if (!active || destroyed || operationBusy()) return;
    let state;
    try {
      state = personalization.preview(restoreDefaultPersonalizationPreferences());
    } catch {
      state = render();
      view.setStatus("error", "无法预览默认设置，当前草稿已保留。");
      view.focusAfter("reset");
      return;
    }
    render(state);
    showDraftStatus(
      state,
      state.dirty
        ? "已预览默认设置，点击“应用”后保存。"
        : "当前已经使用默认设置。",
    );
    view.focusAfter("reset");
  };

  const applyDraft = async () => {
    if (!active || destroyed || operationBusy() || !personalization.getState().dirty) return;
    const operation = beginViewOperation("apply");
    if (!operation) return;
    view.setStatus("saving", "正在保存设置，请勿重复提交……");

    await Promise.resolve();
    if (!operationIsCurrent(operation)) return;
    let result;
    try {
      result = await personalization.commit();
    } catch {
      result = Object.freeze({
        ok: false,
        message: "无法保存设置，原设置未改变。",
        state: personalization.getState(),
      });
    }
    if (!operationIsCurrent(operation)) return;
    finishViewOperation(operation);
    render(result.state);
    view.setStatus(result.ok ? "success" : "error", result.message);
    view.focusAfter("apply");
  };

  let discardRequest = null;
  const confirmDiscard = (purpose) => {
    if (discardRequest) return discardRequest;
    if (operationBusy()) {
      view.setStatus("saving", "设置正在保存，完成前无法离开外观设置。");
      return Promise.resolve(false);
    }
    if (!hasUnappliedDraft()) return Promise.resolve(true);

    const request = (async () => {
      let choice = "cancel";
      try {
        choice = await dialogs?.open?.({
          title: "放弃未应用的外观设置？",
          message: `当前场景或动效尚未应用。${purpose}后将放弃这些更改。`,
          confirmLabel: "放弃更改并离开",
          dangerous: true,
          confirmationText: "确认后将恢复上次保存的设置，未应用内容不会写入浏览器存储。",
        }) ?? "cancel";
      } catch {
        choice = "cancel";
      }
      if (choice !== "confirm" || !active || destroyed) {
        if (active && !destroyed) {
          view.setStatus("dirty", "已取消离开，未应用的更改继续保留。");
        }
        return false;
      }
      return cancelDraft("已放弃未应用的更改，设置已恢复。");
    })();
    const trackedRequest = request.finally(() => {
      if (discardRequest === trackedRequest) discardRequest = null;
    });
    discardRequest = trackedRequest;
    return trackedRequest;
  };

  const onChange = (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.matches(LIVE_DRAFT_CONTROL_SELECTOR)) previewFormDraft();
  };

  const onClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-personalization-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.personalizationAction;
    if (action === "cancel") {
      cancelDraft();
      view.focusAfter("cancel");
    } else if (action === "reset") {
      restoreDefaults();
    }
  };

  const onSubmit = (event) => {
    if (!(event.target instanceof HTMLFormElement) || event.target !== view.elements.form) return;
    event.preventDefault();
    void applyDraft();
  };

  const onBeforeUnload = (event) => {
    if (!active || (!hasUnappliedDraft() && !operationBusy())) return;
    event.preventDefault();
    event.returnValue = "";
  };

  const onWorkspaceKeyDown = (event) => {
    if (event.target !== view.elements.workspace) return;
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    view.scrollWorkspace(direction);
  };

  root.addEventListener("change", onChange);
  root.addEventListener("click", onClick);
  root.addEventListener("keydown", onWorkspaceKeyDown);
  root.addEventListener("submit", onSubmit);
  globalThis.addEventListener?.("beforeunload", onBeforeUnload);
  render();

  return Object.freeze({
    beforeLeave() {
      return confirmDiscard("切换应用");
    },
    beforeWindowHide(visibility) {
      return confirmDiscard(visibility === "closed" ? "关闭窗口" : "最小化窗口");
    },
    activate() {
      if (destroyed || active) return;
      lifecycleVersion += 1;
      active = true;
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      let state;
      try {
        state = personalization.cancel();
      } catch {
        state = personalization.getState();
      }
      render(state);
      view.setBusy(false);
      view.setStatus(state.busy ? "saving" : "clean", state.busy
        ? "正在完成上一项操作的清理……"
        : CLEAN_MESSAGE);
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      invalidateViewOperations();
      dialogs?.destroy?.();
      try {
        render(personalization.cancel());
      } catch {
        // The global runtime may already be tearing down with the page.
      }
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    destroy() {
      if (destroyed) return;
      active = false;
      invalidateViewOperations();
      dialogs?.destroy?.();
      try {
        personalization.cancel();
      } catch {
        // Page teardown only needs to stop propagating the draft.
      }
      destroyed = true;
      unsubscribe();
      root.removeEventListener("change", onChange);
      root.removeEventListener("click", onClick);
      root.removeEventListener("keydown", onWorkspaceKeyDown);
      root.removeEventListener("submit", onSubmit);
      globalThis.removeEventListener?.("beforeunload", onBeforeUnload);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("外观设置已挂载");
    controller = createPersonalizationController(context);
  },
  activate() {
    controller?.activate();
  },
  beforeLeave() {
    return controller?.beforeLeave() ?? true;
  },
  beforeWindowHide(_context, visibility) {
    return controller?.beforeWindowHide(visibility) ?? true;
  },
  deactivate() {
    controller?.deactivate();
  },
  unmount() {
    controller?.destroy();
    controller = null;
  },
});
