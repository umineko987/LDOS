<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import NavDot from "#lib/components/shell/nav-dot.svelte";
  import PageHeader from "#lib/components/shell/page-header.svelte";
  import { STAGES, stageOf, type Stage } from "#lib/nav/routes.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 数据集外框：标题 + 阶段导航。每个阶段页只渲染自己的内容，放在下面的 children 里。
  let { children } = $props();

  const LABELS: Record<Stage, () => string> = {
    collect: m.stage_collect,
    clean: m.stage_clean,
    dedup: m.stage_dedup,
    tag: m.stage_tag,
    review: m.stage_review,
    export: m.stage_export,
    atlas: m.stage_atlas,
  };

  const id = $derived(page.params.id ?? "");
  const current = $derived(stageOf(page.route.id));
</script>

<PageHeader title={m.page_dataset({ id })} class="pb-0">
  <nav aria-label={m.nav_stages()} class="relative mt-3 flex gap-0.5" data-testid="stage-rail">
    {#each STAGES as stage (stage)}
      <a
        href={resolve(`/datasets/[id]/${stage}`, { id })}
        data-active={current === stage || undefined}
        aria-current={current === stage ? "page" : undefined}
        data-stage={stage}
        class="flex h-9 items-center px-3 text-sm text-fg2 transition-colors duration-(--t-color) hover:text-fg data-active:text-fg {stage ===
        'atlas'
          ? 'ml-auto'
          : ''}"
      >
        {LABELS[stage]()}<span data-dot-anchor class="ml-[5px] inline-block h-[7px] w-0"></span>
      </a>
    {/each}
    <NavDot active={current} />
  </nav>
</PageHeader>

<div class="flex min-h-0 flex-1 flex-col">
  {@render children()}
</div>
