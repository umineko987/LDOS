<script lang="ts">
  import type { Snippet } from "svelte";

  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Api } from "#lib/api/client.ts";
  import { setApi } from "#lib/api/context.ts";
  import { Toaster } from "#lib/components/ui/sonner/index.ts";
  import { createEventBus } from "#lib/events/bus.ts";
  import { setEvents } from "#lib/events/context.svelte.ts";
  import { useBindings, useEscape, useOverlay } from "#lib/keys/bindings.svelte.ts";
  import { parentPath } from "#lib/nav/routes.ts";
  import { m } from "#lib/paraglide/messages.js";

  import ActivityDrawer from "./activity-drawer.svelte";
  import CommandPalette from "./command-palette.svelte";
  import { navCommands, type NavLink } from "./nav.ts";
  import ShortcutSheet from "./shortcut-sheet.svelte";
  import { setShell, ShellState } from "./shell-state.svelte.ts";
  import Sidebar from "./sidebar.svelte";

  // 外壳：侧栏 + 页面 + 浮层。启动门就绪后才挂载，所以这里的 Api 一定可用。
  let { api, children }: { api: Api; children: Snippet } = $props();

  // 启动门每次重连都会给出新的 Api，根布局用 {#key} 重建外壳，这里只需在初始化时取一次。
  // svelte-ignore state_referenced_locally
  setApi(api);
  setEvents(createEventBus());
  const shell = setShell(new ShellState());

  function go(link: NavLink) {
    if (link.reload) window.location.assign(link.href);
    else void goto(link.href);
  }

  const general = m.keys_group_general;
  useBindings("global", () => [
    {
      id: "shell.palette",
      keys: "mod+k",
      label: m.keys_palette,
      group: general,
      run: () => {
        shell.paletteOpen = true;
      },
    },
    {
      id: "shell.activity",
      keys: "mod+j",
      label: m.keys_activity,
      group: general,
      run: () => {
        shell.activityOpen = !shell.activityOpen;
      },
    },
    {
      id: "shell.shortcuts",
      keys: "?",
      label: m.keys_sheet,
      group: general,
      run: () => {
        shell.shortcutsOpen = true;
      },
    },
    // Esc 走固定的链（见 keymap.ts），这一条只为在快捷键表里列出来。
    { id: "shell.escape", keys: "escape", label: m.keys_escape, group: general, run: () => false },
    ...navCommands(go),
  ]);

  useEscape("up", () => {
    const parent = parentPath(page.route.id, page.params);
    if (parent === null) return false;
    void goto(`#${parent}`);
    return true;
  });

  // 浮层打开时页面和全局按键暂停；Esc 由 bits-ui 关闭浮层，注册表只负责不让它漏到页面。
  useOverlay(() => shell.paletteOpen, {
    id: "palette",
    bindings: [
      {
        id: "palette.toggle",
        keys: "mod+k",
        label: m.keys_palette,
        group: general,
        run: () => {
          shell.paletteOpen = false;
        },
      },
    ],
  });
  useOverlay(() => shell.shortcutsOpen, { id: "shortcuts" });
  useOverlay(() => shell.activityOpen, {
    id: "activity",
    bindings: [
      {
        id: "activity.toggle",
        keys: "mod+j",
        label: m.keys_activity,
        group: general,
        run: () => {
          shell.activityOpen = false;
        },
      },
    ],
  });
</script>

<div class="grid h-screen grid-cols-[196px_minmax(0,1fr)]" data-shell>
  <Sidebar />
  <main class="flex min-h-0 min-w-0 flex-col bg-bg0">
    {@render children()}
  </main>
</div>

<CommandPalette bind:open={shell.paletteOpen} />
<ShortcutSheet bind:open={shell.shortcutsOpen} />
<ActivityDrawer bind:open={shell.activityOpen} />
<Toaster />
