// Studio captions and manual Keep share the actual asset IDs and sidecars from FakeLibrary.
import type { Page, Request } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import { applyOps, diffTags, formatCaption, parseCaption, sameTags } from "../../src/lib/domain/captions.ts";
import { errorEnvelope, mockApi } from "./api";
import type { FakeLibrary } from "./library";

type Schemas = components["schemas"];
type Asset = Schemas["GalleryAssetEntryResponse"];
type Change = { asset: Asset; before: string | null; after: string };
type Batch = { summary: Schemas["CaptionBatchSummary"]; changes: Change[] };
const pagePath = "/api/v1/gallery/sources/{source_id}";
const time = 1_760_000_000;
const fail = (status: number, code: string, message: string) => ({ status, body: errorEnvelope(code, message) });
const sourceMissing = () => fail(404, "source_not_found", "图库来源不存在");
const notInSource = () => fail(422, "caption_asset_not_in_source", "图片不在此来源中或当前不可见");
const segment = (request: Request, index: number) => decodeURIComponent(new URL(request.url()).pathname.split("/")[index]!);
const bodyOf = <T>(request: Request) => request.postDataJSON() as T;

export class FakeGalleryStudio {
  readonly kept = new Set<string>();
  readonly requests: { method: string; path: string; body: unknown }[] = [];
  undoOutages = 0;
  private readonly batches: Batch[] = [];

  constructor(readonly library: FakeLibrary) {}

  /** Simulated files visible at the source, not in its trash. */
  files(assetId: string) {
    const asset = this.library.assets.get(assetId)!;
    if (asset.lifecycle_state !== "active") return null;
    const content = this.library.annotations.get(assetId)!.content;
    return { image: asset.relative_path, txt: asset.txt_relative_path ?? null, content };
  }

  seed(assetId: string, text: string | null) {
    const asset = this.library.assets.get(assetId)!;
    const annotation = this.library.annotations.get(assetId)!;
    annotation.content = text;
    this.library.assets.set(assetId, {
      ...asset,
      txt_state: text === null ? "missing" : text ? "normal" : "blank",
      txt_relative_path: text === null ? null : `${asset.relative_path.slice(0, -asset.extension.length)}.txt`,
      txt_size_bytes: text === null ? 0 : Buffer.byteLength(text),
      txt_version: annotation.txt_version,
    });
  }

  private eligible(sourceId: string, assetId: string): Asset | undefined {
    const asset = this.library.assets.get(assetId);
    return asset?.source_id === sourceId && asset.lifecycle_state === "active" && asset.dedup_visibility !== "excluded" ? asset : undefined;
  }

  private item(asset: Asset): Schemas["CaptionItem"] {
    const annotation = this.library.annotations.get(asset.asset_id)!;
    const text = annotation.content ?? "";
    return { asset_id: asset.asset_id, name: asset.name, text, tags: parseCaption(text), state: asset.txt_state, version: annotation.content === null ? "missing" : annotation.disk_version };
  }

  private write(assetId: string, content: string | null) {
    const annotation = this.library.annotations.get(assetId)!;
    annotation.txt_version += 1;
    annotation.disk_version = `v${annotation.txt_version}`;
    this.seed(assetId, content);
  }

  private batch(sourceId: string, kind: "edit" | "ops", changes: Change[], stats: Schemas["CaptionWriteStats"], params: Record<string, unknown>) {
    if (!changes.length) return null;
    for (const { asset, after } of changes) this.write(asset.asset_id, after);
    const batchId = `gallery-caption-${this.batches.length + 1}`;
    this.batches.unshift({ summary: {
      batch_id: batchId, dataset_id: null, source_id: sourceId, kind, params, stats, changed_count: changes.length,
      created_at: time + this.batches.length, undone_at: null, undo_stats: {}, can_undo: true,
    }, changes });
    return batchId;
  }

