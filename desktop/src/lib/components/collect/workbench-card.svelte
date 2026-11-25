<script lang="ts">
  import CheckIcon from "@lucide/svelte/icons/check";
  import ImageOffIcon from "@lucide/svelte/icons/image-off";
  import ZoomInIcon from "@lucide/svelte/icons/zoom-in";
  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { buttonVariants } from "#lib/components/ui/button/index.ts";
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
  const descriptionId = $props.id();
  let inspectLabel = $derived(m.collect_workbench_open_item({ title }));
  let failedPreview = $state("");
</script>

<article class={cn("relative min-w-0 rounded-md border bg-bg1", selected ? "border-gold bg-gold-12 ring-2 ring-gold" : focused ? "border-fg2" : "border-line")} data-workbench-item={id}>
  <button
    type="button"
    class="group flex h-full w-full min-w-0 flex-col rounded-md text-left enabled:cursor-pointer focus-visible:outline-offset-4"
    {disabled}
    aria-label={m.collect_workbench_select_item({ title })}
    aria-pressed={selected}
    aria-describedby={descriptionId}
    onclick={ontoggle}
  >
    <span class="relative block aspect-square w-full shrink-0 overflow-hidden rounded-t-[5px] bg-bg2">
      {#if preview && failedPreview !== preview}
        <img src={preview} alt="" crossorigin="anonymous" loading="lazy" decoding="async" class="size-full object-cover" onerror={() => (failedPreview = preview)} />
      {:else}
        <span class="grid size-full place-content-center text-fg2"><ImageOffIcon aria-hidden="true" class="size-5" /></span>
      {/if}
      {#if selected || !disabled}
        <span
          aria-hidden="true"
          class={cn("absolute top-2 left-2 grid size-6 place-items-center rounded-sm border", selected ? "border-gold bg-gold text-gold-ink" : "border-fg2 bg-bg1 group-hover:border-gold")}
        >
          {#if selected}<CheckIcon class="size-4" />{/if}
        </span>
      {/if}
      {#if checkpoint}
        <Badge class="absolute bottom-2 left-2 max-w-[calc(100%-1rem)]">
          <span class="truncate">{m.collect_workbench_last_submitted()}</span>
        </Badge>
      {/if}
    </span>
    <span class="flex w-full flex-col gap-0.5 p-2">
      <span class="truncate text-xs font-medium group-enabled:group-hover:underline" {title}>{title}</span>
      <span id={descriptionId} class="flex min-w-0 flex-col gap-0.5 text-2xs text-fg2">
        <span class="truncate">{meta}</span>
        {#if status}<span class="truncate" title={status}>{status}</span>{/if}
      </span>
    </span>
  </button>
  <button
    type="button"
    class={cn(buttonVariants({ size: "icon-lg" }), "absolute top-2 right-2 cursor-pointer pointer-coarse:size-11")}
    data-inspect
    aria-label={inspectLabel}
    aria-expanded={focused}
    aria-describedby={disabled ? descriptionId : undefined}
    title={inspectLabel}
    onclick={(event) => onfocusitem(event.currentTarget)}
  >
    <ZoomInIcon aria-hidden="true" />
  </button>
</article>
