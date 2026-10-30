import { errorEnvelope, mockApi } from "./fixtures/api";
import { DOWNLOADS, installing, mockInstall, mockModelsBackend, MODELS, type DownloadSettingsView, type ModelItem } from "./fixtures/settings";
import { expect, test } from "./fixtures/test";

test("模型表列出状态、大小、许可、用途和同包模型", async ({ page }) => {
  await mockModelsBackend(page);
  await page.goto("/#/settings/models");
  const models = page.getByTestId("models");

  const sscd = models.locator('[data-model="sscd"]');
  await expect(sscd).toHaveAttribute("data-status", "missing");
  await expect(sscd).toContainText("SSCD 拷贝检测");
  await expect(sscd).toContainText("与 DINOv2 ViT-S/14 一起安装");
  await expect(sscd).toContainText("94.0 MB");
  await expect(sscd).toContainText("MIT");
  await expect(sscd).toContainText("未安装");
  await expect(models.locator('[data-model="dino"]')).toContainText("地图");
  await expect(models.locator('[data-model="ccip"]')).toContainText("未注明");
  await expect(models.locator('[data-model="ccip"] [data-install]')).toHaveCount(0);

  const cl = models.locator('[data-model="cl-tagger-v2"]');
  await expect(cl).toContainText("待同意许可");
  await expect(cl).toContainText("需同意");
  await expect(cl).toContainText("—");
  await expect(models.getByRole("heading", { name: "打标" })).toBeVisible();
});

test("安装受限模型先确认许可，同意后带 accept_license 安装并显示进度", async ({ page }) => {
  let table: ModelItem[] = MODELS;
  const bodies: unknown[] = [];
  await mockModelsBackend(page, { models: () => table });
  await mockInstall(page, (body) => {
    bodies.push(body);
    table = installing(table, body.keys, "tagger:e2e");
    return { body: { items: table, started: [{ family: "tagger", keys: body.keys, job_id: "tagger:e2e", proxy_source: "none" }] } };
  });
  await page.goto("/#/settings/models");

  const cl = page.locator('[data-model="cl-tagger-v2"]');
  await cl.getByRole("button", { name: "安装" }).click();

  const dialog = page.getByTestId("model-license-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-license-model="cl-tagger-v2"]')).toContainText("cl-tagger-license");
  await expect(dialog.getByRole("link", { name: "查看许可" })).toHaveAttribute("href", "https://example.invalid/cl-tagger-v2");
  expect(bodies).toEqual([]);

  // 取消不发请求。
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  expect(bodies).toEqual([]);

  await cl.getByRole("button", { name: "安装" }).click();
  await page.getByTestId("model-license-accept").click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => bodies).toEqual([{ keys: ["cl-tagger-v2"], accept_license: true }]);
  await expect(cl).toHaveAttribute("data-status", "installing");
  await expect(cl).toContainText("安装中");
  await expect(page.locator("[data-sonner-toast]")).toContainText("已开始安装 1 个模型");

  // 没有 SSE 时靠兜底轮询拿到最终状态。
  table = table.map((item) => (item.key === "cl-tagger-v2" ? { ...item, status: "installed", job_id: null, progress: null } : item));
  await expect(cl).toHaveAttribute("data-status", "installed", { timeout: 10_000 });
});

test("「安装缺失模型」装所有能装的；本地表过期时按后端的 model_license_required 补一次确认", async ({ page }) => {
  // 本地表里 cl-tagger-v2 看起来不需要许可（登记刚变），后端仍然要求。
  const stale = MODELS.map((item) => (item.key === "cl-tagger-v2" ? { ...item, gated: false, status: "missing" as const } : item));
  const bodies: Record<string, unknown>[] = [];
  await mockModelsBackend(page, { models: () => stale });
  await mockInstall(page, (body) => {
    bodies.push(body);
    if (!body.accept_license) return { status: 422, body: errorEnvelope("model_license_required", "需要先同意许可") };
    return { body: { items: installing(stale, ["sscd", "dino", "cl-tagger-v2"]), started: [] } };
  });
  await page.goto("/#/settings/models");

  await page.locator("header").getByRole("button", { name: "安装缺失模型" }).click();
  await expect(page.getByTestId("model-license-dialog")).toBeVisible();
  await page.getByTestId("model-license-accept").click();
  await expect.poll(() => bodies).toEqual([
    { keys: ["sscd", "dino", "cl-tagger-v2"], accept_license: false },
    { keys: ["sscd", "dino", "cl-tagger-v2"], accept_license: true },
  ]);
  await expect(page.locator('[data-model="sscd"]')).toHaveAttribute("data-status", "installing");
  await expect(page.locator("header").getByRole("button", { name: "安装中…" })).toBeDisabled();
});

test("安装失败时显示后端原因", async ({ page }) => {
  await mockModelsBackend(page);
  await mockInstall(page, () => ({ status: 409, body: errorEnvelope("models_busy", "已有模型在安装") }));
  await page.goto("/#/settings/models");
  await page.locator('[data-model="sscd"]').getByRole("button", { name: "安装" }).click();
  await expect(page.locator("[data-sonner-toast]")).toContainText("安装失败：已有模型在安装");
});

