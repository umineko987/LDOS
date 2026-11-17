<script lang="ts">
  import RefreshCwIcon from "@lucide/svelte/icons/refresh-cw";
  import { createQuery } from "@tanstack/svelte-query";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { diagnosticsConfigQuery, readinessQuery, type ComponentStatus } from "#lib/api/queries/system.ts";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import StatusDot from "#lib/components/status-dot.svelte";
  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { DIAGNOSTICS_POLL_MS, groupComponents, overallStatus, type DiagnosticDomain } from "#lib/domain/diagnostics.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { usePlatform } from "#lib/platform/context.ts";

  const api = useApi();
  const platform = usePlatform();

  const readiness = createQuery(() => ({ ...readinessQuery(api), refetchInterval: DIAGNOSTICS_POLL_MS }));
  const config = createQuery(() => diagnosticsConfigQuery(api));

  const groups = $derived(readiness.data ? groupComponents(readiness.data.components) : []);
  const overall = $derived(readiness.data ? overallStatus(readiness.data.components) : null);
  const refreshing = $derived(readiness.isFetching || config.isFetching);

  const DOMAINS: Record<DiagnosticDomain, () => string> = {
    service: m.diag_domain_service,
    network: m.diag_domain_network,
    tasks: m.diag_domain_tasks,
    dedup: m.diag_domain_dedup,
    other: m.diag_domain_other,
  };

  const COMPONENTS: Readonly<Record<string, () => string>> = {
    process: m.diag_component_process,
    database: m.diag_component_database,
    gallery_source: m.diag_component_gallery_source,
    project_proxy: m.diag_component_project_proxy,
    mihomo: m.diag_component_mihomo,
    scheduler: m.diag_component_scheduler,
    ordered_crawls: m.diag_component_ordered_crawls,
    dedup: m.diag_component_dedup,
    dedup_python: m.diag_component_dedup_python,
    torch: m.diag_component_torch,
    sscd_model: m.diag_component_sscd_model,
    dino_model: m.diag_component_dino_model,
  };

  const STATUS: Record<ComponentStatus, () => string> = {
    ok: m.diag_status_ok,
    warning: m.diag_status_warning,
    error: m.diag_status_error,
    disabled: m.diag_status_disabled,
  };

  const OVERALL: Record<ComponentStatus, () => string> = {
    ok: m.diag_overall_ok,
    warning: m.diag_overall_warning,
    error: m.diag_overall_error,
    disabled: m.diag_overall_ok,
  };

  const componentLabel = (id: string) => (Object.hasOwn(COMPONENTS, id) ? COMPONENTS[id]!() : id);
  const onOff = (value: boolean) => (value ? m.diag_on() : m.diag_off());

  const configRows = $derived.by(() => {
    const value = config.data;
    if (!value) return [];
    const device =
      value.dedupDevice === "auto" ? m.diag_device_auto() : value.dedupDevice === "unknown" ? m.diag_device_unknown() : value.dedupDevice.toUpperCase();
    return [
      { id: "loopback", label: m.diag_config_loopback(), value: onOff(value.loopbackOnly) },
      { id: "cors", label: m.diag_config_cors(), value: onOff(value.corsEnabled) },
      { id: "private_targets", label: m.diag_config_private_targets(), value: onOff(value.privateTargetsEnabled) },
      { id: "proxy", label: m.diag_config_proxy(), value: onOff(value.proxyEnabled) },
      { id: "proxy_auto_start", label: m.diag_config_proxy_auto_start(), value: onOff(value.proxyAutoStart) },
      { id: "transport_core", label: m.diag_config_transport_core(), value: onOff(value.transportCoreEnabled) },
      { id: "scheduler_capacity", label: m.diag_config_scheduler_capacity(), value: String(value.schedulerCapacity) },
      { id: "dedup", label: m.diag_config_dedup(), value: onOff(value.dedupEnabled) },
      { id: "dedup_device", label: m.diag_config_dedup_device(), value: device },
      { id: "sscd", label: m.diag_config_sscd(), value: onOff(value.sscdEnabled) },
      { id: "dino", label: m.diag_config_dino(), value: onOff(value.dinoEnabled) },
    ];
  });

  const checkedAt = $derived.by(() => {
    const time = readiness.data?.time;
    if (time === null || time === undefined) return null;
    return new Intl.DateTimeFormat(i18n.current, { timeStyle: "medium" }).format(new Date(time * 1000));
  });

  function refresh() {
    void readiness.refetch();
    void config.refetch();
  }
