import { QueryClient } from "@tanstack/svelte-query";
import { describe, expect, it } from "vitest";

import { createApi } from "../client.ts";
import {
  CANDIDATE_FLOOR,
  cancelTagger,
  candidatesQuery,
  invalidateCandidates,
  runTagStage,
  sanitizeTaggerModels,
  taggerKeys,
  taggerModelsQuery,
  type TaggerCandidates,
} from "./tagger.ts";

const CANDIDATES: TaggerCandidates = {
  dataset_id: "d1",
  floor: 0.01,
  models: [],
  items: {},
  stats: { total: 0, ok: 0, missing_scores: 0, decode_error: 0, unreadable: 0, unavailable: 0 },
};

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

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
        headers: { "Content-Type": "application/json", ...result.headers },
      });
    },
  });
  return { api, requests };
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

describe("sanitizeTaggerModels", () => {
  it("逐项消毒：没有 key 的丢掉，字段缺了给默认值", () => {
    expect(
      sanitizeTaggerModels([
        {
          key: "wd-vit-v3",
          repo: "SmilingWolf/wd-vit-tagger-v3",
          adapter: "wd_onnx",
          gated: false,
          license: "open",
          default_thresholds: { general: 0.35, character: 0.85, bad: "x", inf: Infinity },
          installed: true,
        },
        { key: "bare" },
        { key: "" },
        null,
        [],
      ]),
    ).toEqual([
      {
        key: "wd-vit-v3",
        repo: "SmilingWolf/wd-vit-tagger-v3",
        adapter: "wd_onnx",
        gated: false,
        license: "open",
        default_thresholds: { general: 0.35, character: 0.85 },
        installed: true,
      },
      { key: "bare", repo: "", adapter: "", gated: false, license: "", default_thresholds: {}, installed: false },
    ]);
    expect(sanitizeTaggerModels({ items: [] })).toEqual([]);
  });
});

describe("taggerModelsQuery", () => {
  it("GET /tagger/models", async () => {
    const { api, requests } = fakeApi(() => ({ status: 200, body: [{ key: "wd", installed: true }] }));
    const models = await newClient().fetchQuery(taggerModelsQuery(api));
    expect(models.map((model) => model.key)).toEqual(["wd"]);
    expect(new URL(requests[0]!.request.url).pathname).toBe("/api/v1/tagger/models");
    expect(taggerModelsQuery(api).queryKey).toEqual(["tagger", "models"]);
  });
});

describe("candidatesQuery", () => {
  it("带模型和 floor；再次请求带 ETag，304 时沿用同一个对象", async () => {
    let calls = 0;
    const { api, requests } = fakeApi(() => {
      calls += 1;
      return calls === 1 ? { status: 200, body: CANDIDATES, headers: { ETag: '"c1"' } } : { status: 304 };
    });
    const client = newClient();
    const first = await client.fetchQuery(candidatesQuery(api, "d1", ["wd", "pixai"]));
    expect(first).toEqual({ etag: '"c1"', candidates: CANDIDATES });
    const url = new URL(requests[0]!.request.url);
    expect(url.pathname).toBe("/api/v1/datasets/d1/tagger/candidates");
    expect(url.searchParams.get("models")).toBe("wd,pixai");
    expect(url.searchParams.get("floor")).toBe(String(CANDIDATE_FLOOR));
    expect(requests[0]!.request.headers.get("If-None-Match")).toBeNull();

    const second = await client.fetchQuery({ ...candidatesQuery(api, "d1", ["wd", "pixai"]), staleTime: 0 });
    expect(requests[1]!.request.headers.get("If-None-Match")).toBe('"c1"');
    expect(second).toBe(first);
  });

  it("没有缓存时 304 照常抛出；没选模型时不请求", async () => {
    const { api } = fakeApi(() => ({ status: 304 }));
    await expect(newClient().fetchQuery(candidatesQuery(api, "d1", ["wd"]))).rejects.toMatchObject({ status: 304 });
    expect(candidatesQuery(api, "d1", []).enabled).toBe(false);
    expect(candidatesQuery(api, "d1", ["wd"], 0.05).queryKey).toEqual(["tagger", "candidates", "d1", { models: ["wd"], floor: 0.05 }]);
  });

  it("invalidateCandidates 让这个数据集的所有候选失效", async () => {
    const { api } = fakeApi(() => ({ status: 200, body: CANDIDATES }));
    const client = newClient();
    await client.fetchQuery(candidatesQuery(api, "d1", ["wd"]));
    await client.fetchQuery(candidatesQuery(api, "d2", ["wd"]));
    await invalidateCandidates(client, "d1");
    expect(client.getQueryState(taggerKeys.candidates("d1", ["wd"]))?.isInvalidated).toBe(true);
    expect(client.getQueryState(taggerKeys.candidates("d2", ["wd"]))?.isInvalidated).toBe(false);
  });
});

describe("写操作", () => {
  it("runTagStage 和 cancelTagger", async () => {
    const run = {
      run_id: "r1",
      dataset_id: "d1",
      stage: "tag",
      status: "running",
      ref_id: "tagger:1",
      input_digest: "x",
      stats: {},
      error_code: "",
      created_at: 1,
      updated_at: 1,
      finished_at: null,
    };
    const { api, requests } = fakeApi((request) =>
      request.url.endsWith("/cancel") ? { status: 200, body: { cancelled: true } } : { status: 202, body: run },
    );
    await expect(runTagStage(api, "d1", { models: ["wd"] })).resolves.toEqual(run);
    expect(new URL(requests[0]!.request.url).pathname).toBe("/api/v1/datasets/d1/stages/tag/run");
    expect(requests[0]!.body).toEqual({ models: ["wd"] });
    await cancelTagger(api);
    expect(new URL(requests[1]!.request.url).pathname).toBe("/api/v1/tagger/cancel");
  });
});
