import {
  APPLICATION_DEFINITIONS,
  APPLICATION_GROUPS,
  getApplicationDefinition,
  type ApplicationDefinition,
  type ApplicationId,
} from "../applications/definitions";
import {
  POLLING_SCOPE_STATES,
  type PollingLifecycleSource,
  type PollingScopeState,
} from "../polling/service";
import type { ShellState, ShellStore, WindowRecord } from "./shell";

export interface ApplicationGroupProjection {
  readonly id: string;
  readonly title: string;
  readonly applications: readonly ApplicationDefinition[];
}

export type DockItemState = "launcher" | "closed" | "focused" | "background" | "minimized";
export type DockActivation = "open-center" | "open" | "minimize" | "focus" | "restore";

export interface DockItemProjection {
  readonly key: string;
  readonly appId: ApplicationId | null;
  readonly title: string;
  readonly icon: ApplicationDefinition["icon"] | "grid";
  readonly state: DockItemState;
  readonly stateLabel: string;
  readonly activation: DockActivation;
  readonly ariaLabel: string;
}

export interface DockProjection {
  readonly items: readonly DockItemProjection[];
  readonly visible: readonly DockItemProjection[];
  readonly overflow: readonly DockItemProjection[];
}

export interface WindowMenuProjection {
  readonly appId: ApplicationId;
  readonly title: string;
  readonly command: "minimize" | "focus" | "restore";
  readonly checked: boolean;
  readonly description: string;
}

const DOCK_STATE_LABELS = Object.freeze({
  closed: "已关闭",
  focused: "当前聚焦",
  background: "正在后台运行",
  minimized: "已最小化",
} as const);

export function deriveApplicationGroups(): readonly ApplicationGroupProjection[] {
  return Object.freeze(APPLICATION_GROUPS.map((group) => Object.freeze({
    id: group.id,
    title: group.title,
    applications: Object.freeze(APPLICATION_DEFINITIONS
      .filter((definition) => definition.group === group.id)
      .toSorted((left, right) => left.order - right.order)),
  })));
}

function dockItem(definition: ApplicationDefinition, record: WindowRecord | null, focusedAppId: ApplicationId | null): DockItemProjection {
  const state = record === null
    ? "closed"
    : record.state === "minimized"
      ? "minimized"
      : record.appId === focusedAppId
        ? "focused"
        : "background";
  const activation: Exclude<DockActivation, "open-center"> = {
    closed: "open",
    focused: "minimize",
    background: "focus",
    minimized: "restore",
  }[state] as Exclude<DockActivation, "open-center">;
  const action = {
    open: "打开应用",
    minimize: "最小化窗口",
    focus: "聚焦窗口",
    restore: "恢复窗口",
  }[activation];
  return Object.freeze({
    key: `app:${definition.id}`,
    appId: definition.id,
    title: definition.title,
    icon: definition.icon,
    state,
    stateLabel: DOCK_STATE_LABELS[state],
    activation,
    ariaLabel: `${definition.title}，${DOCK_STATE_LABELS[state]}；${action}`,
  });
}

export function deriveDockProjection(state: ShellState, visibleLimit = 6): DockProjection {
  if (!Number.isInteger(visibleLimit) || visibleLimit < 1) throw new TypeError("invalid_dock_limit");
  const records = new Map(state.windows.map((record) => [record.appId, record]));
  const fixed = APPLICATION_DEFINITIONS
    .filter((definition) => definition.dockOrder !== null)
    .toSorted((left, right) => left.dockOrder! - right.dockOrder!);
  const fixedIds = new Set<ApplicationId>(fixed.map(({ id }) => id));
  const dynamic = state.windows
    .filter(({ appId }) => !fixedIds.has(appId))
    .map(({ appId }) => getApplicationDefinition(appId));
  const applications = [...fixed, ...dynamic];
  const items = Object.freeze([
    Object.freeze({
      key: "application-center",
      appId: null,
      title: "应用中心",
      icon: "grid",
      state: "launcher",
      stateLabel: "打开应用中心",
      activation: "open-center",
      ariaLabel: "应用中心；打开全部应用列表",
    } as const),
    ...applications.map((definition) => dockItem(
      definition,
      records.get(definition.id) ?? null,
      state.focusedAppId,
    )),
  ]);
  return Object.freeze({
    items,
    visible: Object.freeze(items.slice(0, visibleLimit)),
    overflow: Object.freeze(items.slice(visibleLimit)),
  });
}

export function deriveWindowMenu(state: ShellState): readonly WindowMenuProjection[] {
  return Object.freeze(state.windows.map((record) => {
    const definition = getApplicationDefinition(record.appId);
    const minimized = record.state === "minimized";
    const focused = !minimized && record.appId === state.focusedAppId;
    return Object.freeze({
      appId: record.appId,
      title: definition.title,
      command: minimized ? "restore" : focused ? "minimize" : "focus",
      checked: focused,
      description: minimized ? "已最小化" : focused ? "当前窗口" : "后台窗口",
    });
  }));
}

function pollingScope(appId: ApplicationId | null): string | null {
  return appId === null ? null : `app:${appId}`;
}

function pollingState(state: ShellState, scope: string): PollingScopeState {
  if (!scope.startsWith("app:")) return POLLING_SCOPE_STATES.UNMANAGED;
  const application = getApplicationDefinition(scope.slice(4));
  if (!application) return POLLING_SCOPE_STATES.UNMANAGED;
  const record = state.windows.find(({ appId }) => appId === application.id);
  if (!record) return POLLING_SCOPE_STATES.CLOSED;
  return record.state === "minimized" ? POLLING_SCOPE_STATES.MINIMIZED : POLLING_SCOPE_STATES.OPEN;
}

function pollingSnapshot(state: ShellState): string {
  return `${state.focusedAppId ?? ""}|${state.windows.map(({ appId, state: windowState }) => `${appId}:${windowState}`).join(",")}`;
}

export function createShellPollingLifecycleSource(shell: ShellStore): PollingLifecycleSource {
  return Object.freeze({
    getFocusedScope: () => pollingScope(shell.getState().focusedAppId),
    getScopeState: (scope: string) => pollingState(shell.getState(), scope),
    subscribe(listener: () => void) {
      let previous = pollingSnapshot(shell.getState());
      return shell.subscribe((state) => {
        const next = pollingSnapshot(state);
        if (next === previous) return;
        previous = next;
        listener();
      });
    },
  });
}
