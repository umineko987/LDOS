<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { accounts, accountsQuery, networkKeys } from "#lib/api/queries/network.ts";
  import type { ComponentStatus } from "#lib/api/queries/system.ts";
  import StatusDot from "#lib/components/status-dot.svelte";
  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { accountsView, authorizingSite, type AccountView, type VaultStatuses } from "#lib/domain/network.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  import type { ConfirmRequest } from "./confirm-dialog.svelte";
  import { useWriter } from "./writer.svelte.ts";

  // 站点账号：匿名站点只显示状态；需要登录的站点在项目浏览器里授权（pixiv 走 OAuth）。
  let { confirm }: { confirm: (request: ConfirmRequest) => void } = $props();

  type Site = VaultStatuses["items"][number]["site"];

  const api = useApi();
  const writer = useWriter(networkKeys.accounts());

  // 有授权会话时 2 秒轮询一次，等用户在浏览器里登录完成。
  const SESSION_POLL_MS = 2_000;
  const query = createQuery(() => ({
    ...accountsQuery(api),
    refetchInterval: (current) => (current.state.data && authorizingSite(accountsView(current.state.data)) ? SESSION_POLL_MS : false),
  }));

  const view = $derived(query.data ? accountsView(query.data) : null);
  const active = $derived(authorizingSite(view));

  const METHODS: Record<AccountView["method"], () => string> = {
    anonymous: m.network_account_anonymous,
    managed_browser: m.network_account_browser,
    oauth: m.network_account_oauth,
    unknown: m.network_account_unknown,
  };

  function tone(item: AccountView): ComponentStatus {
    if (item.session) return "warning";
    if (item.state === "required") return "warning";
    if (item.state === "authorized" || item.state === "ready") return "ok";
    return "disabled";
  }

  function when(seconds: number | null): string | null {
    if (seconds === null) return null;
    return new Intl.DateTimeFormat(i18n.current, { dateStyle: "short", timeStyle: "short" }).format(new Date(seconds * 1000));
  }

  // 后端的站点 id 是固定枚举；旧结构里的未知站点不会有操作按钮（authorize/clear 为假）。
  const site = (item: AccountView) => item.site as Site;
</script>

<section aria-labelledby="network-accounts" class="flex flex-col gap-3" data-testid="network-accounts" data-profile={view ? (view.legacy ? "legacy" : "vault") : null}>
  <div class="flex items-center gap-2">
    <h2 id="network-accounts" class="text-sm font-semibold">{m.network_accounts_title()}</h2>
    {#if view?.legacy}<Badge variant="outline" data-testid="network-accounts-legacy">{m.network_legacy()}</Badge>{/if}
  </div>

  <p class="text-xs text-fg3">{m.network_accounts_proxy_hint()}</p>
  {#if query.error}
    <p class="text-sm text-danger" role="alert">{m.network_load_failed({ reason: apiErrorMessage(query.error) })}</p>
  {:else if view}
    {#if view.profileResetting}<p class="text-xs text-warn">{m.network_accounts_resetting()}</p>{/if}
    <ul class="flex flex-col border-t border-line">
      {#each view.accounts as item (item.site)}
        {@const updated = when(item.updatedAt)}
        <li
          class="grid min-h-row grid-cols-[14px_140px_minmax(0,1fr)_auto] items-center gap-x-2 border-b border-line py-1.5"
          data-account={item.site}
          data-state={item.session ? "authorizing" : item.state}
        >
          <StatusDot status={tone(item)} />
          <div class="flex min-w-0 flex-col">
            <span class="truncate text-sm text-fg">{item.label}</span>
            <span class="truncate text-2xs text-fg3">{METHODS[item.method]()}</span>
          </div>
          <div class="flex min-w-0 flex-col">
            <span class="truncate text-xs text-fg2" title={item.summary}>
              {item.session ? m.network_account_waiting() : item.summary}
            </span>
            {#if updated || item.cookieCount}
              <span class="truncate text-2xs text-fg3">
                {#if updated}{m.network_account_updated({ time: updated })}{/if}
                {#if item.cookieCount}{updated ? " · " : ""}{m.network_account_cookies({ count: item.cookieCount })}{/if}
              </span>
            {/if}
          </div>
          <div class="flex items-center gap-1.5">
            {#if item.session}
              {@const session = item.session}
              <Button
                variant="outline"
                size="sm"
                disabled={writer.busy !== null}
                data-account-action="cancel"
                onclick={() => void writer.run(`cancel:${item.site}`, () => accounts.cancel(api, site(item), session.kind, session.id))}
              >
                {m.network_account_cancel()}
              </Button>
            {:else if item.authorize}
              {@const kind = item.authorize}
              <Button
                variant="outline"
                size="sm"
                disabled={writer.busy !== null || view.profileResetting || (active !== null && active !== item.site)}
                title={active && active !== item.site ? m.network_account_busy() : undefined}
                data-account-action="authorize"
                onclick={() => void writer.run(`authorize:${item.site}`, () => accounts.authorize(api, site(item), kind), m.network_account_opened)}
              >
                {item.authorized ? m.network_account_reauthorize() : m.network_account_authorize()}
              </Button>
            {/if}
            {#if item.clear && !item.session && (item.authorized || item.cookieCount)}
              <Button
                variant="ghost"
                size="sm"
                class="text-danger"
                disabled={writer.busy !== null}
                data-account-action="clear"
                onclick={() =>
                  confirm({
                    title: m.network_account_clear_title({ site: item.label }),
                    body: m.network_account_clear_body(),
                    action: m.network_account_clear(),
                    run: () => void writer.run(`clear:${item.site}`, () => accounts.clear(api, site(item)), m.network_account_cleared),
                  })}
              >
                {m.network_account_clear()}
              </Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</section>
