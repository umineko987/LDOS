<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";

  // /datasets/{id} 本身没有内容：进到采集段。
  $effect(() => {
    void goto(`#/datasets/${encodeURIComponent(page.params.id ?? "")}/collect`, { replaceState: true });
  });
</script>
