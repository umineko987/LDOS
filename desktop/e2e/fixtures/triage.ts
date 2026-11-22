// 清洗 / 去重两段的有状态模拟：运行、分诊摘要、命中列表、分组、定夺、撤销都改内存里的状态，
// 后续请求按新状态回答；漏斗减掉被剔除的图（包装 FakeDatasets.funnel，阶段轨道的计数跟着变）。
//
//   const datasets = new FakeDatasets();
//   await datasets.install(page);
//   const id = datasets.add({ name: "角色 A", members: 24 }); // ds1，图是 a2-001 … a2-024
//   const triage = new FakeTriage(datasets, id, {
//     clean: [{ asset: "a2-001", reasons: ["monochrome"] }],
//     dedup: [{ id: "g1", members: ["a2-001", "a2-002"], keep: ["a2-001"] }],
//   });
//   await triage.install(page);
//
// 运行的响应是“分析中”，之后第一次读摘要时分析结束；`ready` 里的段一开始就分析好了。

import type { Page, Request } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import { errorEnvelope, mockApi } from "./api";
import { PIXEL_PNG, type FakeDatasets } from "./datasets";
import { model, mockModelsBackend } from "./settings";

type Schemas = components["schemas"];
type Stage = "clean" | "dedup";
type Summary = Schemas["StageTriageSummaryResponse"];
type Member = Schemas["TriageMemberResponse"];
type CleanItem = Schemas["CleanItemResponse"];
type DedupGroup = Schemas["DedupGroupResponse"];
type DatasetMember = Schemas["DatasetMemberResponse"];
type ReviewStatus = NonNullable<Summary["review_status"]>;
export type CleanReason = CleanItem["reasons"][number];

const TIME = 1_760_000_000;

export interface CleanFlag {
  readonly asset: string;
  readonly reasons: readonly CleanReason[];
}

export interface DedupSpec {
  readonly id: string;
  readonly kind?: DedupGroup["kind"];
  readonly members: readonly string[];
  /** 推荐保留（后端的 suggested_keep）；自动组忽略。 */
  readonly keep?: readonly string[];
  /** 自动组：保留下来、不在组里的那张。组里的都已被回收。 */
  readonly winner?: string;
}

export interface FakeTriageInit {
  readonly clean?: readonly CleanFlag[];
  readonly dedup?: readonly DedupSpec[];
  /** 一开始就分析好了的段。 */
  readonly ready?: readonly Stage[];
}

interface Group {
  readonly id: string;
  readonly kind: DedupGroup["kind"] | "clean";
  readonly automatic: boolean;
  readonly members: readonly string[];
  readonly suggested: readonly string[];
  readonly reasons: readonly CleanReason[];
  readonly winner: string | null;
  decided: boolean;
  kept: Set<string>;
}

interface Snapshot {
  readonly decided: boolean;
  readonly kept: ReadonlySet<string>;
}

interface StageState {
  run: Schemas["DatasetStageRunResponse"] | null;
  review: ReviewStatus | null;
  groups: Group[];
  readonly batches: { readonly id: string; readonly before: ReadonlyMap<string, Snapshot> }[];
}

/** 两段都用得到的模型全部装好（ModelGate 不挡路）。 */
export const TRIAGE_MODELS = [
  model("sscd", { status: "installed", installed_bytes: 1 }),
  model("dino", { status: "installed", installed_bytes: 1, used_by: ["dedup", "atlas"] }),
  model("ccip", { status: "installed", installed_bytes: 1, used_by: ["clean"] }),
  model("completeness", { status: "installed", installed_bytes: 1, used_by: ["clean"] }),
  model("monochrome", { status: "installed", installed_bytes: 1, used_by: ["clean"] }),
];


function stageOf(request: Request): Stage {
  return new URL(request.url()).pathname.includes("/stages/dedup/") ? "dedup" : "clean";
}

const notReady = () => ({ status: 409, body: errorEnvelope("triage_not_ready", "还没有可以分诊的结果") });

export class FakeTriage {
  /** 收到的请求（按顺序），用例里检查请求体。 */
  readonly runs: { stage: Stage; body: Schemas["StageRunRequest"] | null }[] = [];
  readonly applies: { stage: Stage; body: Schemas["TriageApplyRequest"] }[] = [];
  readonly undos: { stage: Stage; body: Schemas["TriageUndoRequest"] | null }[] = [];

  private readonly stages: Record<Stage, StageState> = {
    clean: { run: null, review: null, groups: [], batches: [] },
    dedup: { run: null, review: null, groups: [], batches: [] },
  };
  private sequence = 0;

