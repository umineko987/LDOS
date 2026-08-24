import { describe, expect, it, vi } from "vitest";

import type { PersistenceService } from "../../core/persistence/service";
import { AUTOCOMPLETE_DELAY_MS, sanitizeCrawlSearchResponse, type CrawlDraft, type SearchDraft } from "./model";
import { createCrawlController } from "./controller";
import type { CrawlService } from "./service";
import { createCrawlStore } from "./state";

class ManualTimers {
  private nextId = 1;
  readonly timers = new Map<number, () => void>();
  readonly setTimeout = (callback: () => void): ReturnType<typeof globalThis.setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, callback);
    return id as unknown as ReturnType<typeof globalThis.setTimeout>;
  };
  readonly clearTimeout = (handle: ReturnType<typeof globalThis.setTimeout>): void => {
    this.timers.delete(handle as unknown as number);
  };
  run(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const callback of pending) callback();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function rawSearch() {
  return {
    sources: [{
      site: "danbooru",
      status: "succeeded",
      addresses: [{
        id: "one",
        label: "One",
        address_type: "artist_tag",
        url: "https://danbooru.donmai.us/posts?tags=one",
      }],
      weak_evidence: [],
    }],
  };
}

const searchDraft: SearchDraft = {
  keyword: "stage 4",
  sites: ["danbooru"],
  limit: 20,
  proxyMode: "required",
  sourceProxyModes: {},
};
const crawlDraft: CrawlDraft = {
  concurrency: 20,
  maxTasks: 10_000,
  proxyMode: "required",
  outputDir: "/transient/user/input",
  sourceProxyModes: {},
  ehDownload: { image_mode: "original", gp_policy: "stop" },
};

function harness(overrides: Partial<CrawlService> = {}) {
  const timers = new ManualTimers();
  const projection = sanitizeCrawlSearchResponse(rawSearch());
  const service = {
    autocomplete: vi.fn(async () => []),
    search: vi.fn(async () => projection),
    create: vi.fn(async () => ({ id: "batch:stage4" })),
    ...overrides,
  } as CrawlService;
  const store = createCrawlStore();
  const persistence = { writeActiveBatchId: vi.fn(() => true) } as unknown as PersistenceService;
  const onNavigate = vi.fn();
  const controller = createCrawlController({
    store,
    service,
    persistence,
    onNavigate,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });
  return { timers, projection, service, store, persistence, onNavigate, controller };
}

