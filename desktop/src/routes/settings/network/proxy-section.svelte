<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { networkKeys, proxySources, proxySourcesQuery, proxyStatusQuery, runProxyAction } from "#lib/api/queries/network.ts";
  import type { ComponentStatus } from "#lib/api/queries/system.ts";
  import StatusDot from "#lib/components/status-dot.svelte";
  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import { Textarea } from "#lib/components/ui/textarea/index.ts";
  import {
    parseInlineNodes,
    proxyControls,
    proxySourcesView,
    proxyStatusView,
    validateInlineNode,
    validateLocalPath,
    validateSubscriptionUrl,
    type ProxyAction,
    type ProxyStatusView,
    type SourceInputError,
  } from "#lib/domain/network.ts";
  import { m } from "#lib/paraglide/messages.js";

  import type { ConfirmRequest } from "./confirm-dialog.svelte";
  import { useWriter } from "./writer.svelte.ts";

  // 代理池：运行状态与控制、节点、来源（订阅、节点文件、手动节点）。
  let { confirm }: { confirm: (request: ConfirmRequest) => void } = $props();

  const api = useApi();
  const writer = useWriter(networkKeys.proxy());

  // 代理没有 SSE 事件，状态按诊断页的节奏轮询；来源只在写完后重拉。
  const PROXY_POLL_MS = 5_000;
  const status = createQuery(() => ({ ...proxyStatusQuery(api), refetchInterval: PROXY_POLL_MS }));
  const sources = createQuery(() => proxySourcesQuery(api));

  const view = $derived(status.data ? proxyStatusView(status.data) : null);
  const source = $derived(sources.data ? proxySourcesView(sources.data) : null);
  const controls = $derived(proxyControls(view, writer.busy !== null));
  // 旧结构的状态不可靠，不发写请求。
  const writable = $derived(view !== null && !view.legacy);
  const editable = $derived(source !== null && source.editable && writer.busy === null);

  function tone(value: ProxyStatusView): ComponentStatus {
    if (value.lastError) return "error";
    if (!value.enabled || !value.running) return "disabled";
    if (!value.healthy || value.reloadRequired) return "warning";
    return "ok";
  }

  function summary(value: ProxyStatusView): string {
    if (!value.enabled) return m.network_proxy_disabled();
    if (!value.running) return m.network_proxy_stopped();
    return m.network_proxy_running({ healthy: value.healthy ?? 0, total: value.total ?? 0, leases: value.leases });
  }

  const ACTIONS: { id: ProxyAction; label: () => string; done: () => string }[] = [
    { id: "start", label: m.network_proxy_start, done: m.network_proxy_started },
    { id: "stop", label: m.network_proxy_stop, done: m.network_proxy_stopped_done },
    { id: "reload", label: m.network_proxy_reload, done: m.network_proxy_reloaded },
    { id: "probe", label: m.network_proxy_probe, done: m.network_proxy_probed },
  ];

  const INPUT_ERRORS: Record<SourceInputError, () => string> = {
    empty: m.network_input_empty,
    too_long: m.network_input_too_long,
    control: m.network_input_control,
    not_http: m.network_input_not_http,
    scheme: m.network_input_scheme,
    too_many: m.network_input_too_many,
  };

  // 新增表单
  let subscription = $state("");
  let nodeFile = $state("");
  let inline = $state("");
  let formError = $state<{ field: "subscription" | "node-file" | "inline" | "edit"; message: string } | null>(null);

  // 行内替换（订阅或手动节点）
  let editing = $state<{ kind: "subscription" | "inline"; id: string } | null>(null);
  let editValue = $state("");

  function fail(field: NonNullable<typeof formError>["field"], error: SourceInputError, line: number | null = null) {
    const message = INPUT_ERRORS[error]();
    formError = { field, message: line === null ? message : m.network_input_line({ line, message }) };
  }

  async function addSubscription(event: SubmitEvent) {
    event.preventDefault();
    const error = validateSubscriptionUrl(subscription);
    if (error) return fail("subscription", error);
    formError = null;
    if (await writer.run("subscription:add", () => proxySources.addSubscription(api, subscription.trim()), m.network_source_saved)) subscription = "";
  }

  async function saveNodeFile(event: SubmitEvent) {
    event.preventDefault();
    const error = validateLocalPath(nodeFile);
    if (error) return fail("node-file", error);
    formError = null;
    if (await writer.run("node-file:set", () => proxySources.setNodeFile(api, nodeFile.trim()), m.network_source_saved)) nodeFile = "";
  }

  async function addInline(event: SubmitEvent) {
    event.preventDefault();
    const parsed = parseInlineNodes(inline);
    if (parsed.error) return fail("inline", parsed.error, parsed.line);
    formError = null;
    if (await writer.run("inline:add", () => proxySources.addInlineNodes(api, parsed.nodes), m.network_source_saved)) inline = "";
  }

  function startEdit(kind: "subscription" | "inline", id: string) {
    editing = { kind, id };
    editValue = "";
    formError = null;
  }

  async function saveEdit(event: SubmitEvent) {
    event.preventDefault();
    const target = editing;
    if (!target) return;
    const value = editValue.trim();
    const error = target.kind === "subscription" ? validateSubscriptionUrl(value) : validateInlineNode(value);
    if (error) return fail("edit", error);
    formError = null;
    const work =
      target.kind === "subscription"
        ? () => proxySources.replaceSubscription(api, target.id, value)
        : () => proxySources.replaceInlineNode(api, target.id, value);
    if (await writer.run(`${target.kind}:replace`, work, m.network_source_saved)) editing = null;
  }

  function remove(title: string, work: () => Promise<void>) {
    confirm({
      title,
      body: m.network_source_remove_body(),
      action: m.network_remove(),
      run: () => void writer.run("source:remove", work, m.network_source_removed),
    });
  }
