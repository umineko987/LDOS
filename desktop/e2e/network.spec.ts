import { errorEnvelope, mockApi } from "./fixtures/api";
import {
  mockLoginStart,
  mockNetworkBackend,
  NODE_ID,
  POLICIES,
  PROXY_SOURCES,
  PROXY_STATUS,
  recorded,
  SESSION_ID,
  SUB_ID,
  VAULT,
  type RecordedRequest,
} from "./fixtures/settings";
import { expect, test } from "./fixtures/test";

const OPERATION = { response_profile: "desktop-proxy-operation-v1" } as const;

test("精确视图：代理池状态和节点、来源、站点账号、站点策略", async ({ page }) => {
  await mockNetworkBackend(page);
  await page.goto("/#/settings/network");

  const proxy = page.getByTestId("network-proxy");
  await expect(proxy).toHaveAttribute("data-profile", "desktop");
  await expect(proxy.getByTestId("network-proxy-state")).toContainText("运行中 · 健康 1/2 · 租约 0");
  await expect(proxy.getByTestId("network-proxy-state")).toHaveAttribute("data-status", "warning");
  await expect(proxy.getByTestId("network-proxy-reload")).toHaveText("来源已修改，重载后生效。");
  await expect(proxy.locator('[data-node="n1"]')).toContainText("120 ms");
  await expect(proxy.locator('[data-node="n2"] [data-status="error"]')).toHaveCount(1);
  await expect(proxy.locator('[data-proxy-action="start"]')).toBeDisabled();
  await expect(proxy.locator('[data-proxy-action="stop"]')).toBeEnabled();
  await expect(proxy.locator('[data-proxy-action="reload"]')).toBeEnabled();
  await expect(proxy.getByTestId("network-proxy-legacy")).toHaveCount(0);

  const sources = page.getByTestId("network-proxy-sources");
  await expect(sources.locator(`[data-subscription="${SUB_ID}"]`)).toContainText("https://sub.example");
  await expect(sources.locator(`[data-subscription="${SUB_ID}"]`)).toContainText("已打码");
  await expect(sources.locator(`[data-inline-node="${NODE_ID}"]`)).toContainText("socks5://127.0.0.1:1080");
  await expect(sources.getByTestId("network-node-file")).toHaveText("未设置");
  await expect(sources.getByTestId("network-sources-reset")).toBeVisible();

  const accounts = page.getByTestId("network-accounts");
  await expect(accounts).toHaveAttribute("data-profile", "vault");
  await expect(accounts.locator('[data-account="danbooru"]')).toContainText("匿名访问");
  await expect(accounts.locator('[data-account="danbooru"] button')).toHaveCount(0);
  await expect(accounts.locator('[data-account="twitter"] [data-account-action="authorize"]')).toHaveText("登录");
  await expect(accounts.locator('[data-account="twitter"] [data-account-action="clear"]')).toHaveCount(0);
  await expect(accounts.locator('[data-account="exhentai"]')).toContainText("6 个 Cookie");
  await expect(accounts.locator('[data-account="pixiv"] [data-account-action="authorize"]')).toHaveText("重新授权");

  const policies = page.getByTestId("network-policies");
  await expect(policies).toHaveAttribute("data-profile", "policy");
  await expect(policies.locator('[data-policy="default"]')).toContainText("20");
  await expect(policies.locator('[data-policy="pixiv"]')).toContainText("必须代理");
  await expect(policies.locator('[data-policy="pixiv"]')).toContainText("已覆盖");
  await expect(policies.locator('[data-policy="danbooru"]')).toContainText("继承默认");
  await expect(policies.locator('[data-policy="exhentai"]')).toContainText("不可编辑");
  await expect(policies.locator('[data-policy="exhentai"] button')).toHaveCount(0);
});

