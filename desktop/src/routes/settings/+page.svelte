<script lang="ts">
  import { onMount } from "svelte";

  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";

  // hash 路由不能在 load 里重定向；#/settings 直接换成第一个分区。
  onMount(() => {
    void goto(resolve("/settings/network"), { replace: true });
  });
</script>
