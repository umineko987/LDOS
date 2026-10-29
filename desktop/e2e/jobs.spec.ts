import type { Page } from "@playwright/test";

import { mockApi } from "./fixtures/api";
import {
  CRAWL_BATCH,
  CRAWL_JOB,
  CRAWL_LIST,
  CRAWL_TASKS,
  DOWNLOAD_TASKS,
  job,
  mockEvents,
  mockJobs,
  TASK_EVENTS,
  TASK_LOGS,
} from "./fixtures/jobs";
import { expect, test } from "./fixtures/test";

/** 批次详情页用到的接口。 */
async function mockBatch(page: Page) {
  await mockApi(page, "get", "/api/v1/crawls/{batch_id}", CRAWL_BATCH);
  await mockApi(page, "get", "/api/v1/crawls/{batch_id}/tasks", CRAWL_TASKS);
  await mockApi(page, "get", "/api/v1/tasks/{task_id}/logs", TASK_LOGS);
  await mockApi(page, "get", "/api/v1/tasks/{task_id}/events", TASK_EVENTS);
}

test("SSE 推来的任务出现在活动抽屉和侧栏角标里，重连从最后一条事件续上", async ({ page }) => {
  await mockJobs(page, [], "e1-0");
  const connections = await mockEvents(page, [{ event: "job.updated", id: "e1-1", data: { job: CRAWL_JOB } }]);
  await mockBatch(page);
  await page.goto("/#/library");

  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar.locator('[data-nav="jobs"]').getByTestId("running-count")).toContainText("1");
  await expect(sidebar.getByRole("button", { name: /活动/ }).getByTestId("running-count")).toContainText("1");

  await page.keyboard.press("Control+j");
  const drawer = page.getByTestId("activity-drawer");
  const row = drawer.locator('[data-job="crawl:batch-7"]');
  await expect(drawer.getByTestId("activity-running")).toContainText("进行中 · 1");
  await expect(row).toContainText("采集批次 batch-7");
  await expect(row.getByTestId("job-status")).toHaveText("运行中");
  await expect(row.getByTestId("job-count")).toHaveText("6/10");
  await expect(row.getByTestId("job-message")).toHaveText("1 个任务失败");
  await expect(row.getByRole("progressbar")).toBeVisible();
  // 进度条不用金色。
  const indicator = row.locator('[data-slot="progress-indicator"]');
  expect(await indicator.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe("rgb(230, 189, 117)");

  // 第一次连接用快照的游标；流结束后按退避重连，带上收到的最后一个事件 id。
  expect(new URL(connections[0]!).searchParams.get("last_event_id")).toBe("e1-0");
  await expect.poll(() => connections.length, { timeout: 5_000 }).toBeGreaterThan(1);
  expect(new URL(connections[1]!).searchParams.get("last_event_id")).toBe("e1-1");

  await row.getByRole("link", { name: "打开" }).click();
  await expect(page).toHaveURL(/#\/jobs\/crawls\/batch-7$/);
  await expect(drawer).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "采集批次 batch-7" })).toBeVisible();
});

