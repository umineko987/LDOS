// caption 接口的有状态模拟：全量列表（带 ETag / 304）、单张编辑、批量操作、从打标写入、批次历史和撤销，
// 以及 review 阶段的校对决定（approve / clear）。写入都改内存里的状态，后续请求按新状态回答。
//
//   const datasets = new FakeDatasets();
//   const id = datasets.add({ name: "studio", members: 12, trigger_word: "sks" });
//   await datasets.install(page);
//   const captions = new FakeCaptions(datasets);
//   captions.set("a2-001", "sks, 1girl, hat");
//   await captions.install(page, tagger);   // tagger 可选，从打标写入要用
//
// 标签规则用前端的移植（src/lib/domain/captions.ts），它和后端 caption_tags.py 一致。
// 版本号每次写入加一；带 expected_version / expected_versions 的写入对不上时报冲突。

import type { Page, Request, Route } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import {
  applyOps,
  diffTags,
  formatCaption,
  mergeTaggerTags,
  parseCaption,
  sameTags,
  type CaptionMode,
  type CaptionOp,
} from "../../src/lib/domain/captions.ts";
import { errorEnvelope, mockApi } from "./api";
import type { FakeDatasets } from "./datasets";
import type { FakeTagger } from "./tagger";

type Schemas = components["schemas"];
type CaptionState = Schemas["CaptionItem"]["state"];

interface Entry {
  tags: string[];
  state: CaptionState;
  version: number;
}

/** 撤销要用的：写入前的标签和状态、写入后的标签（撤销时已经不是它就是之后又被改过，算冲突）、写入前上次打标的标签。 */
interface Saved {
  readonly tags: string[];
  readonly state: CaptionState;
  readonly after: string[];
  readonly previous: string[] | undefined;
}

interface Batch {
  readonly summary: Schemas["CaptionBatchSummary"];
  readonly before: Map<string, Saved>;
}

const TIME = 1_760_000_000;

function idOf(request: Request): string {
  return decodeURIComponent(new URL(request.url()).pathname.match(/\/datasets\/([^/]+)/)?.[1] ?? "");
}

const missing = () => ({ status: 404, body: errorEnvelope("dataset_not_found", "数据集不存在") });

export class FakeCaptions {
  readonly entries = new Map<string, Entry>();
  /** 上一次从打标写进每张图的标签（merge 模式要用）。 */
  readonly previous = new Map<string, string[]>();
  readonly batches: Batch[] = [];
  /** review 阶段已校对的图。 */
  readonly approved = new Set<string>();
  /** 收到的写请求（按顺序），用例里可以检查请求体。 */
  readonly requests: { path: string; body: unknown }[] = [];
  /** 接下来这么多次撤销一张都恢复不了（像来源离线）：批次保持可撤销，可以重试。 */
  undoOutages = 0;
  private generation = 1;
  private sequence = 0;

  constructor(private readonly datasets: FakeDatasets) {}

  /** 设一张图的 caption 文本（空串 = blank）。 */
  set(assetId: string, text: string): void {
    const entry = this.entry(assetId);
    entry.tags = parseCaption(text);
    entry.state = text ? "normal" : "blank";
    entry.version += 1;
    this.generation += 1;
  }

  tags(assetId: string): string[] {
    return [...(this.entries.get(assetId)?.tags ?? [])];
  }

  private entry(assetId: string): Entry {
    let entry = this.entries.get(assetId);
    if (!entry) {
      entry = { tags: [], state: "missing", version: 0 };
      this.entries.set(assetId, entry);
    }
    return entry;
  }

  /** review 阶段的输入：采集段没排除的成员。 */
  private inputs(datasetId: string) {
    const dataset = this.datasets.datasets.get(datasetId);
    if (!dataset) return null;
    return { dataset, members: dataset.members.filter((member) => !dataset.excluded.has(member.asset_id)) };
  }

  private versionOf(entry: Entry): string {
    return entry.state === "missing" ? "missing" : `v${entry.version}`;
  }

  private item(assetId: string, name: string): Schemas["CaptionItem"] {
    const entry = this.entry(assetId);
    return { asset_id: assetId, name, state: entry.state, text: formatCaption(entry.tags), tags: [...entry.tags], version: this.versionOf(entry) };
  }