  constructor(
    private readonly datasets: FakeDatasets,
    private readonly datasetId: string,
    private readonly init: FakeTriageInit = {},
  ) {
    for (const stage of init.ready ?? []) {
      this.start(stage);
      this.stages[stage].review = "ready";
    }
    // 漏斗：清洗、去重段减掉被剔除的图，后面的段按新的输入往下算。
    const base = datasets.funnel.bind(datasets);
    datasets.funnel = (id) => {
      const funnel = base(id);
      if (id !== this.datasetId) return funnel;
      let input = funnel.stages[0]?.input ?? 0;
      const stages = funnel.stages.map((row) => {
        const excluded = row.stage === "clean" || row.stage === "dedup" ? this.removed(row.stage).size : row.excluded;
        const next = { ...row, input, excluded, output: input - excluded };
        input = next.output;
        return next;
      });
      return { ...funnel, stages };
    };
  }

  /** 被剔除的图（手动定夺的和自动回收的）。 */
  removed(stage: Stage): Set<string> {
    const removed = new Set<string>();
    for (const group of this.stages[stage].groups) {
      if (!group.decided) continue;
      for (const asset of group.members) if (!group.kept.has(asset)) removed.add(asset);
    }
    return removed;
  }

  private start(stage: Stage): void {
    const state = this.stages[stage];
    const n = ++this.sequence;
    state.run = {
      run_id: `run-${stage}-${n}`,
      dataset_id: this.datasetId,
      stage,
      status: "succeeded",
      error_code: "",
      input_digest: `${stage}-${n}`,
      ref_id: `review-${stage}-${n}`,
      stats: {},
      created_at: TIME + n,
      updated_at: TIME + n,
      finished_at: TIME + n,
    };
    state.review = "analyzing";
    state.batches.length = 0;
    state.groups =
      stage === "clean"
        ? (this.init.clean ?? []).map((flag) => ({
            id: `clean:${flag.asset}`,
            kind: "clean" as const,
            automatic: false,
            members: [flag.asset],
            suggested: [],
            reasons: flag.reasons,
            winner: null,
            decided: false,
            kept: new Set<string>(),
          }))
        : (this.init.dedup ?? []).map((spec) => {
            const kind = spec.kind ?? "duplicate";
            const automatic = kind === "auto_exact" || kind === "auto_compression";
            return {
              id: spec.id,
              kind,
              automatic,
              members: spec.members,
              suggested: automatic ? [] : (spec.keep ?? []),
              reasons: [],
              winner: spec.winner ?? null,
              // 自动组一跑完就已经回收了。
              decided: automatic,
              kept: new Set<string>(),
            };
          });
  }

  summary(stage: Stage): Summary {
    const state = this.stages[stage];
    const manual = state.groups.filter((group) => !group.automatic);
    const decided = manual.filter((group) => group.decided);
    const count = (pick: (group: Group) => number) => decided.reduce((sum, group) => sum + pick(group), 0);
    const automaticExcluded = state.groups
      .filter((group) => group.automatic)
      .reduce((sum, group) => sum + group.members.filter((asset) => !group.kept.has(asset)).length, 0);
    return {
      dataset_id: this.datasetId,
      stage,
      run: state.run,
      review_id: state.run?.ref_id ?? null,
      review_status: state.review,
      review_error: "",
      last_batch_id: state.batches.at(-1)?.id ?? null,
      undo_depth: state.batches.length,
      counts: {
        input: this.datasets.datasets.get(this.datasetId)?.members.length ?? 0,
        flagged: manual.reduce((sum, group) => sum + group.members.length, 0),
        groups: manual.length,
        decided_groups: decided.length,
        pending_groups: manual.length - decided.length,
        kept: count((group) => group.kept.size),
        rejected: count((group) => group.members.length - group.kept.size),
        automatic_excluded: automaticExcluded,
        failed: 0,
      },
    };
  }

  private member(stage: Stage, group: Group, asset: string): Member {
    const source = this.datasets.datasets.get(this.datasetId)?.members.find((item: DatasetMember) => item.asset_id === asset);
    if (!source) throw new Error(`数据集里没有 ${asset}`);
    const kept = group.kept.has(asset);
    const classification = group.reasons.find((reason): reason is "monochrome" | "rough" => reason === "monochrome" || reason === "rough");
    return {
      asset_id: asset,
      name: source.name,
      relative_path: source.relative_path,
      source_id: source.source_id,
      format: source.format,
      width: source.width ?? 832,
      height: source.height ?? 1216,
      size_bytes: source.size_bytes,
      thumbnail_url: source.thumbnail_url,
      image_url: `/api/v1/gallery/reviews/${this.stages[stage].run?.ref_id}/images/${asset}`,
      classification: classification ?? null,
      decision: group.decided && !kept ? "exclude" : null,
      disposition: group.decided ? (kept ? "kept" : "rejected") : "pending",
      selected: group.decided ? kept : group.suggested.includes(asset),
      recommended: group.suggested.includes(asset),
      readable: true,
      error: "",
      quality: {},
      review_metrics: null,
      trashed: false,
    };
  }

  private cleanItem(group: Group): CleanItem {
    return {
      ...this.member("clean", group, group.members[0]!),
      automatic: false,
      decided: group.decided,
      group_id: group.id,
      group_kind: "clean",
      reasons: [...group.reasons],
    };
  }

