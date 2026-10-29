<script lang="ts">
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { InstallButton, LicenseDialog, MODEL_USE_LABELS, ModelStatus, useModelInstaller } from "#lib/components/model-install/index.ts";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { byKey, canInstall, formatBytes, type ModelItem } from "#lib/domain/models.ts";
  import { i18n } from "#lib/i18n/locale.svelte.ts";
  import { m } from "#lib/paraglide/messages.js";

  import DownloadSettings from "./download-settings.svelte";

  // 设置 › 模型：一张模型表（状态、大小、许可、用途、同包模型）+ 下载设置。
  const installer = useModelInstaller();

  const FAMILIES: { id: ModelItem["family"]; label: () => string }[] = [
    { id: "dedup", label: m.models_family_dedup },
    { id: "tagger", label: m.models_family_tagger },
  ];

  const groups = $derived(
    FAMILIES.map((family) => ({ ...family, items: installer.items.filter((item) => item.family === family.id) })).filter(
      (group) => group.items.length,
    ),
  );
  // 安装中的也算进来，标题栏按钮才会显示「安装中…」。
  const installable = $derived(installer.items.filter((item) => canInstall(item) || item.status === "installing").map((item) => item.key));

  function companions(item: ModelItem): string | null {
    if (!item.installs_with.length) return null;
    const index = byKey(installer.items);
    const names = item.installs_with.map((key) => index.get(key)?.display_name ?? key);
    return m.models_installs_with({ names: new Intl.ListFormat(i18n.current, { type: "conjunction" }).format(names) });
  }
</script>

<PageHeader title={m.nav_settings_models()} subtitle={m.models_subtitle()}>
  {#snippet actions()}
    <InstallButton {installer} keys={installable} label={m.models_install_all()} variant="primary" />
  {/snippet}
</PageHeader>

<div class="flex max-w-[1080px] flex-col gap-8 px-7 py-5" data-testid="models">
  {#if installer.error}
    <p class="text-sm text-danger" role="alert" data-testid="models-error">
      {m.models_load_failed({ reason: apiErrorMessage(installer.error) })}
    </p>
  {:else if installer.loaded && !groups.length}
    <p class="text-sm text-fg3">{m.models_empty()}</p>
  {/if}

  {#each groups as group (group.id)}
    <section aria-labelledby="models-{group.id}" class="flex flex-col gap-2">
      <h2 id="models-{group.id}" class="text-sm font-semibold">{group.label()}</h2>
      <table class="w-full table-fixed border-collapse text-left">
        <colgroup>
          <col />
          <col class="w-[150px]" />
          <col class="w-[84px]" />
          <col class="w-[150px]" />
          <col class="w-[150px]" />
          <col class="w-[92px]" />
        </colgroup>
        <thead>
          <tr class="border-b border-line text-2xs text-fg3">
            <th scope="col" class="py-1.5 font-normal">{m.models_column_model()}</th>
            <th scope="col" class="py-1.5 font-normal">{m.models_column_status()}</th>
            <th scope="col" class="py-1.5 text-right font-normal">{m.models_column_size()}</th>
            <th scope="col" class="py-1.5 pl-4 font-normal">{m.models_column_license()}</th>
            <th scope="col" class="py-1.5 font-normal">{m.models_column_used_by()}</th>
            <th scope="col" class="py-1.5"><span class="sr-only">{m.models_install()}</span></th>
          </tr>
        </thead>
        <tbody>
          {#each group.items as item (item.key)}
            {@const size = formatBytes(item.size_bytes, i18n.current)}
            {@const together = companions(item)}
            <tr class="h-row border-b border-line align-middle" data-model={item.key} data-status={item.status}>
              <td class="py-1.5 pr-3">
                <div class="flex min-w-0 flex-col">
                  <span class="truncate text-sm text-fg">{item.display_name}</span>
                  <span class="truncate text-2xs text-fg3">
                    <span class="font-mono">{item.key}</span>{#if together}<span> · {together}</span>{/if}
                  </span>
                </div>
              </td>
              <td class="py-1.5 pr-3"><ModelStatus {item} /></td>
              <td class="py-1.5 text-right text-xs text-fg2 tabular-nums">{size ?? "—"}</td>
              <td class="py-1.5 pl-4">
                <div class="flex min-w-0 items-center gap-1.5">
                  <a
                    href={item.source_url}
                    target="_blank"
                    rel="noreferrer"
                    class="truncate text-xs text-fg2 underline-offset-4 hover:text-fg hover:underline"
                    title={item.source_url}
                  >
                    {item.license ?? m.models_license_unknown()}
                  </a>
                  {#if item.gated}<Badge variant="outline">{m.models_license_gated()}</Badge>{/if}
                </div>
              </td>
              <td class="py-1.5">
                <div class="flex flex-wrap gap-1">
                  {#each item.used_by as use (use)}<Badge variant="secondary">{MODEL_USE_LABELS[use]()}</Badge>{/each}
                </div>
              </td>
              <td class="py-1.5 text-right">
                {#if canInstall(item)}
                  <InstallButton {installer} keys={[item.key]} label={item.status === "failed" ? m.models_retry() : undefined} variant="ghost" size="xs" />
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/each}

  <DownloadSettings />
</div>

<LicenseDialog {installer} />
