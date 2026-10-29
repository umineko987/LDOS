import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import { datasetKeys, type DatasetDetail } from "./datasets.ts";
import {
  applyTriage,
  cleanItemsQuery,
  dedupGroupsQuery,
  invalidateTriage,
  isTriageEvent,
  isTriageRunning,
  parsePresets,
  refreshAfterTriage,
  reviewPresetsQuery,
  runTriageStage,
  TRIAGE_POLL_MS,
  triageKeys,
  triagePhase,
  triageSummaryQuery,
  undoTriage,
  type StageTriageSummary,
} from "./triage.ts";

type Reply = { status: number; body?: unknown };

function fakeApi(reply: (request: Request, body: unknown) => Reply) {
  const requests: { request: Request; body: unknown }[] = [];
  const api = createApi("http://127.0.0.1:8787", {
    fetchImpl: async (request) => {
      const text = await request.clone().text();
      const body = text ? JSON.parse(text) : null;
      requests.push({ request, body });
      const result = reply(request, body);
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  return { api, requests };
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

const COUNTS = { input: 10, groups: 2, pending_groups: 2, decided_groups: 0, flagged: 3, automatic_excluded: 0, kept: 0, rejected: 0, failed: 0 };

function summary(overrides: Partial<StageTriageSummary> = {}): StageTriageSummary {
  return {
    dataset_id: "d1",
    stage: "dedup",
    run: {
      run_id: "r1",
      dataset_id: "d1",
      stage: "dedup",
      status: "succeeded",
      ref_id: "rev1",
      input_digest: "x",
      stats: {},
      error_code: "",
      created_at: 1,
      updated_at: 1,
      finished_at: 2,
    },
    review_id: "rev1",
    review_status: "ready",
    review_error: "",
    counts: COUNTS,
    undo_depth: 0,
    last_batch_id: null,
    ...overrides,
  };
}

const run = (status: "running" | "succeeded" | "failed" | "cancelled") => ({ ...summary().run!, status });

describe("triagePhase / isTriageRunning", () => {
  it("没跑过、分析中、可分诊、失败、失效", () => {
    expect(triagePhase(undefined)).toBe("idle");
    expect(triagePhase(summary({ run: null, review_status: null }))).toBe("idle");
    expect(triagePhase(summary({ run: run("running") }))).toBe("running");
    for (const status of ["pending", "analyzing", "auto_applying"] as const) {
      expect(triagePhase(summary({ review_status: status }))).toBe("running");
    }
    expect(triagePhase(summary())).toBe("ready");
    expect(triagePhase(summary({ run: run("failed") }))).toBe("failed");
    expect(triagePhase(summary({ review_status: "failed" }))).toBe("failed");
    expect(triagePhase(summary({ review_status: "expired" }))).toBe("expired");
    expect(isTriageRunning(undefined)).toBe(false);
    expect(isTriageRunning(summary())).toBe(false);
  });
});

describe("查询", () => {
  it("摘要走 /stages/{stage}/triage，分析中才轮询", async () => {
    const { api, requests } = fakeApi(() => ({ status: 200, body: summary() }));
    const client = newClient();
    const options = triageSummaryQuery(api, "d1", "dedup");
    expect(options.queryKey).toEqual(["datasets", "item", "d1", "triage", "dedup", "summary"]);
    expect(await client.fetchQuery(options)).toEqual(summary());
    expect(new URL(requests[0]!.request.url).pathname).toBe("/api/v1/datasets/d1/stages/dedup/triage");
    const interval = options.refetchInterval as (query: { state: { data: StageTriageSummary | undefined } }) => number | false;
    expect(interval({ state: { data: summary({ review_status: "analyzing" }) } })).toBe(TRIAGE_POLL_MS);
    expect(interval({ state: { data: summary() } })).toBe(false);
  });

  it("清洗列表按 offset 翻页，带原因和状态", async () => {
    const page = (offset: number, count: number) => ({ run_id: "r1", review_id: "rev1", total: 3, offset, limit: 2, items: Array(count).fill({}) });
    const { api, requests } = fakeApi((request) => {
      const offset = Number(new URL(request.url).searchParams.get("offset"));
      return { status: 200, body: page(offset, offset === 0 ? 2 : 1) };
    });
    const client = newClient();
    const options = cleanItemsQuery(api, "d1", { reason: "monochrome" }, 2);
    expect(options.queryKey).toEqual([...triageKeys.stage("d1", "clean"), "items", { reason: "monochrome", state: "all" }]);
    const result = await client.fetchInfiniteQuery(options);
    expect(options.getNextPageParam(result.pages[0]!, result.pages, 0, [0])).toBe(2);
    const url = new URL(requests[0]!.request.url);
    expect(url.pathname).toBe("/api/v1/datasets/d1/stages/clean/items");
    expect(Object.fromEntries(url.searchParams)).toEqual({ state: "all", reason: "monochrome", offset: "0", limit: "2" });
    expect(options.getNextPageParam(page(2, 1), [], 2, [])).toBeUndefined();
    expect(options.getNextPageParam({ ...page(0, 0), total: 5 }, [], 0, [])).toBeUndefined();
  });

  it("清洗列表不给原因时不带 reason", async () => {
    const { api, requests } = fakeApi(() => ({ status: 200, body: { run_id: "r1", review_id: "rev1", total: 0, offset: 0, limit: 200, items: [] } }));
    await newClient().fetchInfiniteQuery(cleanItemsQuery(api, "d1"));
    expect(new URL(requests[0]!.request.url).searchParams.has("reason")).toBe(false);
  });

  it("去重分组默认不含自动组", async () => {
    const { api, requests } = fakeApi(() => ({ status: 200, body: { run_id: "r1", review_id: "rev1", total: 0, offset: 0, limit: 50, items: [] } }));
    const client = newClient();
    const manual = dedupGroupsQuery(api, "d1");
    expect(manual.queryKey).toEqual([...triageKeys.stage("d1", "dedup"), "groups", { automatic: false, state: "all" }]);
    await client.fetchInfiniteQuery(manual);
    await client.fetchInfiniteQuery(dedupGroupsQuery(api, "d1", { automatic: true, state: "pending" }, 10));
    expect(Object.fromEntries(new URL(requests[0]!.request.url).searchParams)).toEqual({
      state: "all",
      include_automatic: "false",
      offset: "0",
      limit: "50",
    });
    expect(new URL(requests[1]!.request.url).searchParams.get("include_automatic")).toBe("true");
    expect(new URL(requests[1]!.request.url).searchParams.get("state")).toBe("pending");
  });
});

describe("parsePresets", () => {
  it("只留下形状对的预设，选项缺省为 false", () => {
    const presets = parsePresets({
      items: [
        { id: "builtin-style", name: "画风", builtin: true, options: { filter_monochrome: true, filter_sketch: true, reference_asset_ids: ["a", 3] } },
        { id: "custom", name: "  ", options: {} },
        { id: "", options: {} },
        { id: "no-options" },
        "junk",
      ],
    });
    expect(presets).toEqual([
      {
        id: "builtin-style",
        name: "画风",
        builtin: true,
        options: {
          basic_dedup: false,
          similarity_groups: false,
          filter_monochrome: true,
          filter_sketch: true,
          filter_character: false,
          reference_asset_ids: ["a"],
        },
      },
      {
        id: "custom",
        name: "custom",
        builtin: false,
        options: {
          basic_dedup: false,
          similarity_groups: false,
          filter_monochrome: false,
          filter_sketch: false,
          filter_character: false,
          reference_asset_ids: [],
        },
      },
    ]);
    expect(parsePresets(null)).toEqual([]);
    expect(parsePresets({ items: "nope" })).toEqual([]);
  });

  it("查询经过校验", async () => {
    const { api } = fakeApi(() => ({ status: 200, body: { items: [{ id: "p", name: "P", options: {} }] } }));
    const presets = await newClient().fetchQuery(reviewPresetsQuery(api));
    expect(presets.map((preset) => preset.id)).toEqual(["p"]);
  });
});

describe("写操作", () => {
  it("运行、定夺、撤销的路径和请求体", async () => {
    const { api, requests } = fakeApi((request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/run")) return { status: 202, body: summary({ review_status: "pending" }) };
      if (path.endsWith("/apply")) return { status: 200, body: { batch_id: "b1", applied_groups: 1, kept: ["a"], rejected: ["b"], failed: [], error: null, summary: summary() } };
      return { status: 200, body: { batch_id: "b1", undone_groups: 1, error: null, summary: summary() } };
    });
    await runTriageStage(api, "d1", "clean", { preset_id: "builtin-style", options: { filter_character: true } });
    await runTriageStage(api, "d1", "dedup");
    const applied = await applyTriage(api, "d1", "dedup", { run_id: "r1", groups: [{ group_id: "g1", keep: ["a"] }] });
    expect(applied.batch_id).toBe("b1");
    await undoTriage(api, "d1", "dedup", "b1");
    await undoTriage(api, "d1", "clean");
    expect(requests.map(({ request }) => `${request.method} ${new URL(request.url).pathname}`)).toEqual([
      "POST /api/v1/datasets/d1/stages/clean/run",
      "POST /api/v1/datasets/d1/stages/dedup/run",
      "POST /api/v1/datasets/d1/stages/dedup/apply",
      "POST /api/v1/datasets/d1/stages/dedup/undo",
      "POST /api/v1/datasets/d1/stages/clean/undo",
    ]);
    expect(requests.map(({ body }) => body)).toEqual([
      { preset_id: "builtin-style", options: { filter_character: true } },
      null,
      { run_id: "r1", groups: [{ group_id: "g1", keep: ["a"] }] },
      { batch_id: "b1" },
      null,
    ]);
  });

  it("后端的错误信封变成异常", async () => {
    const { api } = fakeApi(() => ({ status: 409, body: { error: { code: "triage_nothing_to_undo", message: "没有可撤销的" } } }));
    await expect(undoTriage(api, "d1", "dedup")).rejects.toMatchObject({ code: "triage_nothing_to_undo", status: 409 });
  });
});

describe("缓存", () => {
  function seeded() {
    const client = newClient();
    for (const key of [datasetKeys.detail("d1"), datasetKeys.list(), triageKeys.summary("d1", "dedup"), triageKeys.summary("d1", "clean"), datasetKeys.detail("d2")]) {
      client.setQueryData(key, {});
    }
    return client;
  }
  const stale = (client: QueryClient) =>
    client
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.isInvalidated)
      .map((query) => query.queryKey);

  it("响应不带漏斗时让整个数据集和列表失效", async () => {
    const client = seeded();
    await refreshAfterTriage(client, "d1", { batch_id: "b1" });
    expect(stale(client)).toEqual([datasetKeys.detail("d1"), datasetKeys.list(), triageKeys.summary("d1", "dedup"), triageKeys.summary("d1", "clean")]);
  });

  it("响应带漏斗时写进缓存，只刷新分诊", async () => {
    const client = seeded();
    client.setQueryData<Partial<DatasetDetail>>(datasetKeys.detail("d1"), { output_count: 1, funnel: [] });
    const funnel = { dataset_id: "d1", member_count: 3, stages: [{ stage: "collect", input: 3, excluded: 0, approved: 0, output: 3, status: "idle", stale: false, input_digest: "", last_run: null }] };
    await refreshAfterTriage(client, "d1", { funnel });
    expect(client.getQueryData(datasetKeys.funnel("d1"))).toEqual(funnel);
    expect(stale(client)).toEqual([triageKeys.summary("d1", "dedup"), triageKeys.summary("d1", "clean")]);
  });

  it("别的数据集的漏斗不算", async () => {
    const client = seeded();
    await refreshAfterTriage(client, "d1", { funnel: { dataset_id: "d2", stages: [] } });
    expect(stale(client)).toContainEqual(datasetKeys.detail("d1"));
  });

  it("只让一段失效", async () => {
    const client = seeded();
    await invalidateTriage(client, "d1", "clean");
    expect(stale(client)).toEqual([triageKeys.summary("d1", "clean")]);
    await invalidateTriage(client, "d1");
    expect(stale(client)).toEqual([triageKeys.summary("d1", "dedup"), triageKeys.summary("d1", "clean")]);
  });

  it("isTriageEvent 按数据集和段过滤", () => {
    const event = { dataset_id: "d1", stage: "dedup", status: "running" };
    expect(isTriageEvent(event, "d1", "dedup")).toBe(true);
    expect(isTriageEvent(event, "d1", "clean")).toBe(false);
    expect(isTriageEvent(event, "d2", "dedup")).toBe(false);
  });
});
