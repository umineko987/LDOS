<script lang="ts">
  import { page } from "$app/state";
  import NavDot from "#lib/components/shell/nav-dot.svelte";
  import NavItem from "#lib/components/shell/nav-item.svelte";
  import { settingsNav } from "#lib/components/shell/nav.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 设置：左侧分区导航 + 右侧内容。分区页面放在 settings/<name>/+page.svelte。
  let { children } = $props();

  const links = settingsNav();
  const current = $derived(page.route.id?.replace(/^\/settings\//, "settings.") ?? null);
</script>

<div class="grid h-full min-h-0 grid-cols-[180px_minmax(0,1fr)]">
  <nav aria-label={m.nav_settings_section()} class="relative flex flex-col border-r border-line px-2 py-5">
    <div class="px-2.5 pb-1 text-2xs tracking-[0.04em] text-fg3">{m.nav_settings()}</div>
    {#each links as link (link.id)}
      <NavItem href={link.href} active={current === link.id} data-nav={link.id}>{link.label()}</NavItem>
    {/each}
    <NavDot active={current} />
  </nav>
  <div class="flex min-h-0 flex-col overflow-auto">
    {@render children()}
  </div>
</div>
