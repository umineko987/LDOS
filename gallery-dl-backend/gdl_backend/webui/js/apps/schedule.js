import { setElementInert } from "../core/dom.js";
import {
  createScheduleUiState,
  createScheduleUnavailableAdapter,
  projectScheduleState,
  resetScheduleDraft,
  selectSchedulePlan,
  updateScheduleDraft,
} from "../core/schedule-model.js";
import { createScheduleView } from "../components/schedule-view.js";

function adapterContract(adapter) {
  if (!adapter || typeof adapter !== "object" || Array.isArray(adapter) || typeof adapter.read !== "function") throw new TypeError("定时任务适配器无效");
  return adapter;
}

export function createScheduleController(context, {
  adapter = createScheduleUnavailableAdapter(),
  createView = createScheduleView,
  initialState = null,
} = {}) {
  const { root, dialogs } = context;
  const source = adapterContract(adapter);
  let state = initialState ? projectScheduleState(initialState) : projectScheduleState({ phase: "unavailable" });
  let uiState = createScheduleUiState();
  let active = false;
  let destroyed = false;
  let lifecycle = 0;
  let discardRequest = null;
  const view = createView(context);
  if (!view || typeof view !== "object" || typeof view.render !== "function") throw new TypeError("定时任务视图无效");

  const render = () => view.render(state, uiState);
  const cleanUiState = () => {
    if (state.phase !== "content") return createScheduleUiState();
    const id = state.plans.some((plan) => plan.id === uiState.selectedId)
      ? uiState.selectedId
      : state.plans[0].id;
    return selectSchedulePlan(state, id);
  };
  const setState = (next) => {
    state = projectScheduleState(next);
    uiState = cleanUiState();
    render();
    return state;
  };
  const read = async () => {
    const ticket = lifecycle;
    const next = await source.read();
    if (!active || destroyed || ticket !== lifecycle) return false;
    setState(next);
    return true;
  };
  const fieldValue = (control) => control.dataset.scheduleField === "concurrency" ? Number(control.value) : control.value;

  const confirmDiscard = (purpose) => {
    if (discardRequest) return discardRequest;
    if (!uiState.dirty) return Promise.resolve(true);
    const requestLifecycle = lifecycle;
    const request = (async () => {
      let choice = "cancel";
      try {
        choice = await dialogs?.open?.({
          title: "放弃未保存的计划草稿？",
          message: `当前计划有未保存的更改，${purpose}后将丢失。`,
          confirmLabel: "放弃草稿并继续",
          dangerous: true,
          confirmationText: "正式后端尚未接入；本操作只清除当前本地预览草稿，不发送业务请求。",
        }) ?? "cancel";
      } catch {
        choice = "cancel";
      }
      if (choice !== "confirm" || !active || destroyed || requestLifecycle !== lifecycle) return false;
      uiState = cleanUiState();
      render();
      return true;
    })();
    const trackedRequest = request.finally(() => {
      if (discardRequest === trackedRequest) discardRequest = null;
    });
    discardRequest = trackedRequest;
    return trackedRequest;
  };

  const onClick = (event) => {
    if (!active || destroyed || !(event.target instanceof Element)) return;
    const target = event.target.closest("[data-schedule-action]");
    if (!(target instanceof HTMLButtonElement) || target.disabled) return;
    const action = target.dataset.scheduleAction;
    if (action === "select") {
      const planId = target.dataset.schedulePlanId;
      if (planId === uiState.selectedId) return;
      void (async () => {
        if (uiState.dirty && !await confirmDiscard("切换计划")) return;
        if (!active || destroyed) return;
        uiState = selectSchedulePlan(state, planId);
        render();
      })();
    } else if (action === "reset" && uiState.selectedId) {
      uiState = resetScheduleDraft(state, uiState);
      render();
    }
  };
  const onDraftInput = (event) => {
    if (!active || destroyed || !uiState.selectedId || !(event.target instanceof HTMLElement)) return;
    const field = event.target.dataset.scheduleField;
    if (!field) return;
    uiState = updateScheduleDraft(state, uiState, { [field]: fieldValue(event.target) });
    render();
    const replacement = root.querySelector(`[data-schedule-field="${field}"]`);
    replacement?.focus({ preventScroll: true });
  };
  const onSubmit = (event) => {
    if (!(event.target instanceof HTMLFormElement) || event.target !== view.elements.editor) return;
    event.preventDefault();
  };
  const onBeforeUnload = (event) => {
    if (!active || !uiState.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };

  root.addEventListener("click", onClick);
  root.addEventListener("input", onDraftInput);
  root.addEventListener("change", onDraftInput);
  root.addEventListener("submit", onSubmit);
  globalThis.addEventListener?.("beforeunload", onBeforeUnload);

  return Object.freeze({
    beforeLeave() {
      return confirmDiscard("切换应用");
    },
    beforeWindowHide(visibility) {
      return confirmDiscard(visibility === "closed" ? "关闭窗口" : "最小化窗口");
    },
    activate() {
      if (destroyed || active) return;
      active = true;
      lifecycle += 1;
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      render();
      void read().catch(() => {
        if (active && !destroyed) setState({ phase: "error", error: { code: "adapter_failed", status: 0, requestId: "", category: "capability" } });
      });
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      lifecycle += 1;
      discardRequest = null;
      dialogs?.destroy?.();
      uiState = cleanUiState();
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    setState,
    getState: () => state,
    getUiState: () => uiState,
    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      lifecycle += 1;
      discardRequest = null;
      dialogs?.destroy?.();
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onDraftInput);
      root.removeEventListener("change", onDraftInput);
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
    if (controller) throw new Error("定时任务已挂载");
    controller = createScheduleController(context);
  },
  activate() { controller?.activate(); },
  beforeLeave() { return controller?.beforeLeave() ?? true; },
  beforeWindowHide(_context, visibility) { return controller?.beforeWindowHide(visibility) ?? true; },
  deactivate() { controller?.deactivate(); },
  unmount() { controller?.destroy(); controller = null; },
});
