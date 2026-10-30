// 数据集接口的有状态模拟：建数据集、挂来源、排除/恢复都改内存里的状态，
// 后续的列表、详情、漏斗、成员请求按新状态回答，和真实后端一样。
//
//   const backend = new FakeDatasets();
//   await backend.install(page);
//   const id = backend.add({ name: "角色 A", members: 30 }); // 也可以先放好数据
//
// 用 `path` 挂来源时，每个文件夹带 `importSize` 张图（默认 24）。

import type { Page, Request } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import { errorEnvelope, mockApi } from "./api";

type Schemas = components["schemas"];
type Stage = Schemas["DatasetFunnelStageResponse"]["stage"];
type Kind = Schemas["DatasetSummaryResponse"]["kind"];
type Member = Schemas["DatasetMemberResponse"];
type Root = Schemas["DatasetRootResponse"];

const STAGES: readonly Stage[] = ["collect", "clean", "dedup", "tag", "review", "export"];
const TIME = 1_760_000_000;

/** 1×1 的灰色 PNG，缩略图和原图都用它。 */
export const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

interface FakeDataset {
  readonly dataset_id: string;
  name: string;
  kind: Kind;
  trigger_word: string;
  readonly created_at: number;
  updated_at: number;
  readonly roots: Root[];
  members: Member[];
  /** 采集段被排除的 asset_id。 */
  readonly excluded: Set<string>;
}

export interface FakeDatasetInit {
  readonly name: string;
  readonly kind?: Kind;
  readonly trigger_word?: string;
  /** 预先挂一个有这么多张图的文件夹。 */
  readonly members?: number;
}

function idOf(request: Request, index = 0): string {
  const match = new URL(request.url()).pathname.match(/\/datasets\/([^/]+)(?:\/roots\/([^/]+))?/);
  return decodeURIComponent(match?.[index + 1] ?? "");
}

const missing = () => ({ status: 404, body: errorEnvelope("dataset_not_found", "数据集不存在") });

export class FakeDatasets {
  readonly datasets = new Map<string, FakeDataset>();
  /** 收到的决定请求（按顺序），用例里可以检查请求体。 */
  readonly decisions: Schemas["DatasetDecisionRequest"][] = [];
  /** 每个数据集还没算完哈希的张数（默认 0）；改了以后要靠 dataset.updated reason=hashing 让页面重新取。 */
  readonly hashPending = new Map<string, number>();
  /** `POST /roots { path }` 挂上的文件夹里有几张图。 */
  importSize = 24;
  private sequence = 0;

  add(init: FakeDatasetInit): string {
    const dataset_id = `ds${++this.sequence}`;
    this.datasets.set(dataset_id, {
      dataset_id,
      name: init.name,
      kind: init.kind ?? "character",
      trigger_word: init.trigger_word ?? "",
      created_at: TIME,
      updated_at: TIME,
      roots: [],
      members: [],
      excluded: new Set(),
    });
    if (init.members) this.attachFolder(dataset_id, `/data/${init.name}`, init.members);
    return dataset_id;
  }

  attachFolder(id: string, path: string, count: number): Root {
    const dataset = this.require(id);
    const n = ++this.sequence;
    const name = path.split("/").filter(Boolean).at(-1) ?? path;
    const root: Root = {
      root_id: `root${n}`,
      dataset_id: id,
      directory_id: `dir${n}`,
      source_id: `src${n}`,
      source_kind: "local",
      source_display_name: name,
      name,
      relative_path: "",
      origin: "import",
      available: true,
      recursive_asset_count: count,
      created_at: TIME,
    };
    dataset.roots.push(root);
    for (let index = 0; index < count; index += 1) {
      const asset_id = `a${n}-${String(index + 1).padStart(3, "0")}`;
      dataset.members.push({
        asset_id,
        content_sha256: asset_id.padEnd(64, "0"),
        name: `${name}-${String(index + 1).padStart(3, "0")}.png`,
        relative_path: `${String(index + 1).padStart(3, "0")}.png`,
        directory_id: root.directory_id,
        source_id: root.source_id,
        format: "png",
        width: 832,
        height: 1216,
        size_bytes: 120_000,
        lifecycle_state: "active",
        txt_state: "normal",
        dedup_visibility: "kept",
        thumbnail_url: `/api/v1/gallery/assets/${asset_id}/thumbnail?size=256`,
        decisions: [],
      });
    }
    dataset.updated_at += 1;
    return root;
  }

  funnel(id: string): Schemas["DatasetFunnelResponse"] {
    const dataset = this.require(id);
    let input = dataset.members.length;
    const stages = STAGES.map((stage): Schemas["DatasetFunnelStageResponse"] => {
      const excluded = stage === "collect" ? dataset.excluded.size : 0;
      const row = {
        stage,
        input,
        excluded,
        approved: 0,
        output: input - excluded,
        status: "idle" as const,
        stale: false,
        input_digest: `${stage}-${input}`,
        last_run: null,
      };
      input = row.output;
      return row;
    });
    return { dataset_id: id, member_count: dataset.members.length, stages };
  }

  summary(id: string): Schemas["DatasetSummaryResponse"] {
    const dataset = this.require(id);
    const { stages, member_count } = this.funnel(id);
    const cover = dataset.members[0];
    return {
      dataset_id: id,
      name: dataset.name,
      kind: dataset.kind,
      trigger_word: dataset.trigger_word,
      config: {},
      created_at: dataset.created_at,
      updated_at: dataset.updated_at,
      member_count,
      root_count: dataset.roots.length,
      output_count: stages.at(-1)?.output ?? 0,
      stage_outputs: stages.map(({ stage, output, stale }) => ({ stage, output, stale })),
      cover_asset_id: cover?.asset_id ?? null,
      cover_thumbnail_url: cover?.thumbnail_url ?? null,
    };
  }