test("HF token 只写：保存后输入框清空，只显示已保存，不回显任何一部分；可以清除", async ({ page }) => {
  const secret = "hf_e2eWriteOnlyToken9876";
  let view: DownloadSettingsView = DOWNLOADS;
  const bodies: unknown[] = [];
  await mockModelsBackend(page, { downloads: () => view });
  await mockApi(page, "put", "/api/v1/settings/downloads", (request) => {
    const body = request.postDataJSON() as { hf_token?: string; clear_hf_token?: boolean };
    bodies.push(body);
    view = { ...view, token_set: !body.clear_hf_token };
    return { body: view };
  });
  await page.goto("/#/settings/models");

  const token = page.getByTestId("downloads-token");
  const input = token.getByLabel("HF token");
  await expect(token.getByTestId("downloads-token-state")).toHaveText("未设置");
  await expect(input).toHaveAttribute("type", "password");
  await expect(token.getByTestId("downloads-token-save")).toBeDisabled();

  await input.fill(secret);
  await token.getByTestId("downloads-token-save").click();
  await expect(token.getByTestId("downloads-token-state")).toHaveText("已保存");
  await expect(input).toHaveValue("");
  expect(bodies).toEqual([{ clear_hf_token: false, hf_token: secret }]);
  await expect(page.locator("body")).not.toContainText(secret);
  await expect(page.locator("body")).not.toContainText(secret.slice(-4));
  expect(await page.content()).not.toContain(secret);

  await token.getByTestId("downloads-token-clear").click();
  await expect(token.getByTestId("downloads-token-state")).toHaveText("未设置");
  expect(bodies[1]).toEqual({ clear_hf_token: true });
  await expect(token.getByTestId("downloads-token-clear")).toHaveCount(0);
});

test("镜像和下载代理只提交改动的字段；自定义代理只显示打码后的值", async ({ page }) => {
  let view: DownloadSettingsView = { ...DOWNLOADS, proxy_mode: "custom", custom_proxy: "http://***@10.0.0.2:3128", custom_proxy_has_credentials: true };
  const bodies: unknown[] = [];
  await mockModelsBackend(page, { downloads: () => view });
  await mockApi(page, "put", "/api/v1/settings/downloads", (request) => {
    const body = request.postDataJSON() as { hf_mirror?: string | null; proxy_mode?: DownloadSettingsView["proxy_mode"] };
    bodies.push(body);
    if ("custom_proxy" in body) return { status: 422, body: errorEnvelope("invalid_download_proxy", "代理地址需为带端口的 HTTP 或 HTTPS 地址") };
    view = { ...view, hf_mirror: body.hf_mirror ?? view.hf_mirror, proxy_mode: body.proxy_mode ?? view.proxy_mode };
    return { body: view };
  });
  await page.goto("/#/settings/models");

  const downloads = page.getByTestId("downloads");
  const save = downloads.getByTestId("downloads-save");
  await expect(downloads.getByTestId("downloads-proxy-saved")).toHaveText("已保存：http://***@10.0.0.2:3128");
  await expect(downloads.locator('[data-download="proxy-url"]')).toHaveValue("");
  await expect(save).toBeDisabled();

  // 自定义镜像：地址不合法时本地拦下。
  await downloads.locator('[data-download="mirror"]').getByRole("button", { name: "自定义" }).click();
  await downloads.locator('[data-download="mirror-url"]').fill("ftp://mirror.example");
  await save.click();
  await expect(downloads.getByRole("alert")).toHaveText("镜像地址必须是 HTTP(S) URL，不能包含凭据、查询参数或片段");
  expect(bodies).toEqual([]);

  await downloads.locator('[data-download="mirror"]').getByRole("button", { name: "hf-mirror.com" }).click();
  await downloads.locator('[data-download="proxy"]').getByRole("button", { name: "代理池" }).click();
  await expect(downloads).toContainText("每次下载从代理池租一个节点");
  await save.click();
  await expect.poll(() => bodies).toEqual([{ clear_hf_token: false, hf_mirror: "https://hf-mirror.com", proxy_mode: "pool" }]);
  await expect(save).toBeDisabled();
  await expect(page.locator("[data-sonner-toast]")).toContainText("下载设置已保存");

  // 新的代理地址被后端拒绝时显示原因，草稿保留。
  await downloads.locator('[data-download="proxy"]').getByRole("button", { name: "自定义" }).click();
  await downloads.locator('[data-download="proxy-url"]').fill("http://user:pw@10.0.0.3:3128");
  await save.click();
  await expect(downloads.getByRole("alert")).toHaveText("保存失败：代理地址需为带端口的 HTTP 或 HTTPS 地址");
  await expect(downloads.locator('[data-download="proxy-url"]')).toHaveValue("http://user:pw@10.0.0.3:3128");
});
