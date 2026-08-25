import { describe, expect, it, vi } from "vitest";

import budgetContract from "./fixtures/p0-performance-budget.json";
import type { PersistenceService } from "../src/core/persistence/service";
import type { PollingHandle, PollingRegistration, PollingService } from "../src/core/polling/service";
import { createTasksController } from "../src/apps/tasks/controller";
import {
  TASK_PAGE_LIMIT,
  sanitizeBatchSummary,
  sanitizeTaskPage,
  type TasksAuthoritySnapshot,
} from "../src/apps/tasks/model";
import type { TasksService } from "../src/apps/tasks/service";
import { createTasksStore } from "../src/apps/tasks/state";
import tasksSource from "../src/apps/tasks/Tasks.svelte?raw";

function rawTasks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-target-${index}`,
    site: "pixiv",
    status: "running",
    sequence_no: index,
  }));
}

function snapshot(): TasksAuthoritySnapshot {
  const query = { batchId: "batch-target", offset: 0, addressId: "" };
  return Object.freeze({
    summary: sanitizeBatchSummary({
      id: "batch-target",
      status: "running",
      concurrency: 2,
      max_tasks: 2_000,
      task_count: 1_001,
      succeeded_task_count: 0,
      failed_task_count: 0,
      cancelled_task_count: 0,
      sources: [],
      current: null,
      review: null,
      resumable: false,
    }, "batch-target"),
    page: sanitizeTaskPage({ items: rawTasks(1_001), limit: 100, offset: 0 }, query),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("P3 Tasks targets migrated from the legacy P0 source probes", () => {
  it("keeps the current sanitized page and keyed task-row contract at 100", () => {
    const target = budgetContract.budgets.tasks_active_page.rows_max;
    const page = snapshot().page;
    expect(TASK_PAGE_LIMIT).toBe(target);
    expect(page.items).toHaveLength(target);
    expect(tasksSource).toContain("{#each tasks as task (task.id)}");
    expect(tasksSource).toContain("<TaskRow {task} />");
    expect(tasksSource).not.toMatch(/1_000|1000/);
  });

  it("applies one completed summary+page poll through exactly one Tasks domain commit", async () => {
    const authority = deferred<TasksAuthoritySnapshot>();
    let registration: PollingRegistration<TasksAuthoritySnapshot> | null = null;
    let stopped = false;
    const handle: PollingHandle = Object.freeze({
      key: "tasks.active",
      scope: "app:tasks",
      async trigger() {
        const current = registration!;
        const controller = new AbortController();
        try {
          const result = await current.task(controller.signal);
          if (stopped) return false;
          current.onResult(result);
          return true;
        } catch (error) {
          current.onError?.(error);
          return false;
        }
      },
      stop() {
        if (stopped) return false;
        stopped = true;
        return true;
      },
    });
    const polling = {
      start(options: PollingRegistration<TasksAuthoritySnapshot>) {
        registration = options;
        stopped = false;
        return handle;
      },
      stopScope: vi.fn(() => 0),
    } as unknown as PollingService;
    const service = {
      readRecent: vi.fn(async () => []),
      readAuthority: vi.fn(async () => authority.promise),
      write: vi.fn(),
    } as unknown as TasksService;
    const persistence = { writeActiveBatchId: vi.fn(() => true) } as unknown as PersistenceService;
    const store = createTasksStore({ activeBatchId: "batch-target" });
    const controller = createTasksController({ store, service, polling, persistence });
    const listener = vi.fn();
    store.subscribe(listener);

    controller.activate();
    await flush();
    listener.mockClear();
    authority.resolve(snapshot());
    await flush();

    expect(listener).toHaveBeenCalledTimes(
      budgetContract.budgets.tasks_active_page.state_commits_per_poll_max,
    );
    expect(store.getState().order).toHaveLength(100);
    expect(Object.keys(store.getState().entities)).toHaveLength(100);
    controller.destroy();
  });
});
