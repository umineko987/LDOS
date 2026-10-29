import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import { fetchJobSnapshot, isTerminalStatus, plainText, sanitizeEventId, sanitizeJob, sanitizeJobSnapshot } from "./jobs.ts";

const JOB = {
  id: "tagger:1f",
  kind: "tagger.tag",
  title: "打标 12 张",
  status: "running",
  current: 4,
  total: 12,
  message: "推理中",
  ref: { dataset_id: "d1", models: "wd-eva02" },
  started_at: 1_700_000_000,
  updated_at: 1_700_000_010,
  finished_at: null,
};

describe("sanitizeJob", () => {
  it("保留契约字段并冻结", () => {
    const job = sanitizeJob(JOB);
    expect(job).toEqual({ ...JOB, finished_at: null });
    expect(Object.isFrozen(job)).toBe(true);
    expect(Object.isFrozen(job.ref)).toBe(true);
  });

  it("拒绝缺少 id、kind、状态或时间的任务", () => {
    expect(() => sanitizeJob(null)).toThrow("invalid_job");
    expect(() => sanitizeJob({ ...JOB, id: "" })).toThrow("invalid_job");
    expect(() => sanitizeJob({ ...JOB, id: "../etc" })).toThrow("invalid_job");
    expect(() => sanitizeJob({ ...JOB, kind: "Tagger Tag" })).toThrow("invalid_job");
    expect(() => sanitizeJob({ ...JOB, status: "done" })).toThrow("invalid_job");
    expect(() => sanitizeJob({ ...JOB, started_at: "now" })).toThrow("invalid_job");
    expect(() => sanitizeJob({ ...JOB, updated_at: -1 })).toThrow("invalid_job");
  });

  it("规范化文本、计数和 ref", () => {
    const job = sanitizeJob({
      ...JOB,
      title: "  ",
      message: "a\nb\u0000c",
      current: 50,
      total: 12,
      ref: { dataset_id: "d1", BadKey: "x", count: 3, empty: "  ", __proto__: "p" },
    });
    expect(job.title).toBe("tagger.tag");
    expect(job.message).toBe("a b c");
    expect(job.current).toBe(12);
    expect(job.ref).toEqual({ dataset_id: "d1" });

    const unknownTotal = sanitizeJob({ ...JOB, current: 7, total: undefined, ref: "nope" });
    expect(unknownTotal.current).toBe(7);
    expect(unknownTotal.total).toBeNull();
    expect(unknownTotal.ref).toEqual({});
    expect(sanitizeJob({ ...JOB, current: null }).current).toBeNull();
  });

  it("只有终态任务带结束时间", () => {
    expect(sanitizeJob({ ...JOB, finished_at: 5 }).finished_at).toBeNull();
    expect(sanitizeJob({ ...JOB, status: "succeeded", finished_at: 1_700_000_020 }).finished_at).toBe(1_700_000_020);
    expect(sanitizeJob({ ...JOB, status: "failed", finished_at: "x" }).finished_at).toBeNull();
  });
});

describe("sanitizeJobSnapshot", () => {
  it("跳过坏条目，保留游标", () => {
    const snapshot = sanitizeJobSnapshot({ items: [JOB, { id: "bad" }, "x"], last_event_id: "ab12-7" });
    expect(snapshot.items.map((job) => job.id)).toEqual(["tagger:1f"]);
    expect(snapshot.lastEventId).toBe("ab12-7");
  });

  it("游标不合法时为空串；结构不对时报错", () => {
    expect(sanitizeJobSnapshot({ items: [], last_event_id: "has space" }).lastEventId).toBe("");
    expect(() => sanitizeJobSnapshot({ items: "nope" })).toThrow("invalid_job_list");
    expect(() => sanitizeJobSnapshot([])).toThrow("invalid_job_list");
  });
});

describe("helpers", () => {
  it("isTerminalStatus / sanitizeEventId / plainText", () => {
    expect(isTerminalStatus("succeeded")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(sanitizeEventId("e-1")).toBe("e-1");
    expect(sanitizeEventId(3)).toBe("");
    expect(plainText(3, 10)).toBe("");
    expect(plainText(" a  b ", 2)).toBe("a ");
  });

  it("fetchJobSnapshot 请求 /api/v1/jobs", async () => {
    const requests: string[] = [];
    const api = createApi("http://127.0.0.1:8787", {
      fetchImpl: async (request) => {
        requests.push(new URL(request.url).pathname);
        return new Response(JSON.stringify({ items: [JOB], last_event_id: "e-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    expect((await fetchJobSnapshot(api)).items).toHaveLength(1);
    expect(requests).toEqual(["/api/v1/jobs"]);
  });
});