</script>

<section aria-labelledby="network-proxy" class="flex flex-col gap-3" data-testid="network-proxy" data-profile={view ? (view.legacy ? "legacy" : "desktop") : null}>
  <div class="flex items-center gap-2">
    <h2 id="network-proxy" class="text-sm font-semibold">{m.network_proxy_title()}</h2>
    {#if view?.legacy || source?.legacy}<Badge variant="outline" data-testid="network-proxy-legacy">{m.network_legacy()}</Badge>{/if}
  </div>

  {#if status.error}
    <p class="text-sm text-danger" role="alert">{m.network_load_failed({ reason: apiErrorMessage(status.error) })}</p>
  {:else if view}
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div class="flex items-center gap-2" data-testid="network-proxy-state" data-status={tone(view)}>
        <StatusDot status={tone(view)} />
        <span class="text-sm text-fg">{summary(view)}</span>
        {#if view.engine}<span class="text-2xs text-fg3">{view.engine}</span>{/if}
      </div>
      {#if writable}
        <div class="ml-auto flex items-center gap-1.5">
          {#each ACTIONS as action (action.id)}
            <Button
              variant="outline"
              size="sm"
              disabled={!controls[action.id]}
              data-proxy-action={action.id}
              onclick={() => void writer.run(action.id, () => runProxyAction(api, action.id), action.done)}
            >
              {action.label()}
            </Button>
          {/each}
        </div>
      {/if}
    </div>
    {#if view.leases > 0}<p class="text-2xs text-fg3">{m.network_proxy_leased({ leases: view.leases })}</p>{/if}
    {#if view.reloadRequired}<p class="text-xs text-warn" data-testid="network-proxy-reload">{m.network_proxy_reload_required()}</p>{/if}
    {#if view.lastError}<p class="text-xs text-danger">{view.lastError}</p>{/if}
    {#if view.transportCore.enabled && view.transportCore.lastError}
      <p class="text-xs text-danger">{m.network_proxy_core_error({ reason: view.transportCore.lastError })}</p>
    {/if}
    {#each view.warnings as warning, index (index)}<p class="text-xs text-warn">{warning}</p>{/each}

    {#if view.nodes.length}
      <table class="w-full table-fixed border-collapse text-left" data-testid="network-proxy-nodes">
        <colgroup><col class="w-[18px]" /><col /><col class="w-[90px]" /><col /><col class="w-[80px]" /><col class="w-[60px]" /></colgroup>
        <thead>
          <tr class="border-b border-line text-2xs text-fg3">
            <th scope="col" class="py-1.5"><span class="sr-only">{m.network_node_health()}</span></th>
            <th scope="col" class="py-1.5 font-normal">{m.network_node_name()}</th>
            <th scope="col" class="py-1.5 font-normal">{m.network_node_protocol()}</th>
            <th scope="col" class="py-1.5 font-normal">{m.network_node_endpoint()}</th>
            <th scope="col" class="py-1.5 text-right font-normal">{m.network_node_latency()}</th>
            <th scope="col" class="py-1.5 text-right font-normal">{m.network_node_leases()}</th>
          </tr>
        </thead>
        <tbody>
          {#each view.nodes as node (node.id)}
            <tr class="h-row border-b border-line" data-node={node.id}>
              <td><StatusDot status={node.healthy ? "ok" : "error"} /></td>
              <td class="truncate pr-3 text-sm text-fg" title={node.lastError || node.name}>{node.name}</td>
              <td class="truncate text-xs text-fg2">{node.protocol}</td>
              <td class="truncate pr-3 font-mono text-2xs text-fg3">{node.endpoint}</td>
              <td class="text-right text-xs text-fg2 tabular-nums">{node.latencyMs === null ? "—" : `${Math.round(node.latencyMs)} ms`}</td>
              <td class="text-right text-xs text-fg2 tabular-nums">{node.leases ?? "—"}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      {#if view.nodesTruncatedFrom !== null}
        <p class="text-2xs text-fg3">{m.network_proxy_nodes_truncated({ shown: view.nodes.length, total: view.nodesTruncatedFrom })}</p>
      {/if}
    {/if}
  {/if}

  {#if sources.error}
    <p class="text-sm text-danger" role="alert">{m.network_load_failed({ reason: apiErrorMessage(sources.error) })}</p>
  {:else if source}
    <div class="flex flex-col gap-3 pt-2" data-testid="network-proxy-sources">
      <div class="flex items-center gap-2">
        <h3 class="text-xs font-medium text-fg2">{m.network_sources_title()}</h3>
        {#if source.hasOverride}<Badge variant="secondary">{m.network_sources_override()}</Badge>{/if}
        {#if source.hasOverride && source.editable}
          <Button
            variant="ghost"
            size="xs"
            class="ml-auto"
            disabled={writer.busy !== null}
            data-testid="network-sources-reset"
            onclick={() =>
              confirm({
                title: m.network_sources_reset(),
                body: m.network_sources_reset_body(),
                action: m.network_sources_reset(),
                run: () => void writer.run("override:clear", () => proxySources.clearOverride(api), m.network_source_saved),
              })}
          >
            {m.network_sources_reset()}
          </Button>
        {/if}
      </div>
      {#if !source.editable}
        <p class="text-xs text-fg3" data-testid="network-sources-readonly">
          {source.legacy ? m.network_sources_readonly_legacy() : m.network_sources_readonly()}
        </p>
      {/if}
      {#if formError}<p class="text-xs text-danger" role="alert" data-testid="network-source-error">{formError.message}</p>{/if}

      <div class="grid grid-cols-[140px_minmax(0,1fr)] gap-x-4 border-t border-line">
        <div class="border-b border-line py-2.5 text-sm text-fg2">{m.network_sources_subscriptions()}</div>
        <div class="flex flex-col gap-1.5 border-b border-line py-2.5">
          {#each source.subscriptions as item (item.id)}
            <div class="flex min-h-control items-center gap-2" data-subscription={item.id}>
              {#if editing?.kind === "subscription" && editing.id === item.id}
                <form class="flex flex-1 items-center gap-2" onsubmit={saveEdit}>
                  <Input bind:value={editValue} placeholder="https://" autocomplete="off" spellcheck={false} aria-label={m.network_replace()} class="flex-1" />
                  <Button type="submit" size="sm" disabled={writer.busy !== null}>{m.network_save()}</Button>
                  <Button variant="ghost" size="sm" onclick={() => (editing = null)}>{m.settings_cancel()}</Button>
                </form>
              {:else}
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg">{item.label}</span>
                {#if item.redacted}<Badge variant="outline">{m.network_redacted()}</Badge>{/if}
                {#if editable}
                  <Button variant="ghost" size="xs" onclick={() => startEdit("subscription", item.id)}>{m.network_replace()}</Button>
                  <Button variant="ghost" size="xs" class="text-danger" onclick={() => remove(m.network_sources_remove_subscription(), () => proxySources.removeSubscription(api, item.id))}>
                    {m.network_remove()}
                  </Button>
                {/if}
              {/if}
            </div>
          {:else}
            <p class="text-xs text-fg3">{m.network_none()}</p>
          {/each}
          {#if editable}
            <form class="flex items-center gap-2" onsubmit={addSubscription}>
              <Input
                bind:value={subscription}
                placeholder="https://example.com/sub"
                autocomplete="off"
                spellcheck={false}
                aria-label={m.network_sources_add_subscription()}
                data-testid="network-subscription-input"
                aria-invalid={formError?.field === "subscription"}
                class="max-w-[480px] flex-1"
              />
              <Button type="submit" size="sm" disabled={!subscription.trim()} data-testid="network-subscription-add">{m.network_add()}</Button>
            </form>
          {/if}
        </div>

        <div class="border-b border-line py-2.5 text-sm text-fg2">{m.network_sources_node_file()}</div>
        <div class="flex flex-col gap-1.5 border-b border-line py-2.5">
          <div class="flex min-h-control items-center gap-2">
            <span class="min-w-0 flex-1 truncate font-mono text-xs {source.nodeFile.configured ? 'text-fg' : 'text-fg3'}" data-testid="network-node-file">
              {source.nodeFile.configured ? (source.nodeFile.path ?? m.network_configured()) : m.network_none()}
            </span>
            {#if editable && source.nodeFile.configured}
              <Button variant="ghost" size="xs" class="text-danger" onclick={() => remove(m.network_sources_remove_node_file(), () => proxySources.clearNodeFile(api))}>
                {m.network_remove()}
              </Button>
            {/if}
          </div>
          {#if editable}
            <form class="flex items-center gap-2" onsubmit={saveNodeFile}>
              <Input
                bind:value={nodeFile}
                placeholder={m.network_sources_node_file_placeholder()}
                autocomplete="off"
                spellcheck={false}
                aria-label={m.network_sources_node_file()}
                aria-invalid={formError?.field === "node-file"}
                class="max-w-[480px] flex-1"
              />
              <Button type="submit" size="sm" disabled={!nodeFile.trim()}>{m.network_save()}</Button>
            </form>
          {/if}
        </div>

        <div class="border-b border-line py-2.5 text-sm text-fg2">{m.network_sources_inline()}</div>
        <div class="flex flex-col gap-1.5 border-b border-line py-2.5">
          {#each source.inlineNodes as node (node.id)}
            <div class="flex min-h-control items-center gap-2" data-inline-node={node.id}>
              {#if editing?.kind === "inline" && editing.id === node.id}
                <form class="flex flex-1 items-center gap-2" onsubmit={saveEdit}>
                  <Input bind:value={editValue} placeholder="socks5://" autocomplete="off" spellcheck={false} aria-label={m.network_replace()} class="flex-1" />
                  <Button type="submit" size="sm" disabled={writer.busy !== null}>{m.network_save()}</Button>
                  <Button variant="ghost" size="sm" onclick={() => (editing = null)}>{m.settings_cancel()}</Button>
                </form>
              {:else}
                <span class="w-[140px] truncate text-sm text-fg">{node.name || "—"}</span>
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-fg2">{node.label}</span>
                {#if node.requiresCore}<Badge variant="outline">{m.network_requires_core()}</Badge>{/if}
                {#if editable}
                  <Button variant="ghost" size="xs" onclick={() => startEdit("inline", node.id)}>{m.network_replace()}</Button>
                  <Button variant="ghost" size="xs" class="text-danger" onclick={() => remove(m.network_sources_remove_inline(), () => proxySources.removeInlineNode(api, node.id))}>
                    {m.network_remove()}
                  </Button>
                {/if}
              {/if}
            </div>
          {:else}
            <p class="text-xs text-fg3">{m.network_none()}</p>
          {/each}
          {#if editable}
            <form class="flex flex-col gap-1.5" onsubmit={addInline}>
              <Textarea
                bind:value={inline}
                rows={3}
                placeholder={"socks5://127.0.0.1:1080\nvless://…"}
                spellcheck={false}
                aria-label={m.network_sources_inline()}
                aria-invalid={formError?.field === "inline"}
                class="max-w-[560px] font-mono text-xs"
              />
              <div class="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={!inline.trim()}>{m.network_add()}</Button>
                <span class="text-2xs text-fg3">{m.network_sources_inline_hint()}</span>
              </div>
            </form>
          {/if}
        </div>
      </div>
      {#if source.truncated}<p class="text-2xs text-fg3">{m.network_sources_truncated()}</p>{/if}
    </div>
  {/if}
</section>
