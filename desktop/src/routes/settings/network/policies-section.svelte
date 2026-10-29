<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { networkKeys, policies, policiesQuery } from "#lib/api/queries/network.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import {
    parsePolicyDraft,
    policiesView,
    policyDraft,
    POLICY_LIMITS,
    samePolicy,
    type PolicyDraft,
    type PolicyFields,
    type PolicyNumberField,
    type PolicyRow,
    type ProxyMode,
  } from "#lib/domain/network.ts";
  import { m } from "#lib/paraglide/messages.js";

  import type { ConfirmRequest } from "./confirm-dialog.svelte";
  import { useWriter } from "./writer.svelte.ts";

  // 站点策略：并发、重试、退避、代理方式。对之后新建的任务生效；未覆盖的站点继承默认值。
  let { confirm }: { confirm: (request: ConfirmRequest) => void } = $props();

  const api = useApi();
  const writer = useWriter(networkKeys.policies());
  const query = createQuery(() => policiesQuery(api));
  const view = $derived(query.data ? policiesView(query.data) : null);

  const PROXY_MODES: Record<ProxyMode, () => string> = {
    direct: m.network_policy_direct,
    prefer: m.network_policy_prefer,
    required: m.network_policy_required,
  };
  const proxyOptions = $derived((Object.keys(PROXY_MODES) as ProxyMode[]).map((value) => ({ value, label: PROXY_MODES[value]() })));

  const FIELDS: { id: PolicyNumberField; label: () => string; step: string }[] = [
    { id: "max_concurrency", label: m.network_policy_concurrency, step: "1" },
    { id: "retry_limit", label: m.network_policy_retries, step: "1" },
    { id: "backoff_base_seconds", label: m.network_policy_backoff, step: "0.5" },
  ];

  let editing = $state<{ site: string; draft: PolicyDraft; original: PolicyFields } | null>(null);
  let invalid = $state<readonly PolicyNumberField[]>([]);

  function edit(row: PolicyRow) {
    const policy = row.policy ?? view?.defaultPolicy;
    if (!policy) return;
    editing = { site: row.site, draft: policyDraft(policy), original: policy };
    invalid = [];
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    const target = editing;
    if (!target) return;
    const parsed = parsePolicyDraft(target.draft);
    invalid = parsed.invalid;
    if (!parsed.policy) return;
    const policy = parsed.policy;
    if (samePolicy(policy, target.original)) {
      editing = null;
      return;
    }
    if (await writer.run(`update:${target.site}`, () => policies.update(api, target.site, policy), m.network_policy_saved)) editing = null;
  }

  function reset(row: PolicyRow) {
    confirm({
      title: m.network_policy_reset_title({ site: row.label }),
      body: m.network_policy_reset_body(),
      action: m.network_policy_reset(),
      run: () => void writer.run(`reset:${row.site}`, () => policies.reset(api, row.site), m.network_policy_saved),
    });
  }

  const backoff = (seconds: number) => m.network_policy_seconds({ seconds: String(seconds) });
</script>