  private dedupGroup(group: Group): DedupGroup {
    return {
      group_id: group.id,
      kind: group.kind as DedupGroup["kind"],
      automatic: group.automatic,
      decided: group.decided,
      match_levels: [],
      reason: "",
      suggested_keep: [...group.suggested],
      winner_asset_id: group.winner,
      members: group.members.map((asset) => this.member("dedup", group, asset)),
    };
  }

  private page<T>(stage: Stage, request: Request, items: readonly T[]) {
    const params = new URL(request.url()).searchParams;
    const offset = Number(params.get("offset") ?? 0);
    const limit = Number(params.get("limit") ?? 50);
    const state = this.stages[stage];
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      offset,
      limit,
      review_id: state.run?.ref_id ?? "",
      run_id: state.run?.run_id ?? "",
    };
  }

  private ready(stage: Stage): boolean {
    return this.stages[stage].review === "ready";
  }

  /** 注册两段的分诊接口和模型列表；在 FakeDatasets.install 之后、`page.goto()` 之前调用。 */
  async install(page: Page): Promise<void> {
    await mockModelsBackend(page, { models: () => TRIAGE_MODELS });
    await page.route(
      (url) => /^\/api\/v1\/gallery\/reviews\/[^/]+\/images\/[^/]+$/.test(url.pathname),
      (route) => route.fulfill({ status: 200, contentType: "image/png", body: PIXEL_PNG }),
    );

    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/stages/{stage}/triage", (request) => {
      const stage = stageOf(request);
      // 运行的响应是“分析中”；之后第一次读摘要时分析就结束了。
      if (this.stages[stage].review === "analyzing") this.stages[stage].review = "ready";
      return { body: this.summary(stage) };
    });
    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/stages/{stage}/run", (request) => {
      const stage = stageOf(request);
      const body = request.postDataJSON() as Schemas["StageRunRequest"] | null;
      this.runs.push({ stage, body });
      this.start(stage);
      return { status: 202, body: this.summary(stage) };
    });

    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/stages/clean/items", (request) => {
      if (!this.ready("clean")) return notReady();
      const reason = new URL(request.url()).searchParams.get("reason");
      const groups = this.stages.clean.groups.filter((group) => !reason || group.reasons.includes(reason as CleanReason));
      return { body: this.page("clean", request, groups.map((group) => this.cleanItem(group))) };
    });
    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/stages/dedup/groups", (request) => {
      if (!this.ready("dedup")) return notReady();
      const automatic = new URL(request.url()).searchParams.get("include_automatic") === "true";
      const groups = this.stages.dedup.groups.filter((group) => automatic || !group.automatic);
      return { body: this.page("dedup", request, groups.map((group) => this.dedupGroup(group))) };
    });

    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/stages/{stage}/apply", (request) => {
      const stage = stageOf(request);
      const state = this.stages[stage];
      const body = request.postDataJSON() as Schemas["TriageApplyRequest"];
      this.applies.push({ stage, body });
      if (!this.ready(stage) || body.run_id !== state.run?.run_id) {
        return { status: 409, body: errorEnvelope("triage_run_stale", "这次运行已经过期") };
      }
      const before = new Map<string, Snapshot>();
      const kept: string[] = [];
      const rejected: string[] = [];
      for (const decision of body.groups) {
        const group = state.groups.find((item) => item.id === decision.group_id);
        if (!group) continue;
        before.set(group.id, { decided: group.decided, kept: new Set(group.kept) });
        const keep = new Set((decision.keep ?? []).filter((asset) => group.members.includes(asset)));
        group.decided = true;
        group.kept = keep;
        for (const asset of group.members) (keep.has(asset) ? kept : rejected).push(asset);
      }
      const batchId = `batch-${++this.sequence}`;
      state.batches.push({ id: batchId, before });
      return {
        body: { batch_id: batchId, applied_groups: before.size, kept, rejected, failed: [], error: null, summary: this.summary(stage) },
      };
    });
    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/stages/{stage}/undo", (request) => {
      const stage = stageOf(request);
      const state = this.stages[stage];
      const body = request.postDataJSON() as Schemas["TriageUndoRequest"] | null;
      this.undos.push({ stage, body });
      const top = state.batches.at(-1);
      if (!top) return { status: 409, body: errorEnvelope("triage_nothing_to_undo", "没有可以撤销的定夺") };
      if (body?.batch_id && body.batch_id !== top.id) {
        return { status: 409, body: errorEnvelope("triage_undo_not_latest", "只能撤销最近一批") };
      }
      state.batches.pop();
      for (const [id, snapshot] of top.before) {
        const group = state.groups.find((item) => item.id === id);
        if (!group) continue;
        group.decided = snapshot.decided;
        group.kept = new Set(snapshot.kept);
      }
      return { body: { batch_id: top.id, undone_groups: top.before.size, error: null, summary: this.summary(stage) } };
    });
  }
}
