<script lang="ts">
  import * as Command from "#lib/components/ui/command/index.ts";
  import { Kbd, KbdGroup } from "#lib/components/ui/kbd/index.ts";
  import { keymapView } from "#lib/keys/bindings.svelte.ts";
  import { useKeymap } from "#lib/keys/context.ts";
  import { formatChord, normalizeChord, type KeyBinding } from "#lib/keys/keymap.ts";
  import { m } from "#lib/paraglide/messages.js";

  // Ctrl+K：条目全部来自注册表里 `palette: true` 的绑定（global 和当前页面）。
  let { open = $bindable(false) }: { open?: boolean } = $props();

  const keymap = useKeymap();
  const view = keymapView();
  let search = $state("");

  const groups = $derived.by(() => {
    const byTitle = new Map<string, KeyBinding[]>();
    for (const command of view.commands) {
      const title = command.group();
      byTitle.set(title, [...(byTitle.get(title) ?? []), command]);
    }
    return [...byTitle].map(([title, commands]) => ({ title, commands }));
  });

  function keysOf(command: KeyBinding): string[] {
    const keys = command.keys === undefined ? [] : typeof command.keys === "string" ? [command.keys] : command.keys;
    return keys.length ? formatChord(normalizeChord(keys[0]!), keymap.isMac) : [];
  }

  function select(command: KeyBinding) {
    open = false;
    search = "";
    command.run();
  }
</script>

<Command.Dialog
  bind:open
  title={m.palette_title()}
  description={m.palette_placeholder()}
  data-testid="command-palette"
  vimBindings={false}
  onOpenChange={(next) => {
    if (!next) search = "";
  }}
>
  <Command.Input placeholder={m.palette_placeholder()} bind:value={search} />
  <Command.List class="max-h-[380px] p-1.5">
    <Command.Empty class="py-6 text-center text-xs text-fg3">{m.palette_empty()}</Command.Empty>
    {#each groups as group (group.title)}
      <Command.Group heading={group.title}>
        {#each group.commands as command (command.id)}
          {@const label = command.label()}
          <Command.Item
            value={command.id}
            keywords={[label, ...(command.keywords ?? [])]}
            data-command-id={command.id}
            onSelect={() => select(command)}
          >
            <span class="truncate">{label}</span>
            {#if keysOf(command).length}
              <KbdGroup class="ml-auto">{#each keysOf(command) as part}<Kbd>{part}</Kbd>{/each}</KbdGroup>
            {/if}
          </Command.Item>
        {/each}
      </Command.Group>
    {/each}
  </Command.List>
  <div class="flex gap-3.5 border-t border-line px-3.5 py-2 text-2xs text-fg3">
    <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> {m.palette_foot_move()}</span>
    <span><Kbd>Enter</Kbd> {m.palette_foot_open()}</span>
    <span><Kbd>Esc</Kbd> {m.palette_foot_close()}</span>
  </div>
</Command.Dialog>
