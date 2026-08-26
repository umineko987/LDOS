<script lang="ts">
  import { onMount, tick } from "svelte";

  import {
    APPLICATION_DEFINITIONS,
    getApplicationDefinition,
    type ApplicationId,
  } from "../core/applications/definitions";
  import { isActivationKey, nextDirectionalIndex, restoreFocus } from "../core/a11y/focus";
  import { deriveWindowMenu } from "../core/state/projections";
  import type { ShellMenuId, ShellStore } from "../core/state/shell";
  import Icon from "./Icon.svelte";

  interface Props {
    shell: ShellStore;
    onOpenApplicationCenter: () => void;
    onNavigate: (appId: ApplicationId) => void;
    onWindowCommand: (command: "minimize" | "focus" | "restore", appId: ApplicationId) => void;
  }

  interface MenuCommand {
    id: string;
    label: string;
    description?: string;
    enabled: boolean;
    checked?: boolean;
    action: () => void;
  }

  const MENU_IDS = ["file", "edit", "view", "window", "help"] as const;
  const MENU_LABELS: Record<ShellMenuId, string> = {
    file: "文件",
    edit: "编辑",
    view: "显示",
    window: "窗口",
    help: "帮助",
  };

  let { shell, onOpenApplicationCenter, onNavigate, onWindowCommand }: Props = $props();
  let root = $state<HTMLElement>();
  let clock = $state("--:--");
  const snapshot = $derived($shell);
  const currentApplication = $derived(getApplicationDefinition(snapshot.focusedAppId));

  function closeMenu(returnFocus = false): void {
    const menuId = shell.getState().openMenu;
    if (menuId === null) return;
    shell.setOpenMenu(null);
    if (returnFocus) {
      queueMicrotask(() => restoreFocus(root?.querySelector<HTMLElement>(`[data-menu-trigger="${menuId}"]`)));
    }
  }

  async function openMenu(menuId: ShellMenuId, edge: "first" | "last" = "first"): Promise<void> {
    shell.setOpenMenu(menuId);
    await tick();
    const items = menuItems(menuId);
    restoreFocus(edge === "last" ? items.at(-1) : items[0]);
  }

  function menuItems(menuId: ShellMenuId): HTMLElement[] {
    return [...(root?.querySelectorAll<HTMLElement>(`[data-menu-panel="${menuId}"] [role^="menuitem"]:not([aria-disabled="true"])`) ?? [])];
  }

  function commandsFor(menuId: ShellMenuId): readonly MenuCommand[] {
    if (menuId === "file") return [{
      id: "application-center",
      label: "打开应用中心",
      description: "Ctrl/⌘ + O",
      enabled: true,
      action: () => {
        closeMenu(true);
        queueMicrotask(onOpenApplicationCenter);
      },
    }];
    if (menuId === "edit") return [
      { id: "undo", label: "撤销（由当前应用处理）", enabled: false, action: () => {} },
      { id: "redo", label: "重做（由当前应用处理）", enabled: false, action: () => {} },
    ];
    if (menuId === "view") return APPLICATION_DEFINITIONS
      .filter(({ group }) => group === "system")
      .toSorted((left, right) => left.order - right.order)
      .map((application) => ({
        id: `open:${application.id}`,
        label: `打开${application.title}`,
        enabled: true,
        action: () => { closeMenu(); onNavigate(application.id); },
      }));
    if (menuId === "window") return deriveWindowMenu(snapshot).map((item) => ({
      id: `window:${item.appId}`,
      label: item.title,
      description: item.description,
      enabled: true,
      checked: item.checked,
      action: () => { closeMenu(); onWindowCommand(item.command, item.appId); },
    }));
    return [{
      id: "about",
      label: "ImageWeave 夜航玻璃桌面",
      description: "P2 OS 壳层",
      enabled: false,
      action: () => {},
    }];
  }

  function onTriggerClick(menuId: ShellMenuId): void {
    if (snapshot.openMenu === menuId) closeMenu(true);
    else void openMenu(menuId);
  }

  function onTriggerKeydown(event: KeyboardEvent, menuId: ShellMenuId): void {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      void openMenu(menuId, event.key === "ArrowUp" ? "last" : "first");
      return;
    }
    const current = MENU_IDS.indexOf(menuId);
    const next = nextDirectionalIndex(current, MENU_IDS.length, event.key);
    if (next === null || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    restoreFocus(root?.querySelector<HTMLElement>(`[data-menu-trigger="${MENU_IDS[next]}"]`));
  }

  function onPanelKeydown(event: KeyboardEvent, menuId: ShellMenuId): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    const items = menuItems(menuId);
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = nextDirectionalIndex(current, items.length, event.key);
    if (next !== null) {
      event.preventDefault();
      restoreFocus(items[next]);
    } else if (isActivationKey(event.key) && document.activeElement instanceof HTMLButtonElement) {
      event.preventDefault();
      document.activeElement.click();
    }
  }

  function isShortcutTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest(
      "input, textarea, select, button, a[href], [contenteditable]:not([contenteditable='false'])",
    ));
  }

  onMount(() => {
    const formatter = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    let timer = 0;
    const updateClock = (): void => {
      clock = formatter.format(new Date());
      timer = window.setTimeout(updateClock, 60_000 - (Date.now() % 60_000) + 100);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (snapshot.openMenu !== null && event.target instanceof Node && !root?.contains(event.target)) closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || isShortcutTarget(event.target) || event.altKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        closeMenu();
        onOpenApplicationCenter();
      }
    };
    updateClock();
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  });
</script>

<header class="menu-bar" data-menu-bar aria-label="ImageWeave 菜单栏" bind:this={root}>
  <div class="menu-bar__identity">
    <strong>ImageWeave</strong>
    {#if currentApplication}
      <span class="menu-bar__current">{currentApplication.title}</span>
    {/if}
  </div>
  <nav class="menu-bar__menus" aria-label="应用菜单">
    {#each MENU_IDS as menuId}
      <div class="menu-bar__menu">
        <button
          type="button"
          class="menu-bar__trigger"
          data-menu-trigger={menuId}
          aria-haspopup="menu"
          aria-expanded={snapshot.openMenu === menuId}
          aria-controls="menu-panel-{menuId}"
          onclick={() => onTriggerClick(menuId)}
          onkeydown={(event) => onTriggerKeydown(event, menuId)}
        >{MENU_LABELS[menuId]}</button>
        {#if snapshot.openMenu === menuId}
          <div
            class="menu-popover"
            id="menu-panel-{menuId}"
            data-menu-panel={menuId}
            role="menu"
            tabindex="-1"
            onkeydown={(event) => onPanelKeydown(event, menuId)}
          >
            {#each commandsFor(menuId) as command (command.id)}
              <button
                type="button"
                class="menu-popover__item"
                role={command.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                aria-checked={command.checked === undefined ? undefined : command.checked}
                aria-disabled={!command.enabled}
                disabled={!command.enabled}
                onclick={command.action}
              >
                <span>{command.label}</span>
                {#if command.description}<small>{command.description}</small>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </nav>
  <div class="menu-bar__summary" role="group" aria-label="桌面状态">
    <span class="menu-bar__ready"><span aria-hidden="true">◆</span> 本地服务已连接</span>
    <span class="menu-bar__clock"><Icon name="clock" size={15} /> <time>{clock}</time></span>
  </div>
</header>
