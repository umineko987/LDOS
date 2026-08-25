import { readFileSync } from "node:fs";
import { render } from "svelte/server";
import { describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/core/api/client";
import type { PersistenceService } from "../src/core/persistence/service";
import type { PollingService } from "../src/core/polling/service";
import { sanitizeTaskPage } from "../src/apps/tasks/model";
import AppWindow from "../src/shell/AppWindow.svelte";
import TaskRow from "../src/apps/tasks/TaskRow.svelte";
import Tasks from "../src/apps/tasks/Tasks.svelte";
import appWindowSource from "../src/shell/AppWindow.svelte?raw";
import controllerSource from "../src/apps/tasks/controller.ts?raw";
import modelSource from "../src/apps/tasks/model.ts?raw";
import serviceSource from "../src/apps/tasks/service.ts?raw";
import stateSource from "../src/apps/tasks/state.ts?raw";
import taskRowSource from "../src/apps/tasks/TaskRow.svelte?raw";
import tasksSource from "../src/apps/tasks/Tasks.svelte?raw";

const tasksCss = readFileSync(new URL("../src/apps/tasks/tasks.css", import.meta.url), "utf8");
const api = Object.freeze({}) as ApiClient;
const polling = Object.freeze({}) as PollingService;
const persistence = Object.freeze({
  readActiveBatchId: () => null,
}) as PersistenceService;
const onNavigate = vi.fn();

const windowProps = {
  api,
  polling,
  persistence,
  focused: true,
  onNavigate,
  onFocus: vi.fn(),
  onMinimize: vi.fn(),
  onToggleMaximized: vi.fn(),
  onClose: vi.fn(),
  onBeginInteraction: vi.fn(),
  onKeyboardResize: vi.fn(),
};

function record(appId: "tasks" | "crawl") {
  return {
    appId,
    state: "normal" as const,
    rect: { x: 20, y: 20, w: 800, h: 560 },
  };
}

describe("Svelte Tasks integration", () => {
  it("renders the real Tasks boundary with selection, status, refresh, and accessible workspace controls", () => {
    const body = render(Tasks, { props: { api, polling, persistence, onNavigate } }).body;
    for (const marker of [
      "data-tasks-app",
      'data-domain-owner="tasks"',
      "最近批次",
      "批次筛选",
      "查看所选批次",
      "刷新全部事实",
      "任务与恢复事实",
      "操作与恢复",
      'aria-live="polite"',
      'aria-label="批次管理三段工作区，可横向滚动"',
    ]) expect(body).toContain(marker);
    expect(body).not.toContain("应用迁移将在后续阶段接入");
    expect(body).not.toContain("P2 Shell");
  });

  it("uses Tasks for its only window path while Crawl has its own real branch", () => {
    const tasks = render(AppWindow, { props: { ...windowProps, record: record("tasks") } }).body;
    const crawl = render(AppWindow, { props: { ...windowProps, record: record("crawl") } }).body;
    expect(tasks).toContain("data-tasks-app");
    expect(tasks).not.toContain('data-application-content="tasks"');
    expect(crawl).toContain("data-crawl-app");
    expect(crawl).not.toContain('data-application-content="crawl"');
    expect(appWindowSource).toContain('record.appId === "tasks"');
    expect(appWindowSource).toContain("<Tasks {api} {polling} {persistence} {onNavigate} />");
  });

  it("renders only sanitized row facts with a stable task ID", () => {
    const task = sanitizeTaskPage({ items: [{
      id: "task-safe",
      crawl_address_id: "address-safe",
      site: "pixiv",
      status: "failed",
      source_order: 0,
      address_order: 1,
      sequence_no: 2,
      attempt_count: 1,
      max_attempts: 3,
      artifact_count: 2,
      artifact_bytes: 1_024,
      last_error_class: "credentials_unavailable",
      last_error: "token=never",
      output_dir: "/private/never",
    }] }, { batchId: "batch-safe", offset: 0, addressId: "" }).items[0];
    const body = render(TaskRow, { props: { task } }).body;
    expect(body).toContain('data-task-id="task-safe"');
    expect(body).toContain("授权失效");
    expect(body).toContain("2 个文件 · 1.0 KiB");
    expect(body).not.toContain("token=never");
    expect(body).not.toContain("/private/never");
  });

  it("keeps the 100-row keyed component contract and all domain I/O behind shared services", () => {
    expect(modelSource).toContain("TASK_PAGE_LIMIT = 100");
    expect(tasksSource).toContain("{#each tasks as task (task.id)}");
    expect(tasksSource).toContain("<TaskRow {task} />");
    expect(taskRowSource).toContain("data-task-row");
    expect(taskRowSource).toContain("data-task-id={task.id}");
    expect(stateSource).toContain("entities: Readonly<Record<string, TaskEntity>>");
    expect(stateSource).toContain("order: readonly string[]");
    expect(tasksSource.match(/createTasksStore\s*\(/g)).toHaveLength(1);
    expect(serviceSource).toContain("Promise.all([");
    expect(serviceSource).toContain("limit=${TASK_PAGE_LIMIT}&offset=${offset}");
    expect(controllerSource).toContain("store.commitAuthority(snapshot, options)");
    expect(controllerSource).toContain("TASK_POLL_INTERVAL_MS");

    const combined = [tasksSource, taskRowSource, controllerSource, serviceSource, stateSource, modelSource].join("\n");
    for (const forbidden of [
      /\bfetch\s*\(/,
      /globalThis\.fetch/,
      /XMLHttpRequest/,
      /\b(?:localStorage|sessionStorage|indexedDB)\b/,
      /\bsetInterval\s*\(/,
      /innerHTML/,
      /console\./,
    ]) expect(combined).not.toMatch(forbidden);
    expect(tasksSource).not.toContain("error.details");
    expect(tasksSource).not.toContain("output_dir");
  });

  it("keeps internal surfaces flat and the confirmation/focus path explicit", () => {
    expect(tasksCss).not.toMatch(/(?:-webkit-)?backdrop-filter\s*:/);
    expect(tasksCss).not.toMatch(/^\s*filter\s*:/m);
    expect(tasksCss).toContain(".tasks-workspace__track");
    expect(tasksCss).toContain("grid-template-columns:");
    expect(tasksCss).toContain("overflow-x: auto");
    expect(tasksSource).toContain('aria-modal="true"');
    expect(tasksSource).toContain('aria-describedby="tasks-confirmation-message tasks-confirmation-warning"');
    expect(tasksSource).toContain("trappedTabIndex");
    expect(tasksSource).toContain('event.key === "Escape"');
    expect(tasksSource).toContain("restoreFocus");
    expect(tasksSource).toContain("return () => controller.destroy()");
  });
});
