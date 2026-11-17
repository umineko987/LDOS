// 导出接口的有状态模拟，外加一个桌面宿主（选目录、在文件管理器中打开）。
//
//   const datasets = new FakeDatasets();
//   const id = datasets.add({ name: "角色 A", trigger_word: "alice", members: 6 });
//   await datasets.install(page);
//   const exports = new FakeExports(datasets, id);
//   await exports.install(page);
//   await fakeDesktopHost(page, { directory: "/home/me/train" }); // 不调用就是浏览器模式
//
// 开始之后每读一次列表，进行中的导出前进 `step` 张，到头就成功（页面进行中时 2 秒轮询一次）。

import type { Page, Request } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import { errorEnvelope, mockApi } from "./api";
import type { FakeDatasets } from "./datasets";

type Schemas = components["schemas"];
type ExportRecord = Schemas["DatasetExportJobResponse"];
type ExportRequest = Schemas["DatasetExportRequest"];
type ExportPlan = Schemas["DatasetExportPlanResponse"];

const TIME = 1_760_000_000;

declare global {
  interface Window {
    /** fakeDesktopHost 收到的宿主命令（不含启动门的两个）。 */
    __hostCalls?: { command: string; args: unknown[] }[];
  }
}

/** 模拟 MyGo 宿主：后端就绪，选目录给 `directory`，其余调用记在 window.__hostCalls。 */
export async function fakeDesktopHost(page: Page, { directory }: { directory: string | null }): Promise<void> {
  await page.addInitScript((picked) => {
    window.__hostCalls = [];
    Object.assign(window, {
      mygo: {
        call: async (method: string, ...args: unknown[]) => {
          if (method === "Host.BackendStatus") return { state: "ready" };
          if (method === "Host.RuntimeMetadata") return { apiOrigin: location.origin, backendVersion: "0.5.2" };
          window.__hostCalls?.push({ command: method, args });
          if (method === "Host.SelectDirectory") return picked;
          if (method === "Host.RevealInFileManager") return null;
          throw new Error(`unexpected method ${method}`);
        },
      },
    });
  }, directory);
}

export function hostCalls(page: Page) {
  return page.evaluate(() => window.__hostCalls ?? []);
}

