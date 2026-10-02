import type { ApiClient } from "../../src/core/api/client";
import { createPersistenceAdapter } from "../../src/core/persistence/adapter";
import { createPersistenceService } from "../../src/core/persistence/service";
import type { PollingService } from "../../src/core/polling/service";
import { createShellStore } from "../../src/core/state/shell";

export function createDesktopRuntime() {
  const persistence = createPersistenceService(createPersistenceAdapter({
    localStorage: null,
    sessionStorage: null,
  }));
  return {
    shell: createShellStore({ persistence }),
    persistence,
    api: Object.freeze({}) as ApiClient,
    polling: Object.freeze({}) as PollingService,
  };
}