{#snippet values(policy: PolicyFields | null)}
  {#if policy}
    <td class="text-right text-xs text-fg2 tabular-nums">{policy.max_concurrency}</td>
    <td class="text-right text-xs text-fg2 tabular-nums">{policy.retry_limit}</td>
    <td class="text-right text-xs text-fg2 tabular-nums">{backoff(policy.backoff_base_seconds)}</td>
    <td class="pl-4 text-xs text-fg2">{PROXY_MODES[policy.proxy_mode]()}</td>
  {:else}
    <td colspan="4" class="text-xs text-fg3">—</td>
  {/if}
{/snippet}

<section aria-labelledby="network-policies" class="flex flex-col gap-3" data-testid="network-policies" data-profile={view ? (view.legacy ? "legacy" : "policy") : null}>
  <div class="flex items-center gap-2">
    <h2 id="network-policies" class="text-sm font-semibold">{m.network_policies_title()}</h2>
    <span class="text-xs text-fg3">{m.network_policies_hint()}</span>
    {#if view?.legacy}<Badge variant="outline" data-testid="network-policies-legacy">{m.network_legacy()}</Badge>{/if}
  </div>

  {#if query.error}
    <p class="text-sm text-danger" role="alert">{m.network_load_failed({ reason: apiErrorMessage(query.error) })}</p>
  {:else if view}
    <table class="w-full table-fixed border-collapse text-left">
      <colgroup><col /><col class="w-[72px]" /><col class="w-[72px]" /><col class="w-[84px]" /><col class="w-[110px]" /><col class="w-[96px]" /><col class="w-[150px]" /></colgroup>
      <thead>
        <tr class="border-b border-line text-2xs text-fg3">
          <th scope="col" class="py-1.5 font-normal">{m.network_policy_site()}</th>
          {#each FIELDS as field (field.id)}<th scope="col" class="py-1.5 text-right font-normal">{field.label()}</th>{/each}
          <th scope="col" class="py-1.5 pl-4 font-normal">{m.network_policy_proxy()}</th>
          <th scope="col" class="py-1.5 font-normal">{m.network_policy_source()}</th>
          <th scope="col" class="py-1.5"><span class="sr-only">{m.network_policy_actions()}</span></th>
        </tr>
      </thead>
      <tbody>
        <tr class="h-row border-b border-line" data-policy="default">
          <td class="text-sm text-fg">{m.network_policy_default()}</td>
          {@render values(view.defaultPolicy)}
          <td colspan="2" class="text-2xs text-fg3">{m.network_policy_default_hint()}</td>
        </tr>
        {#each view.rows as row (row.site)}
          {#if editing?.site === row.site}
            {@const current = editing}
            <tr class="border-b border-line bg-bg1" data-policy={row.site} data-editing="true">
              <td class="py-2 text-sm text-fg">{row.label}</td>
              <td colspan="6" class="py-2">
                <form class="flex flex-wrap items-center gap-3" onsubmit={save} novalidate>
                  {#each FIELDS as field (field.id)}
                    <label class="flex items-center gap-1.5 text-2xs text-fg3">
                      {field.label()}
                      <Input
                        type="number"
                        inputmode="decimal"
                        min={POLICY_LIMITS[field.id].min}
                        max={POLICY_LIMITS[field.id].max}
                        step={field.step}
                        value={current.draft[field.id]}
                        oninput={(event) => (editing = { ...current, draft: { ...current.draft, [field.id]: event.currentTarget.value } })}
                        aria-invalid={invalid.includes(field.id)}
                        data-policy-field={field.id}
                        class="h-6 w-[72px] text-xs"
                      />
                    </label>
                  {/each}
                  <Segmented
                    label={m.network_policy_proxy()}
                    value={current.draft.proxy_mode}
                    options={proxyOptions}
                    onchange={(proxy_mode) => (editing = { ...current, draft: { ...current.draft, proxy_mode } })}
                    data-policy-field="proxy_mode"
                  />
                  <div class="ml-auto flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" onclick={() => (editing = null)}>{m.settings_cancel()}</Button>
                    <Button type="submit" size="sm" disabled={writer.busy !== null} data-testid="network-policy-save">{m.network_save()}</Button>
                  </div>
                  {#if invalid.length}
                    <p class="basis-full text-xs text-danger" role="alert">{m.network_policy_invalid()}</p>
                  {/if}
                </form>
              </td>
            </tr>
          {:else}
            <tr class="h-row border-b border-line" data-policy={row.site} data-override={row.hasOverride}>
              <td class="truncate pr-3 text-sm text-fg" title={row.reason || row.label}>{row.label}</td>
              {@render values(row.policy)}
              <td class="text-2xs text-fg3">{row.hasOverride ? m.network_policy_override() : m.network_policy_inherited()}</td>
              <td class="text-right">
                {#if row.editable}
                  <Button variant="ghost" size="xs" disabled={writer.busy !== null || editing !== null} onclick={() => edit(row)}>{m.network_policy_edit()}</Button>
                  {#if row.hasOverride}
                    <Button variant="ghost" size="xs" disabled={writer.busy !== null} onclick={() => reset(row)}>{m.network_policy_reset()}</Button>
                  {/if}
                {:else if row.reason}
                  <span class="text-2xs text-fg3" title={row.reason}>{m.network_policy_locked()}</span>
                {/if}
              </td>
            </tr>
          {/if}
        {/each}
      </tbody>
    </table>
    {#if view.unknownOverrides > 0}<p class="text-2xs text-fg3">{m.network_policy_unknown({ count: view.unknownOverrides })}</p>{/if}
  {/if}
</section>