  /**
   * 把一组新标签写进去（或只预览），返回 CaptionBatchResult。`next` 返回 null 表示跳过这张。
   */
  private write(
    datasetId: string,
    assetIds: readonly string[],
    next: (assetId: string, entry: Entry) => string[] | null,
    { dryRun, kind, params, sampleLimit, expected }: {
      dryRun: boolean;
      kind: Schemas["CaptionBatchSummary"]["kind"];
      params: Record<string, unknown>;
      sampleLimit: number;
      expected?: Readonly<Record<string, string>> | null;
    },
    after?: (assetId: string, tags: string[]) => void,
  ): Schemas["CaptionBatchResult"] {
    const stats = { total: assetIds.length, changed: 0, new: 0, unchanged: 0, skipped: 0, conflicts: 0, written: 0, failed: 0 };
    const samples: Schemas["CaptionDiffSample"][] = [];
    const skipped: Schemas["CaptionReportItem"][] = [];
    const conflicts: Schemas["CaptionReportItem"][] = [];
    const changes: [string, Entry, string[]][] = [];
    for (const assetId of assetIds) {
      const entry = this.entry(assetId);
      const wanted = expected?.[assetId];
      if (wanted !== undefined && wanted !== this.versionOf(entry)) {
        stats.conflicts += 1;
        conflicts.push({ asset_id: assetId, reason: "caption_version_conflict" });
        continue;
      }
      const tags = next(assetId, entry);
      if (tags === null) {
        stats.skipped += 1;
        skipped.push({ asset_id: assetId, reason: "no_tagger_result" });
        continue;
      }
      if (sameTags(entry.tags, tags) && entry.state !== "missing") {
        stats.unchanged += 1;
        continue;
      }
      const change = entry.tags.length ? "changed" : "new";
      stats[change] += 1;
      if (samples.length < sampleLimit) {
        samples.push({ asset_id: assetId, change, before: [...entry.tags], after: tags, ...diffTags(entry.tags, tags) });
      }
      changes.push([assetId, entry, tags]);
    }
    let batchId: string | null = null;
    if (!dryRun && changes.length) {
      batchId = `cb${++this.sequence}`;
      const before = new Map<string, Saved>();
      for (const [assetId, entry, tags] of changes) {
        before.set(assetId, { tags: entry.tags, state: entry.state, after: tags, previous: this.previous.get(assetId) });
        entry.tags = tags;
        entry.state = tags.length ? "normal" : "blank";
        entry.version += 1;
        after?.(assetId, tags);
      }
      stats.written = changes.length;
      this.generation += 1;
      this.batches.unshift({
        summary: {
          batch_id: batchId,
          dataset_id: datasetId,
          kind,
          params,
          stats: { ...stats },
          changed_count: changes.length,
          created_at: TIME + this.sequence,
          undone_at: null,
          undo_stats: {},
          can_undo: true,
        },
        before,
      });
    }
    return { dataset_id: datasetId, dry_run: dryRun, batch_id: batchId, stats, samples, skipped, conflicts, failed: [] };
  }