</script>

<PageHeader title={m.nav_settings_diagnostics()} subtitle={m.diag_auto_refresh()}>
  {#snippet actions()}
    <Button variant="outline" size="sm" onclick={refresh} disabled={refreshing} data-testid="diag-refresh">
      <RefreshCwIcon class={refreshing ? "animate-spin" : ""} />
      {m.diag_refresh()}
    </Button>
  {/snippet}
</PageHeader>

<div class="flex max-w-[980px] flex-col gap-6 px-7 py-5" data-testid="diagnostics">
  {#if readiness.error}
    <p class="text-sm text-danger" role="alert" data-testid="diag-error">
      {m.diag_load_failed({ reason: apiErrorMessage(readiness.error) })}
    </p>
  {:else if overall}
    <div class="flex items-center gap-2.5" data-testid="diag-overall" data-status={overall}>
      <StatusDot status={overall} />
      <span class="text-sm text-fg">{OVERALL[overall]()}</span>
      {#if checkedAt}<span class="text-2xs text-fg3">{m.diag_checked_at({ time: checkedAt })}</span>{/if}
    </div>
  {/if}

  {#if groups.length}
    <section aria-labelledby="diag-components" class="flex flex-col gap-4">
      <h2 id="diag-components" class="text-sm font-semibold">{m.diag_section_components()}</h2>
      {#each groups as group (group.domain)}
        <div class="flex flex-col">
          <h3 class="pb-1.5 text-xs font-medium text-fg2">{DOMAINS[group.domain]()}</h3>
          <ul class="flex flex-col border-t border-line">
            {#each group.components as component (component.id)}
              <li
                class="grid min-h-row grid-cols-[14px_180px_minmax(0,1fr)_auto_64px] items-center gap-x-2 border-b border-line py-1.5"
                data-component={component.id}
                data-status={component.status}
              >
                <StatusDot status={component.status} />
                <span class="truncate text-sm text-fg">{componentLabel(component.id)}</span>
                <span class="truncate text-xs text-fg3" title={component.summary}>{component.summary}</span>
                <Badge variant="outline">{component.required ? m.diag_required() : m.diag_optional()}</Badge>
                <span class="text-right text-xs text-fg2">{STATUS[component.status]()}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/each}
      {#if i18n.current !== "zh-CN"}<p class="text-2xs text-fg3">{m.diag_summary_language()}</p>{/if}
    </section>
  {/if}

  <section aria-labelledby="diag-environment" class="flex flex-col gap-2">
    <h2 id="diag-environment" class="text-sm font-semibold">{m.diag_section_environment()}</h2>
    <dl class="grid grid-cols-[180px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      <dt class="text-fg2">{m.diag_mode()}</dt>
      <dd data-testid="diag-mode">{platform.mode === "mygo" ? "MyGo" : m.diag_mode_browser()}</dd>
      <dt class="text-fg2">{m.diag_api_origin()}</dt>
      <dd class="font-mono text-xs leading-5">{api.origin}</dd>
    </dl>
  </section>

  {#if config.error}
    <p class="text-sm text-danger" role="alert">{m.diag_load_failed({ reason: apiErrorMessage(config.error) })}</p>
  {:else if configRows.length}
    <section aria-labelledby="diag-config" class="flex flex-col gap-2">
      <h2 id="diag-config" class="text-sm font-semibold">{m.diag_section_config()}</h2>
      <dl class="grid grid-cols-[180px_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm" data-testid="diag-config">
        {#each configRows as row (row.id)}
          <dt class="text-fg2">{row.label}</dt>
          <dd data-config={row.id}>{row.value}</dd>
        {/each}
      </dl>
    </section>
  {/if}
</div>
