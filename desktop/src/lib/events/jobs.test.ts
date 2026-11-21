import { describe, expect, it } from "vitest";

import { sanitizeJob, type Job } from "#lib/api/queries/jobs.ts";

import { compareJobs, isActiveJob, jobElapsed, jobLink, jobProgress, JobTable, MAX_FINISHED_JOBS } from "./jobs.ts";

function job(overrides: Partial<Record<keyof Job, unknown>> = {}): Job {
  return sanitizeJob({
    id: "j1",
    kind: "crawl.batch",
    title: "t",
    status: "running",
    message: "",
    ref: {},
    started_at: 100,
    updated_at: 100,
    ...overrides,
  });
}

describe("JobTable", () => {
  it("合并更新并报告结束转变", () => {
    const table = new JobTable();
    expect(table.apply(job())).toBeNull();
    expect(table.size).toBe(1);
    const transition = table.apply(job({ status: "succeeded", updated_at: 120, finished_at: 120 }));
    expect(transition?.job.status).toBe("succeeded");
    expect(transition?.previous?.status).toBe("running");
    // 已结束的再更新一次不算新的转变。
    expect(table.apply(job({ status: "succeeded", updated_at: 121, finished_at: 120 }))).toBeNull();
    expect(table.get("j1")?.updated_at).toBe(121);
  });

  it("第一次出现就已结束的任务也算转变；旧更新被忽略", () => {
    const table = new JobTable();
    expect(table.apply(job({ id: "quick", status: "failed", updated_at: 5 }))?.previous).toBeUndefined();
    table.apply(job({ id: "j2", updated_at: 200 }));
    expect(table.apply(job({ id: "j2", status: "succeeded", updated_at: 150 }))).toBeNull();
    expect(table.get("j2")?.status).toBe("running");
  });

  it("快照整表替换", () => {
    const table = new JobTable();
    table.apply(job({ id: "old" }));
    table.replace([job({ id: "new" })]);
    expect(table.list().map((item) => item.id)).toEqual(["new"]);
  });

  it("活动任务在前，终态任务按结束时间新到旧，并只保留最近一批终态任务", () => {
    const table = new JobTable();
    const finished = Array.from({ length: MAX_FINISHED_JOBS + 5 }, (_, index) =>
      job({ id: `f${index}`, status: "succeeded", started_at: 1, updated_at: 10 + index, finished_at: 10 + index }),
    );
    table.replace([...finished, job({ id: "a1", started_at: 50 }), job({ id: "a2", started_at: 60 })]);
    const list = table.list();
    expect(list.slice(0, 2).map((item) => item.id)).toEqual(["a2", "a1"]);
    expect(list[2]!.id).toBe(`f${MAX_FINISHED_JOBS + 4}`);
    expect(list).toHaveLength(MAX_FINISHED_JOBS + 2);
    expect(table.get("f0")).toBeUndefined();
  });

  it("compareJobs 时间相同按 id 排", () => {
    expect(compareJobs(job({ id: "a" }), job({ id: "b" }))).toBeLessThan(0);
    const done = job({ id: "x", status: "cancelled", updated_at: 300 });
    expect(compareJobs(done, job({ id: "y", status: "cancelled", updated_at: 200 }))).toBeLessThan(0);
    expect(compareJobs(done, job())).toBeGreaterThan(0);
    expect(isActiveJob(job({ status: "queued" }))).toBe(true);
  });
});

describe("jobLink", () => {
  it("按任务种类给出打开的页面", () => {
    expect(jobLink(job({ kind: "crawl.batch", ref: { batch_id: "b 1" } }))).toBe("/jobs/crawls/b%201");
    expect(jobLink(job({ kind: "crawl.batch" }))).toBe("/jobs");
    expect(jobLink(job({ kind: "dedup.review", ref: { dataset_id: "d1", stage: "dedup", review_id: "r" } }))).toBe(
      "/datasets/d1/dedup",
    );
    expect(jobLink(job({ kind: "dedup.review", ref: { dataset_id: "d1", stage: "tag" } }))).toBeNull();
    expect(jobLink(job({ kind: "dedup.review", ref: { review_id: "r" } }))).toBeNull();
    expect(jobLink(job({ kind: "gallery.scan", ref: { source_id: "s1" } }))).toBe("/library/s1");
    expect(jobLink(job({ kind: "gallery.scan" }))).toBe("/library");
    expect(jobLink(job({ kind: "models.install" }))).toBe("/settings/models");
    expect(jobLink(job({ kind: "tagger.prepare", ref: { models: "a" } }))).toBe("/settings/models");
    expect(jobLink(job({ kind: "tagger.prepare", ref: { dataset_id: "d1" } }))).toBe("/datasets/d1/tag");
    expect(jobLink(job({ kind: "tagger.tag", ref: { dataset_id: "d1" } }))).toBe("/datasets/d1/tag");
    // caption 任务的 batch_id 是 caption 批次，不是采集批次。
    expect(jobLink(job({ kind: "captions.write", ref: { dataset_id: "d1", batch_id: "c" } }))).toBe("/datasets/d1/tag");
    expect(jobLink(job({ kind: "captions.undo", ref: { dataset_id: "d1" } }))).toBe("/datasets/d1/tag");
    expect(jobLink(job({ kind: "captions.write", ref: { source_id: "s 1", batch_id: "c" } }))).toBe("/library/s%201/review");
    expect(jobLink(job({ kind: "captions.undo", ref: { source_id: "s1" } }))).toBe("/library/s1/review");
    expect(jobLink(job({ kind: "captions.write", ref: { batch_id: "c" } }))).toBeNull();
    expect(jobLink(job({ kind: "atlas.run", ref: { dataset_id: "d1" } }))).toBe("/datasets/d1/atlas");
    expect(jobLink(job({ kind: "dataset.export", ref: { dataset_id: "d1" } }))).toBe("/datasets/d1/export");
    expect(jobLink(job({ kind: "dataset.hashing", ref: { dataset_id: "d1" } }))).toBe("/datasets/d1/collect");
    expect(jobLink(job({ kind: "gallery.export" }))).toBeNull();
    expect(jobLink(job({ kind: "atlas.run" }))).toBeNull();
  });
});

describe("progress and elapsed", () => {
  it("jobProgress 在知道总量时给比例", () => {
    expect(jobProgress(job({ current: 3, total: 12 }))).toBe(0.25);
    expect(jobProgress(job({ total: 12 }))).toBe(0);
    expect(jobProgress(job({ current: 3 }))).toBeNull();
    expect(jobProgress(job({ current: 0, total: 0 }))).toBeNull();
  });

  it("jobElapsed 活动任务算到现在，终态任务算到结束", () => {
    expect(jobElapsed(job({ started_at: 100 }), 160)).toBe(60);
    expect(jobElapsed(job({ started_at: 100 }), 50)).toBe(0);
    expect(jobElapsed(job({ status: "succeeded", started_at: 100, finished_at: 130, updated_at: 140 }), 999)).toBe(30);
    expect(jobElapsed(job({ status: "failed", started_at: 100, updated_at: 140 }), 999)).toBe(40);
  });
});
