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
  const { root } = context;
  const source = adapterContract(adapter);
  let state = initialState ? projectScheduleState(initialState) : projectScheduleState({ phase: "unavailable" });
  let uiState = createScheduleUiState();
  let active = false;
  let destroyed = false;
  let lifecycle = 0;
  const view = createView(context);
  if (!view || typeof view !== "object" || typeof view.render !== "function") throw new TypeError("定时任务视图无效");

  const render = () => view.render(state, uiState);
  const setState = (next) => {
    state = projectScheduleState(next);
    if (state.phase === "content") {
      const id = state.plans.some((plan) => plan.id === uiState.selectedId) ? uiState.selectedId : state.plans[0].id;
      uiState = selectSchedulePlan(state, id);
    } else uiState = createScheduleUiState();
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

  const onClick = (event) => {
    if (!active || destroyed || !(event.target instanceof Element)) return;
    const target = event.target.closest("[data-schedule-action]");
    if (!(target instanceof HTMLButtonElement) || target.disabled) return;
    const action = target.dataset.scheduleAction;
    if (action === "select") {
      uiState = selectSchedulePlan(state, target.dataset.schedulePlanId);
      render();
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

  root.addEventListener("click", onClick);
  root.addEventListener("input", onDraftInput);
  root.addEventListener("change", onDraftInput);
  root.addEventListener("submit", onSubmit);

  return Object.freeze({
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
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onDraftInput);
      root.removeEventListener("change", onDraftInput);
      root.removeEventListener("submit", onSubmit);
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
  deactivate() { controller?.deactivate(); },
  unmount() { controller?.destroy(); controller = null; },
});