function exportId(request: Request): string {
  return decodeURIComponent(new URL(request.url()).pathname.match(/\/exports\/([^/]+)\//)?.[1] ?? "");
}

export class FakeExports {
  /** 新的在前。 */
  readonly records: ExportRecord[] = [];
  /** 收到的导出请求（预览和开始都算），按顺序。 */
  readonly requests: ExportRequest[] = [];
  /** 目标目录里已经有的文件夹名。 */
  readonly existing = new Set<string>();
  step = 4;
  private sequence = 0;

  constructor(
    private readonly datasets: FakeDatasets,
    private readonly datasetId: string,
  ) {}

  private dataset() {
    const dataset = this.datasets.datasets.get(this.datasetId);
    if (!dataset) throw new Error(`没有数据集 ${this.datasetId}`);
    return dataset;
  }

  plan(body: ExportRequest): ExportPlan {
    const dataset = this.dataset();
    const layout = body.layout ?? "kohya";
    const repeats = body.repeats ?? 10;
    const trigger = body.trigger_word ?? dataset.trigger_word;
    const folder = layout === "kohya" ? `${repeats}_${body.folder_name || trigger}` : body.folder_name || dataset.name;
    const captions = body.include_captions ?? true;
    const items = dataset.members.map((member, index) => {
      const stem = body.rename === "sequential" ? String(index + 1).padStart(4, "0") : member.name.replace(/\.[^.]+$/, "");
      return {
        asset_id: member.asset_id,
        name: member.name,
        source_relative_path: member.relative_path,
        output_relative_path: `${folder}/${stem}.${member.format}`,
        caption_output_relative_path: captions ? `${folder}/${stem}.txt` : null,
        caption_preview: captions ? [...(body.pin_trigger === false ? [] : [trigger]), "1girl", "solo"].join(", ") : "",
        size_bytes: member.size_bytes,
      };
    });
    const imageBytes = items.reduce((sum, item) => sum + item.size_bytes, 0);
    const txtBytes = captions ? items.length * 24 : 0;
    return {
      dataset_id: this.datasetId,
      layout,
      folder_name: folder,
      target_path: body.target_path,
      output_path: `${body.target_path}/${folder}`,
      target_exists: this.existing.has(folder),
      image_count: items.length,
      caption_count: captions ? items.length : 0,
      image_bytes: imageBytes,
      txt_bytes: txtBytes,
      total_bytes: imageBytes + txtBytes,
      blockers: [],
      collisions: [],
      collision_count: 0,
      items,
      options: {
        target_path: body.target_path,
        layout,
        repeats,
        trigger_word: trigger,
        folder_name: folder,
        rename: body.rename ?? "none",
        include_captions: captions,
        pin_trigger: body.pin_trigger ?? true,
        tag_blacklist: body.tag_blacklist ?? [],
        underscore_to_space: body.underscore_to_space ?? false,
      },
    };
  }

  /** 预先放一条导出记录（例如后端重启时中断的）。 */
  add(overrides: Partial<ExportRecord> & { readonly body: ExportRequest }): ExportRecord {
    const { body, ...rest } = overrides;
    const plan = this.plan(body);
    const n = ++this.sequence;
    const record: ExportRecord = {
      export_id: `exp${n}`,
      job_id: `dataset-export:exp${n}`,
      dataset_id: this.datasetId,
      status: "queued",
      error_code: null,
      error_details: null,
      resumable: false,
      folder_name: plan.folder_name,
      target_path: plan.target_path,
      output_path: plan.output_path,
      options: plan.options,
      total_items: plan.image_count,
      staged_items: 0,
      total_bytes: plan.total_bytes,
      image_bytes: plan.image_bytes,
      txt_bytes: plan.txt_bytes,
      copied_bytes: 0,
      created_at: TIME + n,
      updated_at: TIME + n,
      started_at: TIME + n,
      finished_at: null,
      ...rest,
    };
    this.records.unshift(record);
    return record;
  }

  private advance(): void {
    for (const record of this.records) {
      if (record.status !== "queued" && record.status !== "running") continue;
      record.status = "running";
      record.staged_items = Math.min(record.total_items, record.staged_items + this.step);
      record.copied_bytes = Math.round((record.total_bytes * record.staged_items) / record.total_items);
      if (record.staged_items === record.total_items) {
        record.status = "succeeded";
        record.finished_at = TIME + 100;
        this.existing.add(record.folder_name);
      }
    }
  }

  async install(page: Page): Promise<void> {
    await mockApi(page, "get", "/api/v1/datasets/{dataset_id}/exports", () => {
      this.advance();
      return { body: { items: this.records.map((record) => ({ ...record })) } };
    });
    await mockApi(page, "post", "/api/v1/datasets/{dataset_id}/exports", (request) => {
      const body = request.postDataJSON() as ExportRequest;
      this.requests.push(body);
      const plan = this.plan(body);
      if (body.dry_run) return { body: { dry_run: true, plan, job: null } };
      if (plan.target_exists) return { status: 409, body: errorEnvelope("export_target_exists", "目标文件夹已存在") };
      const record = this.add({ body, status: "running" });
      return { status: 202, body: { dry_run: false, plan: null, job: { ...record } } };
    });
    await mockApi(page, "post", "/api/v1/exports/{export_id}/cancel", (request) => {
      const record = this.records.find((item) => item.export_id === exportId(request));
      if (!record) return { status: 404, body: errorEnvelope("export_not_found", "导出不存在") };
      Object.assign(record, { status: "cancelled", resumable: false, finished_at: TIME + 100 });
      return { body: { ...record } };
    });
    await mockApi(page, "post", "/api/v1/exports/{export_id}/resume", (request) => {
      const record = this.records.find((item) => item.export_id === exportId(request));
      if (!record?.resumable) return { status: 409, body: errorEnvelope("export_not_resumable", "这次导出不能续传") };
      Object.assign(record, { status: "running", resumable: false, error_code: null, finished_at: null });
      return { body: { ...record } };
    });
  }
}
