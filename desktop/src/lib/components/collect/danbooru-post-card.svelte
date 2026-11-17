<script lang="ts">
  import ImageOffIcon from "@lucide/svelte/icons/image-off";

  import { useApi } from "#lib/api/context.ts";
  import { canCollectDanbooruPost, danbooruMediaUrl, type DanbooruPost } from "#lib/api/queries/danbooru.ts";
  import { Badge } from "#lib/components/ui/badge/index.ts";
  import { Checkbox } from "#lib/components/ui/checkbox/index.ts";
  import { m } from "#lib/paraglide/messages.js";
  import { cn } from "#lib/utils.ts";

  let { post, selected, disabled = false, active = false, ontoggle, ondetails }: {
    post: DanbooruPost;
    selected: boolean;
    disabled?: boolean;
    active?: boolean;
    ontoggle: (post: DanbooruPost) => void;
    ondetails: (post: DanbooruPost, trigger: HTMLButtonElement) => void;
  } = $props();
  const api = useApi();
  const uid = $props.id();
  const preview = $derived(danbooruMediaUrl(api, post.preview_url) || danbooruMediaUrl(api, post.sample_url));
  const title = $derived(post.title || m.danbooru_post({ id: post.id }));
  const selectable = $derived(canCollectDanbooruPost(post));
  let failedUrl = $state("");
  const failed = $derived(Boolean(preview) && failedUrl === preview);
</script>

<article class={cn("flex min-w-0 flex-col overflow-hidden rounded-md border border-line bg-bg1", selected && "border-ring", active && "ring-1 ring-ring")}>
  <button type="button" class="relative flex aspect-square w-full items-center justify-center bg-bg2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    aria-label={m.danbooru_open_details({ title })} aria-expanded={active} onclick={(event) => ondetails(post, event.currentTarget)}>
    {#if preview && !failed}
      <img src={preview} alt={title} crossorigin="anonymous" loading="lazy" class="size-full object-contain" onerror={(event) => (failedUrl = (event.currentTarget as HTMLImageElement).src)} />
    {:else}
      <span class="flex flex-col items-center gap-2 px-3 text-xs text-fg3">
        <ImageOffIcon class="size-5" aria-hidden="true" />
        {failed ? m.danbooru_preview_failed() : m.danbooru_no_preview()}
      </span>
    {/if}
  </button>
  <div class="flex flex-col gap-1.5 p-2">
    <label for={uid} class={cn("flex min-w-0 items-start gap-2 text-xs", selectable ? "cursor-pointer" : "text-fg3")}>
      <Checkbox id={uid} checked={selected} disabled={disabled || !selectable} onCheckedChange={() => ontoggle(post)} />
      <span class="min-w-0 truncate" title={title}>{title}</span>
    </label>
    <p class="text-2xs text-fg3 tabular-nums">{post.width}×{post.height} · {post.file_ext.toUpperCase()} · {post.rating.toUpperCase()}</p>
    {#if post.in_dataset}
      <Badge variant="secondary">{m.danbooru_in_dataset()}</Badge>
    {:else if post.local_asset_id}
      <Badge variant="ok">{m.danbooru_in_library()}</Badge>
    {:else if !selectable}
      <Badge variant="warn">{m.danbooru_unavailable()}</Badge>
    {/if}
    {#if !selectable && !post.in_dataset}
      <p class="break-words text-2xs text-fg3">{post.unavailable_reason || m.danbooru_not_collectable()}</p>
    {/if}
  </div>
</article>
