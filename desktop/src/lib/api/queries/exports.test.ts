import { QueryClient, QueryObserver } from "@tanstack/svelte-query";
import { describe, expect, it, vi } from "vitest";

import { createApi } from "../client.ts";
import { datasetKeys } from "./datasets.ts";
import {
  cancelExport,
  datasetExportsQuery,
  EXPORT_HISTORY_LIMIT,
  EXPORT_POLL_MS,
  exportKeys,
  invalidateExports,
  isActiveExport,
  previewExport,
  resumeExport,
  startExport,
  upsertExport,
  type DatasetExport,
  type ExportPlan,
} from "./exports.ts";
import { libraryKeys, librarySourcesQuery } from "./library.ts";

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

const OPTIONS = {
  target_path: "/out",
  layout: "kohya" as const,
  repeats: 10,
  trigger_word: "miku",
  folder_name: "10_miku",
  rename: "none" as const,
  include_captions: true,
  pin_trigger: true,
  tag_blacklist: [],
  underscore_to_space: false,
};

function record(overrides: Partial<DatasetExport> = {}): DatasetExport {
  return {
    export_id: "e1",
    dataset_id: "d1",
    job_id: "dataset-export:e1",
    status: "running",
    target_path: "/out",
    folder_name: "10_miku",
    output_path: "/out/10_miku",
    options: OPTIONS,
    total_items: 4,
    staged_items: 1,
    image_bytes: 100,
    txt_bytes: 10,
    total_bytes: 110,
    copied_bytes: 20,
    resumable: false,
    error_code: null,
    error_details: null,
    gallery_warning: null,
    created_at: 1,
    updated_at: 1,
    started_at: 1,
    finished_at: null,
    ...overrides,
  };
}

const PLAN: ExportPlan = {
  dataset_id: "d1",
  layout: "kohya",
  folder_name: "10_miku",
  target_path: "/out",
  output_path: "/out/10_miku",
  target_exists: false,
  options: OPTIONS,
  image_count: 1,
  caption_count: 1,
  image_bytes: 100,
  txt_bytes: 10,
  total_bytes: 110,
  collision_count: 0,
  collisions: [],
  blockers: [],
  items: [],
};

const pathOf = (request: Request) => new URL(request.url).pathname + new URL(request.url).search;

describe("isActiveExport", () => {
  it("排队和进行中算活动", () => {
    expect(isActiveExport("queued")).toBe(true);
    expect(isActiveExport("running")).toBe(true);
    for (const status of ["succeeded", "failed", "cancelled", "interrupted"] as const) expect(isActiveExport(status)).toBe(false);
  });
});

