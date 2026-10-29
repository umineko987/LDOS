<!--
  虚拟网格：按行虚拟化（@tanstack/virtual-core），同时存在的 DOM 格子不超过 MAX_GRID_CELLS（300）。

  用法：

    <script lang="ts">
      import { GridSelection, ThumbCell, VirtualGrid } from "#lib/components/grid/index.ts";
      const selection = new GridSelection();
      let focus = $state(-1);
    </script>

    <VirtualGrid
      items={members}
      key={(member) => member.id}
      label="成员"
      itemLabel={(member) => member.name}
      {selection}
      bind:focus
      thumbSize={128}
      hasMore={query.hasNextPage}
      loading={query.isFetchingNextPage}
      onendreached={() => query.fetchNextPage()}
      onpreview={(member, index) => openViewer(index)}
    >
      {#snippet cell({ item })}
        <ThumbCell src={thumb(item)} alt={item.name} dimmed={excluded(item)} />
      {/snippet}
      {#snippet empty()}还没有图片{/snippet}
    </VirtualGrid>

  属性：
  - `items` / `key`：数据和稳定键（选择按键记）。`itemLabel`：每格的无障碍名称。
  - `cell`：格子内容，参数 `{ item, index, selected, focused, width, height }`；格子外框、选中底色和焦点环由网格画。
  - `selection`：GridSelection（selection.svelte.ts），由页面创建并读取；不给就用内部的一个。
  - `focus`（可绑定）：焦点格的下标，-1 表示还没有焦点。
  - `thumbSize`：格子最小宽度（默认 112），`aspect`：高/宽（默认 4/3），`gap`（6）、`padding`（左右 28、上下 14）。
  - `hasMore` / `loading` / `onendreached`：滚到离底部两行以内时请求下一页。
  - `onopen(item, index)`：Enter 或双击；没给时退回 `onpreview`。`onpreview(item, index)`：Space。
  - `keyboard`（默认 true）：是否注册页面按键；同一页有两个网格时只给一个开。
  - `empty`：没有条目时显示的内容。

  按键（页面层，输入框里不响应）：←/→/↑/↓ 和 H/L/K/J 移动焦点，Shift+方向键扩展选择，
  Home/End、PageUp/PageDown，Space 预览，Enter 打开，Ctrl/⌘+A 全选，Esc（选择这一步）清空选择。
  鼠标：单击选中、Shift 范围、Ctrl/⌘ 切换，双击打开。
-->
<script lang="ts" generics="T">
  import {
    elementScroll,
    observeElementOffset,
    observeElementRect,
    Virtualizer,
    type VirtualItem,
  } from "@tanstack/virtual-core";
  import { onMount, untrack, type Snippet } from "svelte";

  import { useBindings, useEscape } from "#lib/keys/bindings.svelte.ts";
  import type { KeyboardEventLike } from "#lib/keys/keymap.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  import {
    gridLayout,
    moveFocus,
    overscanRows,
    rowCount,
    type GridCellContext,
    type GridMove,
  } from "./grid-model.ts";
  import { GridSelection } from "./selection.svelte.ts";

  let {
    items,
    key,
    cell,
    label,
    itemLabel,
    selection = new GridSelection(),
    focus = $bindable(-1),
    thumbSize = 112,
    aspect = 4 / 3,
    gap = 6,
    padding = 28,
    paddingY = 14,
    hasMore = false,
    loading = false,
    onendreached,
    onopen,
    onpreview,
    keyboard = true,
    empty,
    class: className,
  }: {
    items: readonly T[];
    key: (item: T) => string;
    cell: Snippet<[GridCellContext<T>]>;
    label: string;
    itemLabel?: (item: T) => string;
    selection?: GridSelection;
    focus?: number;
    thumbSize?: number;
    aspect?: number;
    gap?: number;
    padding?: number;
    paddingY?: number;
    hasMore?: boolean;
    loading?: boolean;
    onendreached?: () => void;
    onopen?: (item: T, index: number) => void;
    onpreview?: (item: T, index: number) => void;
    keyboard?: boolean;
    empty?: Snippet;
    class?: string;
  } = $props();

  const uid = $props.id();
  const cellId = (index: number) => `${uid}-cell-${index}`;

  let scroller = $state<HTMLDivElement | null>(null);
  let width = $state(0);
  let height = $state(0);

  const layout = $derived(gridLayout(width, { minCellWidth: thumbSize, gap, aspect, padding }));
  const order = $derived(items.map(key));
  const rows = $derived(rowCount(items.length, layout.columns));
  const overscan = $derived(overscanRows(height, layout.rowHeight, layout.columns));
  const pageRows = $derived(Math.max(1, Math.floor(height / Math.max(1, layout.rowHeight)) - 1));

  let virtualRows = $state.raw<VirtualItem[]>([]);
  let totalSize = $state(0);

  function sync() {
    virtualRows = virtualizer.getVirtualItems();
    totalSize = virtualizer.getTotalSize();
  }

  const virtualizer = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => scroller,
    estimateSize: () => layout.rowHeight,
    scrollToFn: elementScroll,
    observeElementRect,
    observeElementOffset,
    onChange: () => sync(),
  });

  onMount(() => virtualizer._didMount());

  $effect(() => {
    const options = {
      ...virtualizer.options,
      count: rows,
      overscan,
      paddingStart: paddingY,
      paddingEnd: paddingY,
      estimateSize: () => layout.rowHeight,
      getItemKey: (index: number) => index,
    };
    void scroller;
    void layout.rowHeight;
    untrack(() => {
      virtualizer.setOptions(options);
      virtualizer._willUpdate();
      // 行高随宽度变：丢掉按旧行高算的位置。
      virtualizer.measure();
      sync();
    });
  });

  interface PlacedCell {
    readonly index: number;
    readonly item: T;
    readonly id: string;
    readonly x: number;
    readonly y: number;
  }

  const cells = $derived.by(() => {
    const placed: PlacedCell[] = [];
    const { columns, cellWidth } = layout;
    for (const row of virtualRows) {
      const first = row.index * columns;
      const last = Math.min(items.length, first + columns);
      for (let index = first; index < last; index++) {
        const item = items[index]!;
        placed.push({ index, item, id: order[index]!, x: padding + (index - first) * (cellWidth + gap), y: row.start });
      }
    }
    return placed;
  });

  // 列表变了：去掉不在里面的选择，焦点夹回范围内。
  $effect(() => {
    const current = order;
    untrack(() => {
      selection.retain(current);
      if (focus >= current.length) focus = current.length - 1;
    });
  });

  // 滚到底部附近时要下一页。
  $effect(() => {
    const lastRow = virtualRows.at(-1)?.index ?? -1;
    if (!hasMore || loading || rows === 0 || lastRow < rows - 3) return;
    untrack(() => onendreached?.());
  });

  function reveal(index: number) {
    if (index < 0) return;
    virtualizer.scrollToIndex(Math.floor(index / layout.columns), { align: "auto" });
  }

  function move(direction: GridMove, extend = false) {
    const next = moveFocus(focus, direction, layout.columns, items.length, pageRows);
    if (next < 0) return;
    if (extend) selection.extend(order, focus < 0 ? next : focus, next);
    focus = next;
    reveal(next);
  }

  const ARROWS: Readonly<Record<string, GridMove>> = {
    arrowleft: "left",
    arrowright: "right",
    arrowup: "up",
    arrowdown: "down",
    h: "left",
    l: "right",
    k: "up",
    j: "down",
    home: "home",
    end: "end",
    pageup: "pageup",
    pagedown: "pagedown",
  };

  const direction = (event?: KeyboardEventLike) => (event ? ARROWS[event.key.toLowerCase()] : undefined);

  const CONTROLS = "button, a[href], select, summary, [role=button], [role=menuitem], [role=checkbox], [role=switch], [role=tab]";

  /** Space / Enter 落在网格外的按钮、链接上时让它们自己处理。 */
  function controlTarget(event?: KeyboardEventLike) {
    const target = event?.target;
    return target instanceof Element && !scroller?.contains(target) && target.closest(CONTROLS) !== null;
  }

  function activate(open: boolean, event?: KeyboardEventLike) {
    if (controlTarget(event)) return false;
    const item = items[focus];
    if (item === undefined) return false;
    const handler = open ? (onopen ?? onpreview) : onpreview;
    if (!handler) return false;
    handler(item, focus);
    return true;
  }

  const group = m.keys_group_grid;
  const hasItems = () => items.length > 0;

  useBindings("page", () =>
    keyboard
      ? [
          {
            id: "grid.move",
            keys: ["arrowleft", "arrowright", "arrowup", "arrowdown", "h", "l", "k", "j"],
            label: m.grid_key_move,
            group,
            when: hasItems,
            run: (event) => {
              const next = direction(event);
              if (!next) return false;
              move(next);
            },
          },
          {
            id: "grid.extend",
            keys: ["shift+arrowleft", "shift+arrowright", "shift+arrowup", "shift+arrowdown"],
            label: m.grid_key_extend,
            group,
            when: hasItems,
            run: (event) => {
              const next = direction(event);
              if (!next) return false;
              move(next, true);
            },
          },
          {
            id: "grid.jump",
            keys: ["home", "end", "pageup", "pagedown"],
            label: m.grid_key_jump,
            group,
            when: hasItems,
            run: (event) => {
              const next = direction(event);
              if (!next) return false;
              move(next);
            },
          },
          {
            id: "grid.preview",
            keys: "space",
            label: m.grid_key_preview,
            group,
            when: () => hasItems() && onpreview !== undefined,
            run: (event) => activate(false, event),
          },
          {
            id: "grid.open",
            keys: "enter",
            label: m.grid_key_open,
            group,
            when: () => hasItems() && (onopen ?? onpreview) !== undefined,
            run: (event) => activate(true, event),
          },
          {
            id: "grid.select-all",
            keys: "mod+a",
            label: m.grid_key_select_all,
            group,
            inInput: false,
            when: hasItems,
            run: () => selection.selectAll(order),
          },
        ]
      : [],
  );

  useEscape("selection", () => keyboard && selection.clear());

  function click(event: MouseEvent, index: number, id: string) {
    selection.click(order, id, { range: event.shiftKey, toggle: event.ctrlKey || event.metaKey });
    focus = index;
  }

  function open(index: number) {
    const item = items[index];
    if (item === undefined) return;
    focus = index;
    (onopen ?? onpreview)?.(item, index);
  }
