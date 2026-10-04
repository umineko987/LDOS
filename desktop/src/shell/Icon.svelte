<script lang="ts">
  import type { ApplicationIcon } from "../core/applications/definitions";

  interface Props {
    name: ApplicationIcon | "grid" | "clock" | "chevron-left" | "chevron-right";
    size?: number;
    strokeWidth?: number;
    label?: string | null;
  }

  let { name, size = 24, strokeWidth = 1.7, label = null }: Props = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="square"
  stroke-linejoin="miter"
  role={label ? "img" : undefined}
  aria-label={label ?? undefined}
  aria-hidden={label ? undefined : "true"}
>
  {#if name === "download"}
    <path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>
  {:else if name === "list"}
    <path d="M8 6h13M8 12h13M8 18h13M3 6l.5.5L5 5M3 12l.5.5L5 11M3 18l.5.5L5 17"/>
  {:else if name === "network"}
    <rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-2h14v2"/>
  {:else if name === "key"}
    <circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M18 5l2 2M15 8l2 2"/>
  {:else if name === "images"}
    <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>
  {:else if name === "sliders"}
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>
  {:else if name === "activity"}
    <path d="M3 12h4l2-7 4 14 2-7h6"/>
  {:else if name === "folder"}
    <path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM7 16l3-3 2 2 3-4 3 5"/>
  {:else if name === "grid"}
    <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
  {:else if name === "chevron-left"}
    <path d="m14 6-6 6 6 6"/>
  {:else if name === "chevron-right"}
    <path d="m10 6 6 6-6 6"/>
  {:else}
    <circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>
  {/if}
</svg>
