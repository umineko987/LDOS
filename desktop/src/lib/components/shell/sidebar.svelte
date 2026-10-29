<script lang="ts">
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import CommandIcon from "@lucide/svelte/icons/command";

  import { page } from "$app/state";
  import { Kbd, KbdGroup } from "#lib/components/ui/kbd/index.ts";
  import { useJobs } from "#lib/events/jobs.svelte.ts";
  import { useKeymap } from "#lib/keys/context.ts";
  import { formatChord } from "#lib/keys/keymap.ts";
  import { sectionOf } from "#lib/nav/routes.ts";
  import { m } from "#lib/paraglide/messages.js";

  import LocaleSwitch from "./locale-switch.svelte";
  import NavDot from "./nav-dot.svelte";
  import NavItem from "./nav-item.svelte";
  import { primaryNav, systemNav } from "./nav.ts";
  import { useShell } from "./shell-state.svelte.ts";

  const shell = useShell();
  const keymap = useKeymap();
  const jobs = useJobs();
  const section = $derived(sectionOf(page.route.id));
  const primary = primaryNav();
  const system = systemNav();
  const running = $derived(jobs.active.length);
</script>

<!-- 进行中任务数：灰色小角标（金色只给导航点、焦点环和主操作）。 -->
{#snippet runningBadge()}
  {#if running}
    <span class="ml-auto flex-none rounded-full bg-bg3 px-1.5 text-2xs text-fg2 tabular-nums" data-testid="running-count">
      <span aria-hidden="true">{running}</span>
      <span class="sr-only">{m.activity_running_badge({ count: running })}</span>
    </span>
  {/if}
{/snippet}

<aside class="flex min-h-0 flex-col border-r border-line bg-bg1 pt-3.5 pb-2.5" data-testid="sidebar">
  <div class="flex items-baseline gap-2 px-[18px] pb-4">
    <b class="text-base tracking-[0.08em]">{m.app_name()}</b>
    <span class="text-2xs text-fg3">{m.app_tagline()}</span>
  </div>

  <nav aria-label={m.nav_main()} class="relative flex flex-col px-2">
    {#each primary as link (link.id)}
      <NavItem
        href={link.href}
        active={section === link.section}
        data-nav={link.id}
        trailing={link.id === "jobs" ? runningBadge : undefined}>{link.label()}</NavItem
      >
    {/each}
    <div class="mt-3.5 px-2.5 pb-1 text-2xs tracking-[0.04em] text-fg3">{m.nav_group_system()}</div>
    {#each system as link (link.id)}
      <NavItem
        href={link.href}
        active={link.section !== undefined && section === link.section}
        data-nav={link.id}
        data-sveltekit-reload={link.reload || undefined}
      >
        {link.label()}
      </NavItem>
    {/each}
    <NavDot active={section} />
  </nav>

  <div class="mt-auto flex flex-col gap-0.5 px-2 pt-2">
    <button
      type="button"
      class="flex h-[30px] items-center gap-2 rounded-[5px] px-2.5 text-fg2 transition-colors duration-(--t-color) hover:text-fg"
      aria-expanded={shell.activityOpen}
      onclick={() => (shell.activityOpen = !shell.activityOpen)}
    >
      <ActivityIcon class="size-3.5" />
      <span>{m.shell_activity()}</span>
      {@render runningBadge()}
      <KbdGroup class={running ? "" : "ml-auto"}>{#each formatChord("mod+j", keymap.isMac) as part}<Kbd>{part}</Kbd>{/each}</KbdGroup>
    </button>
    <button
      type="button"
      class="flex h-[30px] items-center gap-2 rounded-[5px] px-2.5 text-fg2 transition-colors duration-(--t-color) hover:text-fg"
      aria-expanded={shell.paletteOpen}
      onclick={() => (shell.paletteOpen = true)}
    >
      <CommandIcon class="size-3.5" />
      <span>{m.shell_commands()}</span>
      <KbdGroup class="ml-auto">{#each formatChord("mod+k", keymap.isMac) as part}<Kbd>{part}</Kbd>{/each}</KbdGroup>
    </button>
    <div class="px-2.5 pt-1.5">
      <LocaleSwitch />
    </div>
  </div>
</aside>
