<script lang="ts">
  const phase = "基础设施准备中";
</script>

<svelte:head>
  <meta name="theme-color" content="#090d16" />
</svelte:head>

<main class="bootstrap-desktop" data-product-contract="nocturne-glass-desktop">
  <div class="bootstrap-menu" aria-hidden="true">ImageWeave</div>
  <section class="bootstrap-window" aria-labelledby="bootstrap-title">
    <span class="bootstrap-kicker">TAURI · SVELTE</span>
    <h1 id="bootstrap-title">ImageWeave</h1>
    <p>{phase}</p>
  </section>
  <div class="bootstrap-dock" aria-hidden="true"></div>
</main>