describe("Crawl controller lifecycle", () => {
  it("debounces autocomplete, aborts stale work, and commits only the latest sanitized result", async () => {
    const first = deferred<readonly never[]>();
    const second = deferred<readonly never[]>();
    const signals: AbortSignal[] = [];
    const autocomplete = vi.fn((_query: string, signal: AbortSignal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : second.promise;
    });
    const runtime = harness({ autocomplete });
    runtime.controller.activate();
    expect(runtime.controller.requestAutocomplete("first")).toBe(true);
    expect(runtime.timers.timers.size).toBe(1);
    runtime.timers.run();
    await flush();
    expect(autocomplete).toHaveBeenCalledWith("first", expect.any(AbortSignal));
    runtime.controller.requestAutocomplete("second");
    expect(signals[0].aborted).toBe(true);
    runtime.timers.run();
    await flush();
    second.resolve([]);
    first.resolve([]);
    await flush();
    expect(runtime.store.getState().suggestions).toEqual([]);
    expect(AUTOCOMPLETE_DELAY_MS).toBe(300);
    runtime.controller.destroy();
  });

  it("commits one successful search and keeps raw operations outside state", async () => {
    const runtime = harness();
    const listener = vi.fn();
    runtime.store.subscribe(listener);
    runtime.controller.activate();
    listener.mockClear();
    await expect(runtime.controller.search(searchDraft)).resolves.toBe(true);
    expect(runtime.service.search).toHaveBeenCalledWith(searchDraft, expect.any(AbortSignal));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(runtime.controller.hasOperationalAddresses()).toBe(true);
    expect(JSON.stringify(runtime.store.getState())).not.toContain("danbooru.donmai.us/posts");
    runtime.controller.destroy();
  });

  it("creates once after selection, uses the authority response, persists the batch, and navigates", async () => {
    const created = deferred<Readonly<{ id: string }>>();
    const create = vi.fn((
      _snapshot: Parameters<CrawlService["create"]>[0],
      _operations: Parameters<CrawlService["create"]>[1],
      _draft: Parameters<CrawlService["create"]>[2],
      _signal: AbortSignal,
    ) => created.promise);
    const runtime = harness({ create });
    runtime.controller.activate();
    await runtime.controller.search(searchDraft);
    runtime.store.setCandidateSelected("candidate:danbooru:one", true);
    const pending = runtime.controller.create(crawlDraft);
    const duplicate = runtime.controller.create(crawlDraft);
    await flush();
    expect(create).toHaveBeenCalledOnce();
    await expect(duplicate).resolves.toBe(false);
    const [snapshot, operations, draft, signal] = create.mock.calls[0];
    expect(snapshot.candidates["candidate:danbooru:one"].selected).toBe(true);
    expect(operations.get("candidate:danbooru:one")?.url).toContain("danbooru.donmai.us");
    expect(draft.outputDir).toBe("/transient/user/input");
    expect(signal).toBeInstanceOf(AbortSignal);
    created.resolve({ id: "batch:stage4" });
    await expect(pending).resolves.toBe(true);
    expect(runtime.persistence.writeActiveBatchId).toHaveBeenCalledWith("batch:stage4");
    expect(runtime.onNavigate).toHaveBeenCalledWith("tasks");
    runtime.controller.destroy();
  });

  it("preserves the last authority on failure and isolates a stale search after destroy", async () => {
    const pendingSearch = deferred<ReturnType<typeof sanitizeCrawlSearchResponse>>();
    const search = vi.fn((_draft: SearchDraft, _signal: AbortSignal) => pendingSearch.promise);
    const runtime = harness({ search });
    runtime.controller.activate();
    const pending = runtime.controller.search(searchDraft);
    await flush();
    const signal = search.mock.calls[0][1] as AbortSignal;
    runtime.controller.destroy();
    expect(signal.aborted).toBe(true);
    pendingSearch.resolve(runtime.projection);
    await expect(pending).resolves.toBe(false);
    expect(runtime.store.getState().sourceOrder).toEqual([]);

    const failed = harness({
      search: vi.fn(async () => { throw Object.assign(new Error("/private/secret"), {
        status: 503,
        code: "proxy_pool_unavailable",
      }); }),
    });
    failed.controller.activate();
    await expect(failed.controller.search(searchDraft)).resolves.toBe(false);
    expect(failed.store.getState()).toMatchObject({
      phase: "error",
      error: { code: "proxy_pool_unavailable", targetApp: "proxy" },
    });
    expect(JSON.stringify(failed.store.getState())).not.toContain("/private/secret");
    failed.controller.destroy();
  });

  it("returns timer, request, operation URL, and listeners to baseline across 20 cycles", async () => {
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const request = deferred<ReturnType<typeof sanitizeCrawlSearchResponse>>();
      let signal: AbortSignal | null = null;
      const runtime = harness({
        search: vi.fn((_draft, currentSignal) => {
          signal = currentSignal;
          return request.promise;
        }),
      });
      runtime.controller.activate();
      runtime.controller.requestAutocomplete("queued");
      void runtime.controller.search(searchDraft);
      await flush();
      runtime.controller.destroy();
      expect(runtime.timers.timers.size).toBe(0);
      expect((signal as AbortSignal | null)?.aborted).toBe(true);
      expect(runtime.controller.hasOperationalAddresses()).toBe(false);
      request.resolve(runtime.projection);
      await flush();
    }
  });
});
