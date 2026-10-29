// 打标接口的有状态模拟：模型表、候选分数（带 ETag / 304）、tag 阶段运行、取消。
//
//   const tagger = new FakeTagger();
//   tagger.score("a2-001", { "1girl": 0.97, hat: 0.4 });   // 一张图在默认模型下的分数（按标签名）
//   tagger.unscored.add("a2-002");                          // 还没跑过打标的图
//   await tagger.install(page, datasets);
//
// 分数只存非零项；候选接口按 floor 过滤（rating 类别总是完整给出），和后端一致。
// FakeCaptions（captions.ts）用 `compose` 按同样的分数生成从打标写入的标签。

import type { Page, Request } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import { groupScores, selectTags, type SelectionPolicy, type TagFormat } from "../../src/lib/domain/tagger-select.ts";
import { errorEnvelope, mockApi } from "./api";
import type { FakeDatasets } from "./datasets";
import { MODELS } from "./settings";

type Schemas = components["schemas"];
type CandidateModel = Schemas["TaggerCandidateModel"];

/** 默认模型：小词表的 WD v3（rating 取最大，general 0.35，character 0.85）。 */
export const WD_MODEL: CandidateModel = {
  key: "wd-vit-v3",
  adapter: "wd_onnx",
  revision: "e2e",
  fingerprint: "wd-e2e",
  vocabulary_fingerprint: "wd-e2e-vocab",
  vocabulary_size: 8,
  categories: ["rating", "general", "character"],
  default_thresholds: { rating: 0, general: 0.35, character: 0.85 },
  tags: [
    ["general", "rating"],
    ["sensitive", "rating"],
    ["1girl", "general"],
    ["solo", "general"],
    ["hat", "general"],
    ["long_hair", "general"],
    ["smile", "general"],
    ["hatsune_miku", "character"],
  ],
};

const TIME = 1_760_000_000;

function datasetOf(request: Request): string {
  return decodeURIComponent(new URL(request.url()).pathname.match(/\/datasets\/([^/]+)/)?.[1] ?? "");
}

export class FakeTagger {
  readonly models: CandidateModel[] = [WD_MODEL];
  /** asset_id → 模型 key → 标签名 → 分数。 */
  readonly scores = new Map<string, Map<string, Map<string, number>>>();
  /** 还没有分数的图（候选里 status = missing_scores）；跑一次 tag 阶段后清空。 */
  readonly unscored = new Set<string>();
  /** 收到的 tag 阶段运行请求。 */
  readonly runs: Schemas["TagStageRunRequest"][] = [];
  private generation = 1;

  /** 设一张图在某个模型下的分数（按标签名）；rating 没给时补 general 0.6 / sensitive 0.4。 */
  score(assetId: string, values: Readonly<Record<string, number>>, modelKey = WD_MODEL.key): void {
    const perModel = this.scores.get(assetId) ?? new Map<string, Map<string, number>>();
    const table = new Map(Object.entries(values));
    if (!table.has("general") && !table.has("sensitive")) {
      table.set("general", 0.6);
      table.set("sensitive", 0.4);
    }
    perModel.set(modelKey, table);
    this.scores.set(assetId, perModel);
    this.generation += 1;
  }

  model(key: string): CandidateModel | undefined {
    return this.models.find((model) => model.key === key);
  }

  private rows(model: CandidateModel, assetId: string, floor: number): [number, number][] {
    const table = this.scores.get(assetId)?.get(model.key);
    if (!table) return [];
    const rows: [number, number][] = [];
    model.tags.forEach(([name, category], index) => {
      const value = table.get(name) ?? 0;
      if (category === "rating" || value >= floor) rows.push([index, value]);
    });
    return rows;
  }