  detail(id: string): Schemas["DatasetDetailResponse"] {
    return { ...this.summary(id), funnel: this.funnel(id).stages };
  }

  private require(id: string): FakeDataset {
    const dataset = this.datasets.get(id);
    if (!dataset) throw new Error(`没有数据集 ${id}`);
    return dataset;
  }

  private member(dataset: FakeDataset, member: Member): Member {
    return dataset.excluded.has(member.asset_id)
      ? { ...member, decisions: [{ stage: "collect", decision: "exclude", reason: "" }] }
      : member;
  }

  /** 注册全部数据集相关接口；在 `page.goto()` 之前调用。 */
  async install(page: Page): Promise<void> {
    await page.route(
      (url) => /^\/api\/v1\/gallery\/assets\/[^/]+\/(?:thumbnail|content)$/.test(url.pathname),
      (route) => route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG }),
    );

    await mockApi(page, "get", "/api/v1/datasets", () => ({
      body: { items: [...this.datasets.keys()].map((id) => this.summary(id)) },
    }));
    await mockApi(page, "post", "/api/v1/datasets", (request) => {
      const body = request.postDataJSON() as Schemas["DatasetCreateRequest"];
      const id = this.add({ name: body.name, kind: body.kind, trigger_word: body.trigger_word });
      return { status: 201, body: this.detail(id) };
    });
    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}", (request) =>
      this.datasets.has(idOf(request)) ? { body: this.detail(idOf(request)) } : missing(),
    );
    await mockApi(page, "patch", "/api/v1/datasets/{dataset_id}", (request) => {
      const dataset = this.datasets.get(idOf(request));
      if (!dataset) return missing();
      const patch = request.postDataJSON() as Schemas["DatasetPatchRequest"];
      if (patch.name != null) dataset.name = patch.name;
      if (patch.kind != null) dataset.kind = patch.kind;
      if (patch.trigger_word != null) dataset.trigger_word = patch.trigger_word;
      dataset.updated_at += 1;
      return { body: this.detail(dataset.dataset_id) };
    });
    await mockApi(page, "delete", "/api/v1/datasets/{dataset_id}", (request) => {
      if (!this.datasets.delete(idOf(request))) return missing();
      return { status: 204 };
    });
    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/funnel", (request) =>
      this.datasets.has(idOf(request)) ? { body: this.funnel(idOf(request)) } : missing(),
    );

    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/roots", (request) => {
      const dataset = this.datasets.get(idOf(request));
      return dataset ? { body: { items: dataset.roots } } : missing();
    });
    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/roots", (request) => {
      const id = idOf(request);
      if (!this.datasets.has(id)) return missing();
      const body = request.postDataJSON() as Schemas["DatasetRootCreateRequest"];
      if (!body.path) return { status: 422, body: errorEnvelope("validation_error", "模拟后端只支持 path") };
      return { status: 201, body: this.attachFolder(id, body.path, this.importSize) };
    });
    await mockApi(page, "delete", "/api/v1/datasets/{dataset_id}/roots/{root_id}", (request) => {
      const dataset = this.datasets.get(idOf(request));
      const rootId = idOf(request, 1);
      const root = dataset?.roots.find((item) => item.root_id === rootId);
      if (!dataset || !root) return missing();
      dataset.roots.splice(dataset.roots.indexOf(root), 1);
      dataset.members = dataset.members.filter((member) => member.directory_id !== root.directory_id);
      return { status: 204 };
    });

    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/members", (request) => {
      const dataset = this.datasets.get(idOf(request));
      if (!dataset) return missing();
      const params = new URL(request.url()).searchParams;
      const decision = params.get("decision");
      const query = (params.get("query") ?? "").toLowerCase();
      const offset = Number(params.get("cursor") ?? 0);
      const limit = Number(params.get("limit") ?? 200);
      const matches = dataset.members.filter((member) => {
        const excluded = dataset.excluded.has(member.asset_id);
        if (decision === "excluded" && !excluded) return false;
        if ((decision === "undecided" || decision === "approved" || decision === "kept") && excluded) return false;
        if (decision === "approved") return false;
        return !query || member.name.toLowerCase().includes(query);
      });
      const items = matches.slice(offset, offset + limit).map((member) => this.member(dataset, member));
      const next = offset + limit < matches.length ? String(offset + limit) : null;
      return { body: { items, total: matches.length, limit, next_cursor: next } };
    });
    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/decisions", (request) => {
      const dataset = this.datasets.get(idOf(request));
      if (!dataset) return missing();
      const body = request.postDataJSON() as Schemas["DatasetDecisionRequest"];
      this.decisions.push(body);
      for (const assetId of body.asset_ids) {
        if (body.decision === "exclude") dataset.excluded.add(assetId);
        else dataset.excluded.delete(assetId);
      }
      dataset.updated_at += 1;
      return { body: { funnel: this.funnel(dataset.dataset_id), updated: body.asset_ids.length } };
    });

    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/hashing", (request) => {
      const dataset = this.datasets.get(idOf(request));
      if (!dataset) return missing();
      const count = dataset.members.length;
      const pending = Math.min(count, this.hashPending.get(dataset.dataset_id) ?? 0);
      return { body: { hashed_count: count - pending, member_count: count, pending } };
    });
    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/crawls", (request) =>
      this.datasets.has(idOf(request)) ? { body: { items: [] } } : missing(),
    );
    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/stage-runs", (request) =>
      this.datasets.has(idOf(request)) ? { body: { items: [] } } : missing(),
    );
  }
}
