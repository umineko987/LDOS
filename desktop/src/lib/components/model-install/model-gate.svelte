<script lang="ts">
  import type { Snippet } from "svelte";

  import { apiErrorMessage } from "#lib/api/messages.ts";
  import { byKey, missingKeys } from "#lib/domain/models.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  import InstallButton from "./install-button.svelte";
  import { useModelInstaller } from "./installer.svelte.ts";
  import LicenseDialog from "./license-dialog.svelte";
  import ModelStatus from "./model-status.svelte";

  // 阶段页用的模型门：列出这一步缺的模型，就地安装（含许可确认和进度）。
  // 模型都装好之前 block=true 时不渲染 children；block=false 时提示条和 children 同时显示。
  let {
    keys,
    block = true,
    ready = $bindable(false),
    title,
    children,
    class: className,
  }: {
    /** 这一步需要的模型 key（GET /api/v1/models 里的 `key`）。 */
    keys: readonly string[];
    block?: boolean;
    /** 只读输出：所有 key 都已安装。 */
    ready?: boolean;
    title?: string;
    children?: Snippet;
    class?: string;
  } = $props();

  const installer = useModelInstaller();

  const loaded = $derived(installer.loaded);
  const missing = $derived(loaded ? missingKeys(installer.items, keys) : [...keys]);
  const rows = $derived.by(() => {
    const index = byKey(installer.items);
    return missing.map((key) => ({ key, item: index.get(key) }));
  });

  $effect(() => {
    ready = loaded && missing.length === 0;
  });
</script>

{#if installer.error && !loaded}
  <p class={cn("text-sm text-danger", className)} role="alert" data-testid="model-gate-error">
    {m.models_load_failed({ reason: apiErrorMessage(installer.error) })}
  </p>
{:else if loaded && missing.length}
  <section
    class={cn("flex flex-col gap-2 rounded-lg border border-line bg-bg1 px-4 py-3", className)}
    aria-labelledby="model-gate-title"
    data-testid="model-gate"
  >
    <div class="flex items-center gap-3">
      <div class="flex min-w-0 flex-1 flex-col">
        <h2 id="model-gate-title" class="text-sm font-semibold">{title ?? m.models_gate_title()}</h2>
        <p class="text-xs text-fg3">{m.models_gate_body()}</p>
      </div>
      <InstallButton {installer} keys={missing} label={m.models_install_all()} variant="primary" />
    </div>
    <ul class="flex flex-col border-t border-line">
      {#each rows as row (row.key)}
        <li class="grid min-h-row grid-cols-[minmax(0,1fr)_160px] items-center gap-3 border-b border-line py-1.5 last:border-b-0" data-gate-model={row.key}>
          <span class="truncate text-sm text-fg">{row.item?.display_name ?? row.key}</span>
          {#if row.item}<ModelStatus item={row.item} />{:else}<span class="text-xs text-fg3">{m.models_unknown()}</span>{/if}
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#if (loaded && !missing.length) || !block}
  {@render children?.()}
{/if}

<LicenseDialog {installer} />