  async install(page: Page) {
    const record = (request: Request) => {
      this.requests.push({ method: request.method(), path: new URL(request.url()).pathname, body: request.postData() ? request.postDataJSON() : null });
      return segment(request, 5);
    };
    await mockApi(page, "get", `${pagePath}/captions`, (request) => {
      const sourceId = segment(request, 5);
      if (!this.library.sources.has(sourceId)) return sourceMissing();
      const directoryId = new URL(request.url()).searchParams.get("directory_id");
      const directory = directoryId === null ? null : this.library.directories.get(directoryId);
      if (directoryId === "") return fail(422, "validation_error", "directory_id 无效");
      if (directoryId !== null && !directory) return fail(404, "directory_not_found", "图库目录不存在");
      if (directory && directory.source_id !== sourceId) return fail(409, "source_mismatch", "图库目录不属于此来源");
      const items = [...this.library.assets.values()]
        .filter((asset) => this.eligible(sourceId, asset.asset_id) && (!directory || !directory.relative_path ||
          asset.directory_id === directory.directory_id || asset.relative_path.startsWith(`${directory.relative_path}/`)))
        .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }) || a.asset_id.localeCompare(b.asset_id))
        .map((asset) => this.item(asset));
      const etag = `"${sourceId}:${directoryId ?? ""}:${items.map(({ asset_id, version }) => `${asset_id}/${version}`).join(";")}"`;
      if (request.headers()["if-none-match"] === etag) return { status: 304, headers: { ETag: etag } };
      return { headers: { ETag: etag }, body: { source_id: sourceId, trigger_word: "", etag, items } };
    });
    await mockApi(page, "get", `${pagePath}/kept`, (request) => {
      const sourceId = segment(request, 5);
      if (!this.library.sources.has(sourceId)) return sourceMissing();
      return { body: { asset_ids: [...this.kept].filter((id) => this.eligible(sourceId, id)).sort() } };
    });
    await mockApi(page, "put", `${pagePath}/kept`, (request) => {
      const sourceId = record(request);
      const { asset_ids, kept } = bodyOf<{ asset_ids: string[]; kept: boolean }>(request);
      if (!this.library.sources.has(sourceId)) return sourceMissing();
      const ids = [...new Set(asset_ids)];
      if (ids.some((id) => !this.eligible(sourceId, id))) return notInSource();
      const changed = ids.filter((id) => this.kept.has(id) !== kept);
      for (const id of changed) kept ? this.kept.add(id) : this.kept.delete(id);
      return { body: { updated: changed.length } };
    });
    await mockApi(page, "put", `${pagePath}/captions/{asset_id}`, (request) => {
      const sourceId = record(request);
      if (!this.library.sources.has(sourceId)) return sourceMissing();
      const assetId = segment(request, 7);
      const asset = this.eligible(sourceId, assetId);
      if (!asset) return notInSource();
      const { text, expected_version } = bodyOf<Schemas["CaptionEditRequest"]>(request);
      const item = this.item(asset);
      if (item.version !== expected_version) return fail(409, "caption_version_conflict", "caption 版本不符");
      const before = this.library.annotations.get(assetId)!.content;
      const tags = parseCaption(text);
      const changes = sameTags(item.tags, tags) ? [] : [{ asset, before, after: formatCaption(tags) }];
      const stats = {
        total: 1, changed: item.tags.length ? changes.length : 0, new: item.tags.length ? 0 : changes.length,
        unchanged: 1 - changes.length, skipped: 0, conflicts: 0, failed: 0, written: changes.length,
      };
      const batchId = this.batch(sourceId, "edit", changes, stats, { asset_id: assetId });
      const { name: _name, ...caption } = this.item(this.library.assets.get(assetId)!);
      return { body: { batch_id: batchId, caption } };
    });
    await mockApi(page, "post", `${pagePath}/captions/ops`, (request) => {
      const sourceId = record(request);
      if (!this.library.sources.has(sourceId)) return sourceMissing();
      const body = bodyOf<Schemas["CaptionOpsRequest"]>(request);
      const ids = [...new Set(body.asset_ids)];
      if (ids.some((id) => !this.eligible(sourceId, id))) return notInSource();
      const stats = { total: ids.length, changed: 0, new: 0, unchanged: 0, skipped: 0, conflicts: 0, failed: 0, written: 0 };
      const samples: Schemas["CaptionDiffSample"][] = [];
      const conflicts: Schemas["CaptionReportItem"][] = [];
      const changes: Change[] = [];
      for (const assetId of ids) {
        const asset = this.library.assets.get(assetId)!;
        const item = this.item(asset);
        const expected = body.expected_versions?.[assetId];
        if (expected !== undefined && expected !== item.version) {
          conflicts.push({ asset_id: assetId, reason: "caption_version_conflict" });
          stats.conflicts += 1;
          continue;
        }
        const tags = applyOps(item.tags, body.ops);
        const diff = diffTags(item.tags, tags);
        if (sameTags(item.tags, tags)) {
          stats.unchanged += 1;
          continue;
        }
        const change = item.tags.length ? "changed" : "new";
        stats[change] += 1;
        if (samples.length < (body.sample_limit ?? 20)) samples.push({ asset_id: assetId, change, before: item.tags, after: tags, ...diff });
        changes.push({ asset, before: this.library.annotations.get(assetId)!.content, after: formatCaption(tags) });
      }
      const dryRun = body.dry_run ?? false;
      if (!dryRun) stats.written = changes.length;
      const batchId = dryRun ? null : this.batch(sourceId, "ops", changes, stats, { ops: body.ops });
      return { body: { dataset_id: null, source_id: sourceId, batch_id: batchId, dry_run: dryRun, stats, samples, conflicts, skipped: [], failed: [] } };
    });
    await mockApi(page, "get", `${pagePath}/caption-batches`, (request) => {
      const sourceId = segment(request, 5);
      if (!this.library.sources.has(sourceId)) return sourceMissing();
      const limit = Number(new URL(request.url()).searchParams.get("limit") ?? 50);
      return { body: { items: this.batches.filter(({ summary }) => summary.source_id === sourceId).slice(0, limit).map(({ summary }) => summary) } };
    });
    await mockApi(page, "post", "/api/v1/caption-batches/{batch_id}/undo", (request) => {
      record(request);
      const batchId = segment(request, 4);
      const batch = this.batches.find(({ summary }) => summary.batch_id === batchId);
      if (!batch?.summary.can_undo) return fail(409, "caption_batch_not_undoable", "批次不能撤销");
      const sourceId = batch.summary.source_id!;
      const outage = this.undoOutages > 0;
      if (outage) this.undoOutages -= 1;
      const stats = { total: batch.changes.length, restored: 0, conflicts: 0, failed: 0 };
      const failed: Schemas["CaptionReportItem"][] = [];
      const conflicts: Schemas["CaptionReportItem"][] = [];
      const remaining: Change[] = [];
      for (const change of batch.changes) {
        const assetId = change.asset.asset_id;
        if (outage || !this.eligible(sourceId, assetId)) {
          failed.push({ asset_id: assetId, reason: outage ? "source_offline" : "caption_asset_not_in_source" });
          remaining.push(change);
        } else if (this.library.annotations.get(assetId)!.content !== change.after) {
          conflicts.push({ asset_id: assetId, reason: "caption_changed_since_batch" });
        } else {
          this.write(assetId, change.before);
          stats.restored += 1;
        }
      }
      stats.failed = failed.length;
      stats.conflicts = conflicts.length;
      const undone = !remaining.length;
      batch.changes = remaining;
      batch.summary = { ...batch.summary, undone_at: undone ? time + 1_000 : null, can_undo: !undone, undo_stats: stats };
      return { body: { dataset_id: null, source_id: sourceId, batch_id: batchId, undone, stats, failed, conflicts } };
    });
  }
}
