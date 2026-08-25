import { describe, expect, it } from "vitest";

import budgetContract from "./fixtures/p0-performance-budget.json";

describe("P0 target contract migrated to the desktop test entry", () => {
  it("keeps section 6.6 budgets machine-readable and separate from current measurements", () => {
    expect(budgetContract.schema_version).toBe(1);
    expect(budgetContract.kind).toBe("target-contract-not-current-measurement");
    expect(budgetContract.budgets.drag_60hz).toEqual({
      duration_seconds: 10,
      p95_frame_interval_ms_max: 16.7,
      long_tasks_over_50ms_max: 0,
      verification: "headed-tauri-webview",
      execution: "not-executed-by-task-constraint",
    });
    expect(budgetContract.budgets.tasks_active_page).toEqual({
      rows_max: 100,
      state_commits_per_poll_max: 1,
      long_tasks_over_50ms_max: 0,
      verification: "unit-and-headed-tauri-webview",
      headed_execution: "not-executed-by-task-constraint",
    });
    expect(budgetContract.budgets.minimized_application).toMatchObject({
      observation_poll_cycles: 2,
      business_requests_max: 0,
    });
    expect(budgetContract.budgets.resource_lifecycle.open_close_cycles).toBe(20);
    expect([
      budgetContract.budgets.composition_idle.visible_windows,
      budgetContract.budgets.composition_idle.minimized_windows,
    ]).toEqual([6, 2]);
  });
});