test("旧版结构：三组接口都按宽松结构显示，只读", async ({ page }) => {
  await mockNetworkBackend(page, {
    proxyStatus: () => ({
      enabled: true,
      running: true,
      total: 1,
      healthy: 1,
      leases: 0,
      nodes: [{ id: "old", name: "旧节点", protocol: "http", endpoint: "old.example:8080", healthy: true }],
    }),
    proxySources: () => ({ source: "config", subscriptions: [{ id: "s1", scheme: "http", host: "legacy.example", port: 80 }] }),
    accounts: () => ({ items: [{ site: "twitter", label: "X / Twitter", method: "managed_browser", state: "authorized", authorized: true, summary: "旧版状态", actions: ["managed_browser_login", "clear"] }] }),
    policies: () => ({ default: { max_concurrency: 6, retry_limit: 1, backoff_base_seconds: 3, proxy_mode: "direct" }, items: [{ site: "danbooru", inherited: true, policy: null }] }),
  });
  await page.goto("/#/settings/network");

  const proxy = page.getByTestId("network-proxy");
  await expect(proxy).toHaveAttribute("data-profile", "legacy");
  await expect(proxy.getByTestId("network-proxy-legacy")).toHaveText("旧版接口 · 只读");
  await expect(proxy.getByTestId("network-proxy-state")).toContainText("运行中 · 健康 1/1");
  await expect(proxy.locator('[data-node="old"]')).toContainText("old.example:8080");
  await expect(proxy.locator("[data-proxy-action]")).toHaveCount(0);
  await expect(page.getByTestId("network-sources-readonly")).toHaveText("后端返回的是旧版结构，这里只显示不修改。");
  await expect(page.locator('[data-subscription="s1"]')).toContainText("http://legacy.example:80");
  await expect(page.getByTestId("network-subscription-input")).toHaveCount(0);

  const accounts = page.getByTestId("network-accounts");
  await expect(accounts).toHaveAttribute("data-profile", "legacy");
  await expect(accounts.getByTestId("network-accounts-legacy")).toBeVisible();
  await expect(accounts.locator('[data-account="twitter"]')).toContainText("旧版状态");
  await expect(accounts.locator('[data-account="twitter"] button')).toHaveCount(0);

  const policies = page.getByTestId("network-policies");
  await expect(policies).toHaveAttribute("data-profile", "legacy");
  await expect(policies.locator('[data-policy="default"]')).toContainText("直连");
  await expect(policies.locator('[data-policy="danbooru"]')).toContainText("—");
  await expect(policies.locator('[data-policy="danbooru"] button')).toHaveCount(0);
});

test("代理池运行控制和来源编辑：写完重拉状态", async ({ page }) => {
  let status = PROXY_STATUS;
  let sources = PROXY_SOURCES;
  const writes: RecordedRequest[] = [];
  await mockNetworkBackend(page, { proxyStatus: () => status, proxySources: () => sources });
  await mockApi(page, "post", "/api/v1/proxy/reload", (request) => {
    writes.push(recorded(request));
    status = { ...status, reload_required: false, active_revision: "r2" };
    sources = { ...sources, reload_required: false };
    return { body: OPERATION };
  });
  await mockApi(page, "post", "/api/v1/proxy/sources/subscriptions", (request) => {
    writes.push(recorded(request));
    return { body: OPERATION };
  });
  await mockApi(page, "delete", "/api/v1/proxy/sources/inline-nodes/{source_id}", (request) => {
    writes.push(recorded(request));
    sources = { ...sources, inline_nodes: [] };
    return { body: OPERATION };
  });
  await mockApi(page, "post", "/api/v1/proxy/stop", () => ({ status: 409, body: errorEnvelope("proxy_leased", "有任务正在使用代理") }));
  await page.goto("/#/settings/network");

  const proxy = page.getByTestId("network-proxy");
  await proxy.locator('[data-proxy-action="reload"]').click();
  await expect(proxy.getByTestId("network-proxy-reload")).toHaveCount(0);
  await expect(proxy.locator('[data-proxy-action="reload"]')).toBeDisabled();
  expect(writes[0]).toEqual({ method: "POST", path: "/api/v1/proxy/reload", view: "desktop", body: { force_refresh: true } });

  await proxy.locator('[data-proxy-action="stop"]').click();
  await expect(page.locator("[data-sonner-toast]", { hasText: "操作失败" })).toContainText("操作失败：有任务正在使用代理");

  // 订阅地址先在本地校验。
  const input = page.getByTestId("network-subscription-input");
  await input.fill("ftp://sub.example");
  await page.getByTestId("network-subscription-add").click();
  await expect(page.getByTestId("network-source-error")).toHaveText("需要带主机名的 HTTP(S) 地址");
  await input.fill("https://new.example/sub?token=1");
  await page.getByTestId("network-subscription-add").click();
  await expect(input).toHaveValue("");
  expect(writes[1]).toEqual({ method: "POST", path: "/api/v1/proxy/sources/subscriptions", view: "desktop", body: { url: "https://new.example/sub?token=1" } });

  // 删除先确认。
  await page.locator(`[data-inline-node="${NODE_ID}"]`).getByRole("button", { name: "删除" }).click();
  const dialog = page.getByTestId("network-confirm");
  await expect(dialog).toContainText("删除这个手动节点？");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  expect(writes).toHaveLength(2);
  await page.locator(`[data-inline-node="${NODE_ID}"]`).getByRole("button", { name: "删除" }).click();
  await page.getByTestId("network-confirm-action").click();
  await expect(page.locator(`[data-inline-node="${NODE_ID}"]`)).toHaveCount(0);
  expect(writes[2]).toMatchObject({ method: "DELETE", path: `/api/v1/proxy/sources/inline-nodes/${NODE_ID}`, view: "desktop" });
});

