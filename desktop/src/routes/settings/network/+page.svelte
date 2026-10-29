<script lang="ts">
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import { useQueryClient } from "@tanstack/svelte-query";

  import { networkKeys } from "#lib/api/queries/network.ts";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { m } from "#lib/paraglide/messages.js";

  import AccountsSection from "./accounts-section.svelte";
  import ConfirmDialog, { type ConfirmRequest } from "./confirm-dialog.svelte";
  import PoliciesSection from "./policies-section.svelte";
  import ProxySection from "./proxy-section.svelte";

  // 设置 › 网络：代理池、站点账号、站点策略合在一页。
  const queryClient = useQueryClient();

  // 只跟踪手动刷新：代理状态每 5 秒轮询一次，用 isFetching 的话按钮会一直闪。
  let refreshing = $state(false);
  async function refresh() {
    refreshing = true;
    await queryClient.invalidateQueries({ queryKey: networkKeys.all }).catch(() => undefined);
    refreshing = false;
  }

  let pending = $state<ConfirmRequest | null>(null);
  const confirm = (request: ConfirmRequest) => (pending = request);
</script>

<PageHeader title={m.nav_settings_network()} subtitle={m.network_subtitle()}>
  {#snippet actions()}
    <Button
      variant="outline"
      size="sm"
      disabled={refreshing}
      onclick={() => void refresh()}
      data-testid="network-refresh"
    >
      <RefreshCwIcon class={refreshing ? "animate-spin" : ""} />
      {m.network_refresh()}
    </Button>
  {/snippet}
</PageHeader>

<div class="flex max-w-[1080px] flex-col gap-8 px-7 py-5" data-testid="network">
  <ProxySection {confirm} />
  <AccountsSection {confirm} />
  <PoliciesSection {confirm} />
</div>

<ConfirmDialog bind:request={pending} />
