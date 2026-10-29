<script lang="ts">
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { toast } from "svelte-sonner";

  import { useApi } from "#lib/api/context.ts";
  import { apiErrorMessage } from "#lib/api/messages.ts";
  import {
    downloadSettingsQuery,
    modelKeys,
    updateDownloadSettings,
    type DownloadSettings,
    type DownloadSettingsUpdate,
  } from "#lib/api/queries/models.ts";
  import Segmented from "#lib/components/segmented.svelte";
  import { Button } from "#lib/components/ui/button/index.ts";
  import { Input } from "#lib/components/ui/input/index.ts";
  import {
    draftChanges,
    HF_MIRROR_PRESET,
    toDraft,
    validateDraft,
    type DownloadDraft,
    type DownloadProxyMode,
    type DraftError,
    type MirrorChoice,
  } from "#lib/domain/downloads.ts";
  import { m } from "#lib/paraglide/messages.js";

  // 下载设置：HF 镜像、下载代理（表单一起保存），HF token（只写，单独保存/清除）。
  const api = useApi();
  const queryClient = useQueryClient();
  const settings = createQuery(() => downloadSettingsQuery(api));

  // raw：$state 会把对象包成代理，和 settings.data 比较时就永远不相等了。
  let base = $state.raw<DownloadSettings | null>(null);
  let draft = $state<DownloadDraft>({ mirror: "official", mirrorUrl: "", proxyMode: "none", customProxy: "" });
  let touched = $state(false);

  // 服务端的值变了（首次加载、保存成功、重连后重拉）就重置草稿。
  $effect(() => {
    const view = settings.data;
    if (view && view !== base) {
      base = view;
      draft = toDraft(view);
      touched = false;
    }
  });

  const ERRORS: Record<DraftError, () => string> = {
    mirror_required: m.downloads_error_mirror_required,
    mirror_invalid: m.downloads_error_mirror_invalid,
    proxy_required: m.downloads_error_proxy_required,
    proxy_invalid: m.downloads_error_proxy_invalid,
  };

  const error = $derived(base ? validateDraft(draft, base) : null);
  const changes = $derived(base ? draftChanges(base, draft) : null);

  const mirrorOptions = $derived<{ value: MirrorChoice; label: string }[]>([
    { value: "official", label: m.downloads_mirror_official() },
    { value: "preset", label: new URL(HF_MIRROR_PRESET).host },
    { value: "custom", label: m.downloads_mirror_custom() },
  ]);
  const proxyOptions = $derived<{ value: DownloadProxyMode; label: string }[]>([
    { value: "none", label: m.downloads_proxy_none() },
    { value: "pool", label: m.downloads_proxy_pool() },
    { value: "custom", label: m.downloads_proxy_custom() },
  ]);

  function stored(view: DownloadSettings) {
    queryClient.setQueryData(modelKeys.downloads(), view);
  }

  // 后端拒绝的原因显示在保存按钮旁边，草稿保留，改完再存。
  let saveError = $state<string | null>(null);
  const save = createMutation(() => ({
    mutationFn: (body: DownloadSettingsUpdate) => updateDownloadSettings(api, body),
    onMutate: () => {
      saveError = null;
    },
    onSuccess: (view) => {
      stored(view);
      toast.success(m.downloads_saved());
    },
    onError: (failure) => {
      saveError = apiErrorMessage(failure);
    },
  }));

  function submit(event: SubmitEvent) {
    event.preventDefault();
    touched = true;
    if (error || !changes) return;
    save.mutate(changes);
  }

  // token 不走 createMutation：mutation 缓存会留着请求体（也就是 token）直到回收。
  // 结果直接体现在上面的「已保存 …abcd / 未设置」里，不另弹提示。
  let token = $state("");
  let tokenBusy = $state(false);
  let tokenError = $state<string | null>(null);

  async function writeToken(body: { hf_token: string } | { clear_hf_token: true }) {
    tokenBusy = true;
    tokenError = null;
    try {
      stored(await updateDownloadSettings(api, body));
      token = "";
    } catch (failure) {
      tokenError = apiErrorMessage(failure);
    } finally {
      tokenBusy = false;
    }
  }

  function submitToken(event: SubmitEvent) {
    event.preventDefault();
    const value = token.trim();
    if (value) void writeToken({ hf_token: value });
  }
</script>