test("站点账号：发起授权、等待登录、取消、清除凭证", async ({ page }) => {
  let vault = VAULT;
  const writes: RecordedRequest[] = [];
  const twitter = VAULT.items.find((item) => item.site === "twitter")!;
  await mockNetworkBackend(page, { accounts: () => vault });
  await mockLoginStart(page, (request) => {
    writes.push(recorded(request));
    const session = { session_id: SESSION_ID, state: "awaiting_login" as const, created_at: 1, expires_at: 2 };
    vault = { ...vault, items: vault.items.map((item) => (item.site === "twitter" ? { ...item, state: "authorizing", login: session } : item)) };
    return { session, status: twitter };
  });
  await mockApi(page, "delete", "/api/v1/auth/{site}/login/{session_id}", (request) => {
    writes.push(recorded(request));
    vault = { ...vault, items: vault.items.map((item) => (item.site === "twitter" ? twitter : item)) };
    return { body: { session: null, status: twitter } };
  });
  await mockApi(page, "delete", "/api/v1/auth/{site}", (request) => {
    writes.push(recorded(request));
    vault = { ...vault, items: vault.items.map((item) => (item.site === "exhentai" ? { ...item, authorized: false, state: "required", cookies: null } : item)) };
    return { body: twitter };
  });
  await page.goto("/#/settings/network");

  const accounts = page.getByTestId("network-accounts");
  await accounts.locator('[data-account="twitter"] [data-account-action="authorize"]').click();
  await expect(accounts.locator('[data-account="twitter"]')).toHaveAttribute("data-state", "authorizing");
  await expect(accounts.locator('[data-account="twitter"]')).toContainText("等待在浏览器中完成登录…");
  // 授权浏览器同一时间只给一个站点用。
  await expect(accounts.locator('[data-account="exhentai"] [data-account-action="authorize"]')).toBeDisabled();
  expect(writes[0]).toMatchObject({ method: "POST", path: "/api/v1/auth/twitter/login/start", view: "vault" });

  await accounts.locator('[data-account="twitter"] [data-account-action="cancel"]').click();
  await expect(accounts.locator('[data-account="twitter"]')).toHaveAttribute("data-state", "required");
  expect(writes[1]).toMatchObject({ method: "DELETE", path: `/api/v1/auth/twitter/login/${SESSION_ID}`, view: "vault" });

  await accounts.locator('[data-account="exhentai"] [data-account-action="clear"]').click();
  await expect(page.getByTestId("network-confirm")).toContainText("清除 EH 的凭证？");
  await page.getByTestId("network-confirm-action").click();
  await expect(accounts.locator('[data-account="exhentai"] [data-account-action="clear"]')).toHaveCount(0);
  expect(writes[2]).toMatchObject({ method: "DELETE", path: "/api/v1/auth/exhentai", view: "vault" });
});

test("站点策略：编辑时校验范围，保存和恢复默认", async ({ page }) => {
  let snapshot = POLICIES;
  const writes: RecordedRequest[] = [];
  await mockNetworkBackend(page, { policies: () => snapshot });
  await mockApi(page, "put", "/api/v1/sites/policies/{site}", (request) => {
    const write = recorded(request);
    writes.push(write);
    const policy = write.body as (typeof POLICIES)["items"][number]["policy"];
    snapshot = { ...snapshot, items: snapshot.items.map((item) => (item.site === "danbooru" ? { ...item, policy, has_override: true, inherited: false } : item)) };
    return { body: snapshot.items[0]! };
  });
  await mockApi(page, "delete", "/api/v1/sites/policies/{site}", (request) => {
    writes.push(recorded(request));
    snapshot = { ...snapshot, items: snapshot.items.map((item) => (item.site === "pixiv" ? { ...item, policy: POLICIES.default.policy, has_override: false, inherited: true } : item)) };
    return { body: { deleted: true, site: "pixiv", response_profile: "policy" as const } };
  });
  await page.goto("/#/settings/network");

  const policies = page.getByTestId("network-policies");
  await policies.locator('[data-policy="danbooru"]').getByRole("button", { name: "编辑" }).click();
  const row = policies.locator('[data-policy="danbooru"][data-editing="true"]');
  await row.locator('[data-policy-field="max_concurrency"]').fill("0");
  await row.getByTestId("network-policy-save").click();
  await expect(row.getByRole("alert")).toHaveText("并发 1–128、重试 0–20、退避 0–3600 秒");
  await expect(row.locator('[data-policy-field="max_concurrency"]')).toHaveAttribute("aria-invalid", "true");

  await row.locator('[data-policy-field="max_concurrency"]').fill("8");
  await row.locator('[data-policy-field="proxy_mode"]').getByRole("button", { name: "直连" }).click();
  await row.getByTestId("network-policy-save").click();
  await expect(policies.locator('[data-policy="danbooru"]')).toContainText("已覆盖");
  expect(writes[0]).toEqual({
    method: "PUT",
    path: "/api/v1/sites/policies/danbooru",
    view: "policy",
    body: { max_concurrency: 8, retry_limit: 2, backoff_base_seconds: 2, proxy_mode: "direct" },
  });

  await policies.locator('[data-policy="pixiv"]').getByRole("button", { name: "恢复默认" }).click();
  await page.getByTestId("network-confirm-action").click();
  await expect(policies.locator('[data-policy="pixiv"]')).toContainText("继承默认");
  expect(writes[1]).toMatchObject({ method: "DELETE", path: "/api/v1/sites/policies/pixiv", view: "policy" });
});
