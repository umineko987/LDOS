<script lang="ts">
  import "../app.css";

  let { children } = $props();
</script>

<div data-app-ready>
  {@render children()}
</div>