  candidates(datasetId: string, assetIds: readonly string[], keys: readonly string[], floor: number): Schemas["TaggerCandidatesResponse"] {
    const models = keys.map((key) => this.model(key)).filter((model): model is CandidateModel => model !== undefined);
    const items: Schemas["TaggerCandidatesResponse"]["items"] = {};
    let ok = 0;
    for (const assetId of assetIds) {
      if (this.unscored.has(assetId) || !this.scores.has(assetId)) {
        items[assetId] = { status: "missing_scores", reason: "", missing_models: [...keys], scores: {} };
        continue;
      }
      ok += 1;
      items[assetId] = {
        status: "ok",
        reason: "",
        missing_models: [],
        scores: Object.fromEntries(models.map((model) => [model.key, this.rows(model, assetId, floor)])),
      };
    }
    return {
      dataset_id: datasetId,
      floor,
      models,
      items,
      stats: { total: assetIds.length, ok, missing_scores: assetIds.length - ok, decode_error: 0, unreadable: 0, unavailable: 0 },
    };
  }

  /** 按 from-tagger 的策略给一张图组标签（和前端 tagger-select.ts 同一套规则）；没有分数时返回 null。 */
  compose(assetId: string, body: Schemas["CaptionsFromTaggerRequest"]): string[] | null {
    if (this.unscored.has(assetId) || !this.scores.has(assetId)) return null;
    const policy: SelectionPolicy = {
      model_thresholds: body.thresholds ?? {},
      categories: body.categories ?? [],
      rating_mode: "argmax",
    };
    const format: TagFormat = { underscore_to_space: !body.keep_underscores, escape_parens: body.escape_parens === true };
    const entries = body.models.flatMap((key) => {
      const model = this.model(key);
      return model ? [{ model, scores: groupScores(model, this.rows(model, assetId, 0.01)) }] : [];
    });
    return selectTags(entries, policy, format).map((tag) => tag.text);
  }

  /** 注册打标接口和 /api/v1/models（ModelGate 用）；在 `page.goto()` 之前、FakeDatasets.install 之后调用。 */
  async install(page: Page, datasets: FakeDatasets): Promise<void> {
    await mockApi(page, "get", "/api/v1/models", () => ({ body: { items: MODELS } }));
    await mockApi(page, "get", "/api/v1/tagger/models", () => ({
      body: this.models.map((model) => ({
        key: model.key,
        repo: `e2e/${model.key}`,
        adapter: model.adapter,
        gated: false,
        license: "Apache-2.0",
        default_thresholds: model.default_thresholds,
        installed: true,
      })),
    }));
    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/tagger/candidates", (request) => {
      const id = datasetOf(request);
      const dataset = datasets.datasets.get(id);
      if (!dataset) return { status: 404, body: errorEnvelope("dataset_not_found", "数据集不存在") };
      const params = new URL(request.url()).searchParams;
      const keys = (params.get("models") ?? "").split(",").filter(Boolean);
      const floor = Number(params.get("floor") ?? 0.01);
      const assetIds = dataset.members.filter((member) => !dataset.excluded.has(member.asset_id)).map((member) => member.asset_id);
      const etag = `"cand-${this.generation}-${keys.join(",")}-${assetIds.length}"`;
      if (request.headers()["if-none-match"] === etag) return { status: 304, headers: { ETag: etag } };
      return { body: this.candidates(id, assetIds, keys, floor), headers: { ETag: etag } };
    });
    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/stages/tag/run", (request) => {
      const body = request.postDataJSON() as Schemas["TagStageRunRequest"];
      this.runs.push(body);
      this.unscored.clear();
      this.generation += 1;
      return {
        status: 202,
        body: {
          run_id: `run${this.runs.length}`,
          dataset_id: datasetOf(request),
          stage: "tag",
          status: "running",
          ref_id: `tagger:${this.runs.length}`,
          input_digest: "e2e",
          stats: { models: body.models },
          error_code: "",
          created_at: TIME,
          updated_at: TIME,
          finished_at: null,
        },
      };
    });
    await mockApi(page, "post", "/api/v1/tagger/cancel", { cancelled: true });
  }
}