describe("datasetExportsQuery", () => {
  it("拉历史；有活动导出时轮询", async () => {
    const { api, requests } = fakeApi(() => ({ status: 200, body: { items: [record()] } }));
    const options = datasetExportsQuery(api, "d1");
    expect(options.queryKey).toEqual([...datasetKeys.dataset("d1"), "exports"]);
    const client = newClient();
    const items = await client.fetchQuery(options);
    expect(items.map((item) => item.export_id)).toEqual(["e1"]);
    expect(pathOf(requests[0]!.request)).toBe(`/api/v1/datasets/d1/exports?limit=${EXPORT_HISTORY_LIMIT}`);

    const interval = options.refetchInterval as (query: unknown) => number | false;
    expect(interval({ state: { data: [record({ status: "succeeded" }), record({ status: "queued" })] } })).toBe(EXPORT_POLL_MS);
    expect(interval({ state: { data: [record({ status: "succeeded" })] } })).toBe(false);
    expect(interval({ state: { data: undefined } })).toBe(false);
  });

  it("refreshes the gallery source list when an active export succeeds without SSE", async () => {
    let status: DatasetExport["status"] = "running";
    const source = { source_id: "copy", display_name: "10_miku", asset_count: 4 };
    const { api, requests } = fakeApi((request) => ({
      status: 200,
      body: new URL(request.url).pathname === "/api/v1/gallery/sources"
        ? { sources: status === "succeeded" ? [source] : [] }
        : { items: [record({ status })] },
    }));
    const client = newClient();
    const library = { ...librarySourcesQuery(api), staleTime: Infinity };
    await client.fetchQuery(library);
    const unsubscribe = new QueryObserver(client, library).subscribe(() => {});
    try {
      const history = datasetExportsQuery(api, "d1");
      await client.fetchQuery(history);
      status = "failed";
      await client.fetchQuery(history);
      expect(requests.filter(({ request }) => new URL(request.url).pathname === "/api/v1/gallery/sources")).toHaveLength(1);

      status = "running";
      await client.fetchQuery(history);
      status = "succeeded";
      await client.fetchQuery(history);
      await vi.waitFor(() => expect(client.getQueryData(libraryKeys.sources())).toEqual([source]));
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});

describe("预览 / 开始 / 取消 / 续传", () => {
  it("预览带 dry_run=true 并返回计划", async () => {
    const { api, requests } = fakeApi(() => ({ status: 200, body: { dry_run: true, job: null, plan: PLAN } }));
    expect(await previewExport(api, "d1", { target_path: "/out", layout: "kohya" })).toEqual(PLAN);
    expect(requests[0]!.request.method).toBe("POST");
    expect(pathOf(requests[0]!.request)).toBe("/api/v1/datasets/d1/exports");
    expect(requests[0]!.body).toEqual({ target_path: "/out", layout: "kohya", dry_run: true });
  });

  it("预览响应里没有计划时报错", async () => {
    const { api } = fakeApi(() => ({ status: 200, body: { dry_run: true, job: null, plan: null } }));
    await expect(previewExport(api, "d1", { target_path: "/out" })).rejects.toThrow("export_plan_missing");
  });

  it("开始带 dry_run=false 并返回导出记录；没有记录时报错", async () => {
    const { api, requests } = fakeApi(() => ({ status: 202, body: { dry_run: false, job: record({ status: "queued" }), plan: PLAN } }));
    expect((await startExport(api, "d1", { target_path: "/out", dry_run: true } as never)).status).toBe("queued");
    expect(requests[0]!.body).toMatchObject({ dry_run: false });

    const empty = fakeApi(() => ({ status: 202, body: { dry_run: false, job: null, plan: null } }));
    await expect(startExport(empty.api, "d1", { target_path: "/out" })).rejects.toThrow("export_job_missing");
  });

  it("后端错误原样抛出", async () => {
    const { api } = fakeApi(() => ({ status: 422, body: { error: { code: "export_trigger_required", message: "x" } } }));
    await expect(previewExport(api, "d1", { target_path: "/out" })).rejects.toMatchObject({ code: "export_trigger_required" });
  });

  it("取消和续传打到导出自己的地址", async () => {
    const { api, requests } = fakeApi((request) => ({
      status: 200,
      body: record({ status: request.url.endsWith("/cancel") ? "cancelled" : "queued" }),
    }));
    expect((await cancelExport(api, "e1")).status).toBe("cancelled");
    expect((await resumeExport(api, "e1")).status).toBe("queued");
    expect(requests.map((entry) => `${entry.request.method} ${pathOf(entry.request)}`)).toEqual([
      "POST /api/v1/exports/e1/cancel",
      "POST /api/v1/exports/e1/resume",
    ]);
  });
});

describe("缓存", () => {
  it("upsert：没有列表时建一个；新记录插到最前；已有记录原位替换", () => {
    const client = newClient();
    const key = exportKeys.list("d1");
    const sourcesKey = libraryKeys.sources();
    client.setQueryData(sourcesKey, []);
    upsertExport(client, record({ export_id: "e1" }));
    expect(client.getQueryState(sourcesKey)?.isInvalidated).toBe(true);
    expect(client.getQueryData<DatasetExport[]>(key)!.map((item) => item.export_id)).toEqual(["e1"]);
    upsertExport(client, record({ export_id: "e2" }));
    upsertExport(client, record({ export_id: "e1", status: "succeeded" }));
    const items = client.getQueryData<DatasetExport[]>(key)!;
    expect(items.map((item) => [item.export_id, item.status])).toEqual([
      ["e2", "running"],
      ["e1", "succeeded"],
    ]);
  });

  it("invalidateExports 只让这个数据集的历史失效", async () => {
    const client = newClient();
    client.setQueryData(exportKeys.list("d1"), []);
    client.setQueryData(exportKeys.list("d2"), []);
    await invalidateExports(client, "d1");
    expect(client.getQueryState(exportKeys.list("d1"))!.isInvalidated).toBe(true);
    expect(client.getQueryState(exportKeys.list("d2"))!.isInvalidated).toBe(false);
  });
});