<section aria-labelledby="downloads-title" class="flex flex-col gap-2" data-testid="downloads">
  <div class="flex flex-col">
    <h2 id="downloads-title" class="text-sm font-semibold">{m.downloads_title()}</h2>
    <p class="text-xs text-fg3">{m.downloads_hint()}</p>
  </div>

  {#if settings.error}
    <p class="text-sm text-danger" role="alert">{m.downloads_load_failed({ reason: apiErrorMessage(settings.error) })}</p>
  {:else if base}
    <form class="grid grid-cols-[180px_minmax(0,1fr)] gap-x-4 border-t border-line" onsubmit={submit} novalidate>
      <div class="flex min-h-row items-center border-b border-line py-2.5 text-sm text-fg2" id="downloads-mirror">{m.downloads_mirror()}</div>
      <div class="flex min-h-row flex-col justify-center gap-1.5 border-b border-line py-2.5">
        <Segmented
          size="sm"
          label={m.downloads_mirror()}
          data-download="mirror"
          value={draft.mirror}
          options={mirrorOptions}
          onchange={(mirror) => (draft = { ...draft, mirror })}
          class="self-start"
        />
        {#if draft.mirror === "custom"}
          <Input
            aria-labelledby="downloads-mirror"
            data-download="mirror-url"
            class="max-w-[420px]"
            placeholder="https://mirror.example.com"
            autocomplete="off"
            spellcheck={false}
            value={draft.mirrorUrl}
            oninput={(event) => (draft = { ...draft, mirrorUrl: event.currentTarget.value })}
            aria-invalid={touched && (error === "mirror_required" || error === "mirror_invalid")}
          />
        {/if}
      </div>

      <div class="flex min-h-row items-center border-b border-line py-2.5 text-sm text-fg2" id="downloads-proxy">{m.downloads_proxy()}</div>
      <div class="flex min-h-row flex-col justify-center gap-1.5 border-b border-line py-2.5">
        <Segmented
          size="sm"
          label={m.downloads_proxy()}
          data-download="proxy"
          value={draft.proxyMode}
          options={proxyOptions}
          onchange={(proxyMode) => (draft = { ...draft, proxyMode })}
          class="self-start"
        />
        {#if draft.proxyMode === "pool"}
          <p class="text-2xs text-fg3">{m.downloads_proxy_pool_hint()}</p>
        {:else if draft.proxyMode === "custom"}
          <Input
            aria-labelledby="downloads-proxy"
            data-download="proxy-url"
            class="max-w-[420px]"
            placeholder={base.custom_proxy ? m.downloads_proxy_keep() : "http://127.0.0.1:7890"}
            autocomplete="off"
            spellcheck={false}
            value={draft.customProxy}
            oninput={(event) => (draft = { ...draft, customProxy: event.currentTarget.value })}
            aria-invalid={touched && (error === "proxy_required" || error === "proxy_invalid")}
          />
          {#if base.custom_proxy}
            <p class="text-2xs text-fg3" data-testid="downloads-proxy-saved">
              {m.downloads_proxy_saved({ proxy: base.custom_proxy })}
            </p>
          {/if}
        {/if}
      </div>

      <div></div>
      <div class="flex min-h-row items-center gap-3 py-2.5">
        <Button type="submit" size="sm" disabled={!changes || save.isPending} data-testid="downloads-save">{m.downloads_save()}</Button>
        {#if touched && error}
          <p class="text-xs text-danger" role="alert">{ERRORS[error]()}</p>
        {:else if saveError}
          <p class="text-xs text-danger" role="alert">{m.downloads_save_failed({ reason: saveError })}</p>
        {/if}
      </div>
    </form>

    <form class="grid grid-cols-[180px_minmax(0,1fr)] gap-x-4 border-t border-line" onsubmit={submitToken} data-testid="downloads-token">
      <label for="downloads-token-input" class="flex min-h-row items-center border-b border-line py-2.5 text-sm text-fg2">
        {m.downloads_token()}
      </label>
      <div class="flex min-h-row flex-col justify-center gap-1.5 border-b border-line py-2.5">
        <p class="text-xs text-fg2" aria-live="polite" data-testid="downloads-token-state" data-token-set={base.token_set}>
          {base.token_set ? m.downloads_token_set({ hint: base.token_hint ?? "" }) : m.downloads_token_unset()}
        </p>
        <div class="flex max-w-[560px] items-center gap-2">
          <Input
            id="downloads-token-input"
            type="password"
            autocomplete="off"
            spellcheck={false}
            placeholder={m.downloads_token_placeholder()}
            bind:value={token}
            disabled={tokenBusy}
            class="flex-1"
          />
          <Button type="submit" size="sm" disabled={!token.trim() || tokenBusy} data-testid="downloads-token-save">
            {m.downloads_token_save()}
          </Button>
          {#if base.token_set}
            <Button
              variant="destructive"
              size="sm"
              disabled={tokenBusy}
              onclick={() => void writeToken({ clear_hf_token: true })}
              data-testid="downloads-token-clear"
            >
              {m.downloads_token_clear()}
            </Button>
          {/if}
        </div>
        {#if tokenError}
          <p class="text-xs text-danger" role="alert">{m.downloads_save_failed({ reason: tokenError })}</p>
        {/if}
        <p class="text-2xs text-fg3">{m.downloads_token_hint()}</p>
      </div>
    </form>
  {/if}
</section>
