import type { ApplicationId } from "../../core/applications/definitions";
import type { PersistenceService } from "../../core/persistence/service";
import {
  AUTOCOMPLETE_DELAY_MS,
  crawlErrorPresentation,
  validateCrawlDraft,
  validateSearchDraft,
  type CrawlCandidateKey,
  type CrawlDraft,
  type CrawlOperation,
  type SearchDraft,
} from "./model";
import type { CrawlService } from "./service";
import type { CrawlStore } from "./state";

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;
type SetTimeout = (callback: () => void, delay: number) => TimerHandle;
type ClearTimeout = (handle: TimerHandle) => void;

export interface CrawlController {
  activate(): void;
  requestAutocomplete(query: string): boolean;
  search(draft: SearchDraft): Promise<boolean>;
  create(draft: CrawlDraft): Promise<boolean>;
  hasOperationalAddresses(): boolean;
  destroy(): void;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

export function createCrawlController({
  store,
  service,
  persistence,
  onNavigate,
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
}: {
  readonly store: CrawlStore;
  readonly service: CrawlService;
  readonly persistence: PersistenceService;
  readonly onNavigate: (appId: ApplicationId) => void;
  readonly setTimeoutFn?: SetTimeout;
  readonly clearTimeoutFn?: ClearTimeout;
}): CrawlController {
  let active = false;
  let destroyed = false;
  let autocompleteTimer: TimerHandle | null = null;
  let autocompleteController: AbortController | null = null;
  let operationController: AbortController | null = null;
  let autocompleteVersion = 0;
  let operationVersion = 0;
  let autocompleteQuery = "";
  let operations = new Map<CrawlCandidateKey, CrawlOperation>();

  const stopAutocomplete = (): void => {
    if (autocompleteTimer !== null) clearTimeoutFn(autocompleteTimer);
    autocompleteTimer = null;
    autocompleteController?.abort();
    autocompleteController = null;
    autocompleteVersion += 1;
  };

  const requestAutocomplete = (query: string): boolean => {
    stopAutocomplete();
    autocompleteQuery = query.trim();
    if (!active || destroyed || autocompleteQuery.length < 2 || autocompleteQuery.length > 200) {
      store.setSuggestions([]);
      return false;
    }
    const requested = autocompleteQuery;
    const version = autocompleteVersion;
    autocompleteTimer = setTimeoutFn(() => {
      autocompleteTimer = null;
      const controller = new AbortController();
      autocompleteController = controller;
      void service.autocomplete(requested, controller.signal)
        .then((suggestions) => {
          if (
            !active
            || destroyed
            || controller.signal.aborted
            || version !== autocompleteVersion
            || requested !== autocompleteQuery
          ) return;
          store.setSuggestions(suggestions);
        })
        .catch((error: unknown) => {
          if (!isAbortError(error) && version === autocompleteVersion && active && !destroyed) {
            store.setSuggestions([]);
          }
        })
        .finally(() => {
          if (autocompleteController === controller) autocompleteController = null;
        });
    }, AUTOCOMPLETE_DELAY_MS);
    return true;
  };

  const search = async (draft: SearchDraft): Promise<boolean> => {
    if (!active || destroyed || store.getState().busy) return false;
    const checked = validateSearchDraft(draft);
    if (!checked.valid) {
      store.setMessage(checked.reason);
      return false;
    }
    stopAutocomplete();
    operationController?.abort();
    const controller = new AbortController();
    const version = ++operationVersion;
    operationController = controller;
    if (!store.beginSearch()) return false;
    try {
      const projection = await service.search(draft, controller.signal);
      if (!active || destroyed || controller.signal.aborted || version !== operationVersion) return false;
      operations = new Map(projection.operations);
      return store.commitSearch(projection.snapshot);
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || version !== operationVersion) {
        return false;
      }
      store.failSearch(crawlErrorPresentation(error));
      return false;
    } finally {
      if (operationController === controller) operationController = null;
    }
  };

  const create = async (draft: CrawlDraft): Promise<boolean> => {
    if (!active || destroyed || store.getState().busy) return false;
    const checked = validateCrawlDraft(draft);
    if (!checked.valid) {
      store.setMessage(checked.reason);
      return false;
    }
    if (store.getState().sourceOrder.length && operations.size === 0) {
      store.setOperationalAvailable(false);
      return false;
    }
    if (!store.beginCreate()) return false;
    stopAutocomplete();
    operationController?.abort();
    const controller = new AbortController();
    const version = ++operationVersion;
    operationController = controller;
    try {
      const batch = await service.create(store.getState(), operations, draft, controller.signal);
      if (!active || destroyed || controller.signal.aborted || version !== operationVersion) return false;
      persistence.writeActiveBatchId(batch.id);
      store.finishCreate("批次已创建，正在打开批次管理。");
      onNavigate("tasks");
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active || destroyed || version !== operationVersion) {
        return false;
      }
      store.failCreate(crawlErrorPresentation(error));
      return false;
    } finally {
      if (operationController === controller) operationController = null;
    }
  };

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      store.setOperationalAvailable(store.getState().sourceOrder.length === 0 || operations.size > 0);
    },
    requestAutocomplete,
    search,
    create,
    hasOperationalAddresses: () => operations.size > 0,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      operationVersion += 1;
      stopAutocomplete();
      operationController?.abort();
      operationController = null;
      operations.clear();
      store.destroy();
    },
  });
}
