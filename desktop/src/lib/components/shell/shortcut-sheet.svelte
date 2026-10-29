<script lang="ts">
  import * as Dialog from "#lib/components/ui/dialog/index.ts";
  import { Kbd, KbdGroup } from "#lib/components/ui/kbd/index.ts";
  import { keymapView } from "#lib/keys/bindings.svelte.ts";
  import { useKeymap } from "#lib/keys/context.ts";
  import { formatChord } from "#lib/keys/keymap.ts";
  import { m } from "#lib/paraglide/messages.js";

  // ?：快捷键表，按分组列出 global 和当前页面注册的所有带按键的绑定。
  let { open = $bindable(false) }: { open?: boolean } = $props();

  const keymap = useKeymap();
  const view = keymapView();
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="w-[min(640px,92vw)] p-6" data-testid="shortcut-sheet">
    <Dialog.Header>
      <Dialog.Title>{m.shell_shortcuts()}</Dialog.Title>
    </Dialog.Header>
    <div class="mt-4 columns-2 gap-7">
      {#each view.sections as section (section.title)}
        <section class="mb-4 break-inside-avoid">
          <h3 class="mb-1.5 text-xs font-medium text-fg2">{section.title}</h3>
          {#each section.items as item (item.id)}
            <div class="flex h-[26px] items-center justify-between gap-3 text-xs text-fg2" data-shortcut={item.id}>
              <span class="truncate">{item.label}</span>
              <span class="flex gap-1.5">
                {#each item.keys as chord (chord)}
                  <KbdGroup>{#each formatChord(chord, keymap.isMac) as part}<Kbd>{part}</Kbd>{/each}</KbdGroup>
                {/each}
              </span>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
