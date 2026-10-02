import { getApplicationDefinition } from "../applications/definitions";
import {
  POLLING_SCOPE_STATES,
  type PollingLifecycleSource,
  type PollingScopeState,
} from "../polling/service";
import type { ShellState, ShellStore } from "./shell";

function pollingState(state: ShellState, scope: string): PollingScopeState {
  if (!scope.startsWith("app:")) return POLLING_SCOPE_STATES.UNMANAGED;
  const application = getApplicationDefinition(scope.slice(4));
  if (!application) return POLLING_SCOPE_STATES.UNMANAGED;
  if (!state.openedAppIds.includes(application.id)) return POLLING_SCOPE_STATES.CLOSED;
  return state.focusedAppId === application.id ? POLLING_SCOPE_STATES.OPEN : POLLING_SCOPE_STATES.MINIMIZED;
}

export function createShellPollingLifecycleSource(shell: ShellStore): PollingLifecycleSource {
  return Object.freeze({
    getFocusedScope: () => {
      const { focusedAppId } = shell.getState();
      return focusedAppId === null ? null : `app:${focusedAppId}`;
    },
    getScopeState: (scope: string) => pollingState(shell.getState(), scope),
    subscribe(listener: () => void) {
      let previous = shell.getState();
      return shell.subscribe((state) => {
        if (state === previous) return;
        previous = state;
        listener();
      });
    },
  });
}
