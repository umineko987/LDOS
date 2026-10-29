// 设置页（模型、下载、网络）的接口模拟数据。类型来自 schema.d.ts，契约变了会在 `npm run check` 里报错。

import type { Page, Request } from "@playwright/test";

import type { components } from "../../src/lib/api/schema";
import { mockApi, type ErrorEnvelope } from "./api";

type Schemas = components["schemas"];
export type ModelItem = Schemas["ModelItem"];
export type DownloadSettingsView = Schemas["DownloadSettingsView"];

export function model(key: string, overrides: Partial<ModelItem> = {}): ModelItem {
  return {
    key,
    family: "dedup",
    display_name: key,
    status: "missing",
    size_bytes: 350 * 1024 * 1024,
    installed_bytes: 0,
    license: "MIT",
    gated: false,
    source_url: `https://example.invalid/${key}`,
    used_by: ["dedup"],
    installs_with: [],
    message: "",
    progress: null,
    job_id: null,
    ...overrides,
  };
}

export const MODELS: ModelItem[] = [
  model("sscd", { display_name: "SSCD 拷贝检测", installs_with: ["dino"], size_bytes: 94 * 1024 * 1024 }),
  model("dino", {
    display_name: "DINOv2 ViT-S/14",
    license: "Apache-2.0",
    installs_with: ["sscd"],
    used_by: ["dedup", "atlas"],
    size_bytes: 88 * 1024 * 1024,
  }),
  model("ccip", { display_name: "角色一致性（CCIP）", status: "installed", license: null, used_by: ["clean"], installed_bytes: 1 }),
  model("wd-vit-v3", { family: "tagger", display_name: "WD ViT v3", status: "installed", size_bytes: null, license: "Apache-2.0", used_by: ["tag"] }),
  model("cl-tagger-v2", {
    family: "tagger",
    display_name: "CL Tagger v2",
    status: "needs_license",
    gated: true,
    size_bytes: null,
    license: "cl-tagger-license",
    used_by: ["tag"],
  }),
];

export const DOWNLOADS: DownloadSettingsView = {
  hf_mirror: null,
  proxy_mode: "none",
  custom_proxy: null,
  custom_proxy_has_credentials: false,
  token_set: false,
  token_hint: null,
};

/** 把一个模型改成安装中（模拟 POST /models/install 之后的表）。 */
export function installing(items: readonly ModelItem[], keys: readonly string[], jobId = "models:dedup"): ModelItem[] {
  return items.map((item) =>
    keys.includes(item.key) ? { ...item, status: "installing", job_id: jobId, progress: { current: 0, total: 0 }, message: "排队中" } : item,
  );
}

export interface InstallReply {
  readonly status?: number;
  readonly body: Schemas["ModelInstallResponse"] | ErrorEnvelope;
}

/**
 * POST /api/v1/models/install 成功时是 202，api.ts 的 mockApi 只按 200/201 推断正文类型，
 * 所以这里单独模拟，正文仍按 ModelInstallResponse 检查。
 */
export async function mockInstall(page: Page, handler: (body: Schemas["ModelInstallBody"], request: Request) => InstallReply): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/v1/models/install",
    async (route, request) => {
      if (request.method() !== "POST") return route.fallback();
      const reply = handler(request.postDataJSON() as Schemas["ModelInstallBody"], request);
      await route.fulfill({ status: reply.status ?? 202, contentType: "application/json", body: JSON.stringify(reply.body) });
    },
  );
}

/** 模型页的两个只读接口；`models` 每次请求时调用，测试可以随时改它返回的表。 */
export async function mockModelsBackend(
  page: Page,
  { models = () => MODELS, downloads = () => DOWNLOADS }: { models?: () => ModelItem[]; downloads?: () => DownloadSettingsView } = {},
): Promise<void> {
  await mockApi(page, "get", "/api/v1/models", () => ({ body: { items: models() } }));
  await mockApi(page, "get", "/api/v1/settings/downloads", () => ({ body: downloads() }));
}
