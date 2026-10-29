<script lang="ts">
  import DownloadIcon from "@lucide/svelte/icons/download";

  import { Button, type ButtonSize, type ButtonVariant } from "#lib/components/ui/button/index.ts";
  import { byKey, canInstall } from "#lib/domain/models.ts";
  import { m } from "#lib/paraglide/messages.js";

  import type { ModelInstaller } from "./installer.svelte.ts";

  // 安装这些 key 里还能装的模型。都装好、都在安装中或都未启用时按钮禁用；
  // 没有能装的、但有在装的，按钮显示「安装中…」。
  let {
    installer,
    keys,
    label,
    variant = "outline",
    size = "sm",
    class: className,
  }: {
    installer: ModelInstaller;
    keys: readonly string[];
    label?: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: string;
  } = $props();

  const pending = $derived.by(() => {
    const index = byKey(installer.items);
    return keys.filter((key) => {
      const item = index.get(key);
      return item !== undefined && canInstall(item);
    });
  });
  const installing = $derived(keys.some((key) => byKey(installer.items).get(key)?.status === "installing"));
</script>

<Button
  {variant}
  {size}
  class={className}
  disabled={!pending.length || installer.submitting}
  onclick={() => void installer.install(pending)}
  data-install={keys.join(",")}
>
  <DownloadIcon />
  {installing && !pending.length ? m.models_installing() : (label ?? m.models_install())}
</Button>
