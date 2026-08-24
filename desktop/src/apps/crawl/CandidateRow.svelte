<script lang="ts">
  import type { CrawlCandidate } from "./model";
  import { thumbnail } from "./thumbnail";

  let {
    candidate,
    first,
    last,
    onSelected,
    onMove,
  }: {
    candidate: CrawlCandidate;
    first: boolean;
    last: boolean;
    onSelected: (selected: boolean) => void;
    onMove: (direction: -1 | 1) => void;
  } = $props();
</script>

<article
  class:selected={candidate.selected}
  class="crawl-candidate"
  data-crawl-candidate
  data-candidate-key={candidate.key}
>
  <label class="crawl-candidate__main">
    <input
      type="checkbox"
      checked={candidate.selected}
      aria-label={`选择 ${candidate.label}`}
      onchange={(event) => onSelected((event.currentTarget as HTMLInputElement).checked)}
    />
    {#if candidate.thumbnailUrl}
      <img
        class="crawl-candidate__thumbnail"
        alt={`${candidate.label} 封面`}
        src={candidate.thumbnailUrl}
        use:thumbnail={candidate.thumbnailUrl}
      />
    {/if}
    <span class="crawl-candidate__copy">
      <strong>{candidate.label}</strong>
      <span>{candidate.displayEndpoint}</span>
      <span class="crawl-candidate__badges">
        <small data-kind={candidate.weak ? "warning" : "ready"}>
          {candidate.weak ? "待核实" : candidate.confidence === "verified" ? "已核实" : "站内结果"}
        </small>
        {#if candidate.mediaCount}<small>媒体 {candidate.mediaCount}</small>{/if}
        {#if candidate.relatedProfileCount}<small>关联主页 {candidate.relatedProfileCount}</small>{/if}
        {#each candidate.evidence as evidence (evidence)}<small>{evidence}</small>{/each}
      </span>
    </span>
  </label>
  <span class="crawl-order-actions">
    <button
      type="button"
      aria-label={`将地址 ${candidate.label} 上移一位`}
      title={`将 ${candidate.label} 上移`}
      disabled={first}
      onclick={() => onMove(-1)}
    >上移</button>
    <button
      type="button"
      aria-label={`将地址 ${candidate.label} 下移一位`}
      title={`将 ${candidate.label} 下移`}
      disabled={last}
      onclick={() => onMove(1)}
    >下移</button>
  </span>
</article>