  /** 注册 caption 接口和 review 阶段的决定；在 `FakeDatasets.install` 之后、`page.goto()` 之前调用。 */
  async install(page: Page, tagger?: FakeTagger): Promise<void> {
    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/captions", (request) => {
      const id = idOf(request);
      const inputs = this.inputs(id);
      if (!inputs) return missing();
      const etag = `"cap-${this.generation}-${inputs.members.length}"`;
      if (request.headers()["if-none-match"] === etag) return { status: 304, headers: { ETag: etag } };
      return {
        headers: { ETag: etag },
        body: {
          dataset_id: id,
          trigger_word: inputs.dataset.trigger_word,
          etag,
          items: inputs.members.map((member) => this.item(member.asset_id, member.name)),
        },
      };
    });

    await mockApi(page, "put", "/api/v1/datasets/{dataset_id}/captions/{asset_id}", (request) => {
      const id = idOf(request);
      const assetId = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-1) ?? "");
      const body = request.postDataJSON() as Schemas["CaptionEditRequest"];
      this.requests.push({ path: "edit", body: { asset_id: assetId, ...body } });
      const inputs = this.inputs(id);
      if (!inputs) return missing();
      const member = inputs.members.find((item) => item.asset_id === assetId);
      if (!member) return { status: 404, body: errorEnvelope("caption_not_found", "不在 review 阶段的输入里") };
      const tags = parseCaption(body.text);
      const result = this.write(id, [assetId], () => tags, {
        dryRun: false,
        kind: "edit",
        params: {},
        sampleLimit: 0,
        expected: { [assetId]: body.expected_version },
      });
      if (result.stats.conflicts) return { status: 409, body: errorEnvelope("caption_version_conflict", "caption 已被改过") };
      const item = this.item(assetId, member.name);
      return { body: { batch_id: result.batch_id, caption: { asset_id: assetId, state: item.state, text: item.text, tags: item.tags, version: item.version } } };
    });

    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/captions/ops", (request) => {
      const id = idOf(request);
      const body = request.postDataJSON() as Schemas["CaptionOpsRequest"];
      this.requests.push({ path: "ops", body });
      const inputs = this.inputs(id);
      if (!inputs) return missing();
      const trigger = inputs.dataset.trigger_word;
      const ops = body.ops as CaptionOp[];
      return {
        body: this.write(id, body.asset_ids, (_assetId, entry) => applyOps(entry.tags, ops, trigger), {
          dryRun: body.dry_run === true,
          kind: "ops",
          params: { ops: body.ops },
          sampleLimit: body.sample_limit ?? 20,
          expected: body.expected_versions,
        }),
      };
    });

    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/captions/from-tagger", (request) => {
      const id = idOf(request);
      const body = request.postDataJSON() as Schemas["CaptionsFromTaggerRequest"];
      this.requests.push({ path: "from-tagger", body });
      const inputs = this.inputs(id);
      if (!inputs) return missing();
      const trigger = inputs.dataset.trigger_word;
      const mode = (body.mode ?? "merge") as CaptionMode;
      const assetIds = body.asset_ids ?? inputs.members.map((member) => member.asset_id);
      return {
        body: this.write(
          id,
          assetIds,
          (assetId, entry) => {
            const composed = tagger?.compose(assetId, body) ?? null;
            if (composed === null) return null;
            return mergeTaggerTags(entry.tags, composed, { previous: this.previous.get(assetId) ?? null, mode, triggerWord: trigger });
          },
          {
            dryRun: body.dry_run === true,
            kind: "from_tagger",
            params: {
              models: body.models,
              thresholds: body.thresholds ?? {},
              categories: body.categories ?? [],
              keep_underscores: body.keep_underscores === true,
              escape_parens: body.escape_parens === true,
            },
            sampleLimit: body.sample_limit ?? 20,
          },
          (assetId) => {
            const composed = tagger?.compose(assetId, body);
            if (composed) this.previous.set(assetId, composed);
          },
        ),
      };
    });

    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/caption-batches", (request) => {
      const id = idOf(request);
      if (!this.datasets.datasets.has(id)) return missing();
      const limit = Number(new URL(request.url()).searchParams.get("limit") ?? 50);
      return { body: { items: this.batches.filter((batch) => batch.summary.dataset_id === id).slice(0, limit).map((batch) => batch.summary) } };
    });

    await mockApi(page, "post", "/api/v1/caption-batches/{batch_id}/undo", (request) => {
      const batchId = decodeURIComponent(new URL(request.url()).pathname.split("/").at(-2) ?? "");
      this.requests.push({ path: "undo", body: { batch_id: batchId } });
      const index = this.batches.findIndex((batch) => batch.summary.batch_id === batchId);
      const batch = this.batches[index];
      if (!batch || batch.summary.undone_at !== null) {
        return { status: 409, body: errorEnvelope("caption_batch_not_undoable", "这个批次不能撤销") };
      }
      if (this.undoOutages > 0) {
        this.undoOutages -= 1;
        const failed = [...batch.before.keys()].map((asset_id) => ({ asset_id, reason: "source_offline" }));
        const stats = { total: failed.length, restored: 0, conflicts: 0, failed: failed.length };
        this.batches[index] = { ...batch, summary: { ...batch.summary, undo_stats: stats } };
        return { body: { batch_id: batchId, dataset_id: batch.summary.dataset_id, undone: false, stats, conflicts: [], failed } };
      }
      const stats = { total: batch.before.size, restored: 0, conflicts: 0, failed: 0 };
      const conflicts: Schemas["CaptionReportItem"][] = [];
      for (const [assetId, saved] of batch.before) {
        const entry = this.entry(assetId);
        if (!sameTags(entry.tags, saved.after)) {
          stats.conflicts += 1;
          conflicts.push({ asset_id: assetId, reason: "caption_changed_since_batch" });
          continue;
        }
        entry.tags = saved.tags;
        entry.state = saved.state;
        entry.version += 1;
        if (saved.previous) this.previous.set(assetId, saved.previous);
        else this.previous.delete(assetId);
        stats.restored += 1;
      }
      this.generation += 1;
      this.batches[index] = { ...batch, summary: { ...batch.summary, undone_at: TIME + 1000, can_undo: false, undo_stats: stats } };
      return { body: { batch_id: batchId, dataset_id: batch.summary.dataset_id, undone: true, stats, conflicts, failed: [] } };
    });

    // review 阶段的决定：只接管 stage=review 的请求，其余交给 FakeDatasets。
    const membersPattern = /^\/api\/v1\/datasets\/[^/]+\/members$/;
    await page.route(
      (url) => membersPattern.test(url.pathname),
      async (route: Route, request: Request) => {
        const params = new URL(request.url()).searchParams;
        if (request.method() !== "GET" || params.get("stage") !== "review" || params.get("decision") !== "approved") {
          return route.fallback();
        }
        const inputs = this.inputs(idOf(request));
        if (!inputs) return route.fulfill({ status: 404, json: missing().body });
        const items = inputs.members.filter((member) => this.approved.has(member.asset_id));
        await route.fulfill({ json: { items, total: items.length, limit: Number(params.get("limit") ?? 200), next_cursor: null } });
      },
    );
    const decisionsPattern = /^\/api\/v1\/datasets\/[^/]+\/decisions$/;
    await page.route(
      (url) => decisionsPattern.test(url.pathname),
      async (route: Route, request: Request) => {
        const body = request.method() === "POST" ? (request.postDataJSON() as Schemas["DatasetDecisionRequest"]) : null;
        if (!body || body.stage !== "review") return route.fallback();
        this.requests.push({ path: "decisions", body });
        for (const assetId of body.asset_ids) {
          if (body.decision === "approve") this.approved.add(assetId);
          else this.approved.delete(assetId);
        }
        await route.fulfill({ json: { funnel: this.datasets.funnel(idOf(request)), updated: body.asset_ids.length } });
      },
    );
  }
}