</script>

<div
  bind:this={scroller}
  bind:clientWidth={width}
  bind:clientHeight={height}
  role="listbox"
  tabindex="0"
  aria-label={label}
  aria-multiselectable="true"
  aria-activedescendant={focus >= 0 && focus < items.length ? cellId(focus) : undefined}
  aria-busy={loading || undefined}
  data-testid="virtual-grid"
  data-columns={layout.columns}
  class={cn("relative min-h-0 flex-1 overflow-y-auto outline-none", className)}
>
  {#if items.length === 0}
    {#if empty}
      <div class="flex h-full items-center justify-center px-7 text-sm text-fg3">{@render empty()}</div>
    {/if}
  {:else}
    <div class="relative w-full" style:height="{totalSize}px">
      {#each cells as placed (placed.id)}
        {@const selected = selection.has(placed.id)}
        {@const focused = focus === placed.index}
        <!-- 按键由外层 listbox 统一处理（aria-activedescendant 指向焦点格）。 -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          id={cellId(placed.index)}
          role="option"
          tabindex="-1"
          aria-selected={selected}
          aria-setsize={items.length}
          aria-posinset={placed.index + 1}
          aria-label={itemLabel?.(placed.item)}
          data-index={placed.index}
          data-selected={selected || undefined}
          data-focused={focused || undefined}
          class={cn(
            "absolute top-0 left-0 overflow-hidden rounded-md border select-none",
            selected ? "border-(--gold-30) bg-gold-12" : "border-transparent bg-bg1",
            focused && "outline-[1.5px] outline-offset-1 outline-gold outline-solid",
          )}
          style:width="{layout.cellWidth}px"
          style:height="{layout.cellHeight}px"
          style:transform="translate({placed.x}px, {placed.y}px)"
          onclick={(event) => click(event, placed.index, placed.id)}
          ondblclick={() => open(placed.index)}
        >
          {@render cell({
            item: placed.item,
            index: placed.index,
            selected,
            focused,
            width: layout.cellWidth,
            height: layout.cellHeight,
          })}
        </div>
      {/each}
    </div>
  {/if}
</div>
