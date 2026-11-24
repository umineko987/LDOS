<script lang="ts">
  import ImageOffIcon from "@lucide/svelte/icons/image-off";
  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  let { id, title, preview, meta, status, selected, disabled, focused, checkpoint, onfocusitem, ontoggle }: {
    id: string;
    title: string;
    preview: string;
    meta: string;
    status: string;
    selected: boolean;
    disabled: boolean;
    focused: boolean;
    checkpoint: boolean;
    onfocusitem: (trigger: HTMLButtonElement) => void;
    ontoggle: () => void;
  } = $props();
  let failedPreview = $state("");
</script>

<article class={cn("relative min-w-0 rounded-md border bg-bg1", selected ? "border-gold bg-gold-12" : focused ? "border-fg2" : "border-line")} data-workbench-item={id}>
  <button type="button" class="group block w-full min-w-0 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={m.collect_workbench_open_item({ title })} aria-expanded={focused} onclick={(event) => onfocusitem(event.currentTarget)}>
    <div class="aspect-square overflow-hidden rounded-t-[5px] bg-bg2">
      {#if preview && failedPreview !== preview}
        <img src={preview} alt="" crossorigin="anonymous" loading="lazy" decoding="async" class="size-full object-cover" onerror={() => (failedPreview = preview)} />
      {:else}
        <div class="grid size-full place-content-center text-fg2"><ImageOffIcon aria-hidden="true" class="size-5" /></div>
      {/if}
    </div>
    <div class="flex flex-col gap-0.5 p-2">
      <span class="truncate text-xs font-medium group-hover:underline" {title}>{title}</span>
      <span class="truncate text-2xs text-fg2">{meta}</span>
      {#if status}<span class="truncate text-2xs text-fg2" title={status}>{status}</span>{/if}
    </div>
  </button>
  <div class="pointer-events-none absolute inset-x-2 top-2 flex flex-wrap items-start justify-between gap-1">
    <div class="pointer-events-auto rounded-sm bg-bg1 p-1.5">
      <Checkbox checked={selected} {disabled} aria-label={m.collect_workbench_select_item({ title })} onCheckedChange={ontoggle} />
    </div>
    {#if checkpoint}<Badge variant="default">{m.collect_workbench_last_submitted()}</Badge>{/if}
  </div>
</article>