test("任务结束时弹出提示，「打开」跳到对应页面；失败的提示带原因", async ({ page }) => {
  const failing = job({ id: "dataset.export:x1", kind: "dataset.export", title: "导出数据集", ref: { dataset_id: "demo", export_id: "x1" } });
  await mockJobs(page, [CRAWL_JOB, failing], "e2-0");
  const finishedAt = Math.floor(Date.now() / 1000);
  // 后到的提示叠在最前面，所以成功的放在后面，方便点它的「打开」。
  await mockEvents(page, [
    {
      event: "job.updated",
      id: "e2-1",
      data: { job: { ...failing, status: "failed", message: "磁盘空间不足", updated_at: finishedAt, finished_at: finishedAt } },
    },
    {
      event: "job.updated",
      id: "e2-2",
      data: { job: { ...CRAWL_JOB, status: "succeeded", current: 10, updated_at: finishedAt, finished_at: finishedAt } },
    },
  ]);
  await mockBatch(page);
  await page.goto("/#/library");

  const failed = page.locator("[data-sonner-toast]", { hasText: "导出数据集 失败" });
  await expect(failed).toContainText("磁盘空间不足");
  const done = page.locator("[data-sonner-toast]", { hasText: "采集批次 batch-7 已完成" });
  await expect(done).toBeVisible();
  await expect(page.getByTestId("sidebar").getByTestId("running-count")).toHaveCount(0);

  await done.getByRole("button", { name: "打开" }).click();
  await expect(page).toHaveURL(/#\/jobs\/crawls\/batch-7$/);

  await page.keyboard.press("Control+j");
  const recent = page.getByTestId("activity-drawer").getByTestId("activity-recent");
  await expect(recent.locator('[data-job="crawl:batch-7"]')).toHaveAttribute("data-status", "succeeded");
  await expect(recent.locator('[data-job="dataset.export:x1"] [data-testid="job-message"]')).toHaveClass(/text-danger/);
});

test("resync 让任务快照和页面查询重新拉取", async ({ page }) => {
  let snapshots = 0;
  let lists = 0;
  await mockApi(page, "get", "/api/v1/jobs", () => {
    snapshots += 1;
    return { body: { items: [], last_event_id: "e3-0" } };
  });
  await mockApi(page, "get", "/api/v1/crawls", () => {
    lists += 1;
    return { body: CRAWL_LIST };
  });
  await page.goto("/#/jobs");
  await page.getByTestId("jobs-tabs").getByRole("button", { name: "采集批次" }).click();
  await expect(page.locator('[data-batch="batch-7"]')).toBeVisible();
  const before = { snapshots, lists };

  // 换一个会发 resync 的流，下一次重连时生效。
  await mockEvents(page, [{ event: "resync", id: "e4-0", data: { last_event_id: "e4-0", reason: "unknown_cursor" } }]);
  await expect.poll(() => snapshots, { timeout: 12_000 }).toBeGreaterThan(before.snapshots);
  await expect.poll(() => lists).toBeGreaterThan(before.lists);
});

test("任务页：实时任务、采集批次历史和下载任务日志", async ({ page }) => {
  const finished = job({
    id: "gallery.scan:s1",
    kind: "gallery.scan",
    title: "扫描 Pictures",
    status: "succeeded",
    ref: { source_id: "src-1" },
    finished_at: Math.floor(Date.now() / 1000) - 300,
    updated_at: Math.floor(Date.now() / 1000) - 300,
  });
  await mockJobs(page, [finished, CRAWL_JOB]);
  await mockApi(page, "get", "/api/v1/crawls", CRAWL_LIST);
  let lastStatus: string | null = "unset";
  await mockApi(page, "get", "/api/v1/tasks", (request) => {
    lastStatus = new URL(request.url()).searchParams.get("status");
    return { body: DOWNLOAD_TASKS };
  });
  await mockBatch(page);
  await page.goto("/#/jobs");

  const live = page.getByTestId("jobs-live");
  await expect(live.locator("[data-job]")).toHaveCount(2);
  // 进行中的在前。
  await expect(live.locator("[data-job]").first()).toHaveAttribute("data-job", "crawl:batch-7");
  await expect(live.locator('[data-job="gallery.scan:s1"] [data-testid="job-time"]')).toHaveText("5分钟前");
  await expect(live.locator('[data-job="gallery.scan:s1"]').getByRole("link", { name: "打开" })).toHaveAttribute("href", "#/library/src-1");

  const tabs = page.getByTestId("jobs-tabs");
  await tabs.getByRole("button", { name: "采集批次" }).click();
  const running = page.locator('[data-batch="batch-7"]');
  await expect(running).toContainText("运行中");
  await expect(running).toContainText("6/10");
  await expect(page.locator('[data-batch="batch-6"]')).toContainText("完成（有失败）");

  await tabs.getByRole("button", { name: "下载任务" }).click();
  const tasks = page.getByTestId("download-tasks");
  const failedTask = tasks.locator('[data-task-row="task-9"]');
  // 只显示主机和路径，查询串里的令牌不出现。
  await expect(failedTask).toContainText("www.pixiv.net/artworks/1");
  await expect(failedTask).not.toContainText("secret");
  await expect(failedTask).toContainText("auth_expired");
  expect(lastStatus).toBeNull();
  await tasks.getByRole("button", { name: "失败", exact: true }).click();
  await expect.poll(() => lastStatus).toBe("failed");

  await page.keyboard.press("j");
  await expect(failedTask).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("task-log")).toHaveAttribute("data-task", "task-9");
  await expect(page.getByTestId("task-log-body")).toContainText("HTTP 504 Gateway Timeout");
});

test("批次详情：摘要、地址、任务列表、日志和取消", async ({ page }) => {
  await mockJobs(page, [CRAWL_JOB]);
  await mockBatch(page);
  let cancelled = 0;
  await mockApi(page, "post", "/api/v1/crawls/{batch_id}/cancel", () => {
    cancelled += 1;
    return { body: { ...CRAWL_BATCH, cancel_requested: true } };
  });
  await page.goto("/#/jobs/crawls/batch-7");

  await expect(page.getByRole("heading", { name: "采集批次 batch-7" })).toBeVisible();
  const summary = page.getByTestId("crawl-summary");
  await expect(summary.getByTestId("crawl-status")).toHaveText("运行中");
  await expect(summary).toContainText("任务 10");
  await expect(summary).toContainText("成功 5");
  await expect(summary).toContainText("失败 1");
  await expect(summary).toContainText("预去重跳过 3");
  await expect(summary.getByTestId("crawl-message")).toHaveText("1 个任务失败");
  await expect(summary.getByTestId("crawl-current")).toHaveText("正在处理：danbooru · 第 2 个地址");
  await expect(page.locator('[data-address="a2"]')).toContainText("fern rating:g");
  await expect(page.locator('[data-address="a2"]')).toContainText("成功 1/6 · 失败 1");

  // 运行中：只能取消。
  await expect(page.getByTestId("crawl-retry")).toBeDisabled();
  await expect(page.getByTestId("crawl-rerun")).toBeDisabled();

  const rows = page.getByTestId("crawl-tasks").locator("[data-task-row]");
  await expect(rows).toHaveCount(3);
  await expect(page.locator('[data-task-row="task-2"]')).toContainText("network_timeout");
  await page.keyboard.press("j");
  await expect(page.locator('[data-task-row="task-1"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('[data-task-row="task-2"]')).toHaveAttribute("aria-pressed", "true");
  const log = page.getByTestId("task-log");
  await expect(log).toHaveAttribute("data-task", "task-2");
  await expect(log.locator('[data-stream="stderr"]')).toContainText("HTTP 504 Gateway Timeout");
  await log.getByRole("button", { name: "事件" }).click();
  await expect(log.locator('[data-event="attempt_started"]')).toBeVisible();
  await page.keyboard.press("k");
  await expect(page.locator('[data-task-row="task-1"]')).toHaveAttribute("aria-pressed", "true");

  await page.getByTestId("crawl-cancel").click();
  await expect(page.locator("[data-sonner-toast]", { hasText: "已请求取消批次" })).toBeVisible();
  expect(cancelled).toBe(1);
});
