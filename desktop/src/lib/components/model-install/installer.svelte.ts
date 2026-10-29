// 模型安装的共用控制器：模型表查询、安装请求、许可确认、job.updated 进度。
// 设置 › 模型、ModelGate 和命令面板动作都用它，所以安装逻辑只有这一份。

import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
import { toast } from "svelte-sonner";

import { useApi } from "#lib/api/context.ts";
import { isApiError } from "#lib/api/errors.ts";
import { apiErrorMessage } from "#lib/api/messages.ts";
import {
  installModels,
  modelKeys,
  modelsQuery,
  type ModelInstallBody,
  type ModelList,
} from "#lib/api/queries/models.ts";
import { anyInstalling, canInstall, installSet, licenseItems, mergeJob, type ModelItem } from "#lib/domain/models.ts";
import { useEvent } from "#lib/events/context.svelte.ts";
import { m } from "#lib/paraglide/messages.js";

/** 进度主要靠 SSE；安装中再每 5 秒重拉一次，兜住断线和漏掉的事件。 */
export const INSTALL_FALLBACK_POLL_MS = 5_000;

export interface LicenseRequest {
  /** 同意后要安装的 key（用户请求的那些，不含同包展开）。 */
  readonly keys: readonly string[];
  readonly items: readonly ModelItem[];
}

export interface ModelInstaller {
  /** 模型表；还没加载或 `load: false` 且没人加载过时是空数组。 */
  readonly items: readonly ModelItem[];
  /** 模型表已经拿到过（可能为空表）。 */
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly error: unknown;
  /** 安装请求在途。 */
  readonly submitting: boolean;
  /** 不为 null 时界面应显示许可对话框（LicenseDialog）。 */
  readonly license: LicenseRequest | null;
  /** 安装这些 key；涉及受限模型时先弹许可确认。返回是否真的发出了请求。 */
  install(keys: readonly string[]): Promise<boolean>;
  /** 安装所有能装的（缺失、失败、待同意许可）。 */
  installMissing(): Promise<number>;
  acceptLicense(): void;
  dismissLicense(): void;
  refetch(): void;
}

export interface ModelInstallerOptions {
  /** false：挂载时不请求 /models，第一次 install 时再拉（命令面板动作用）。默认 true。 */
  readonly load?: boolean;
}

export function useModelInstaller({ load = true }: ModelInstallerOptions = {}): ModelInstaller {
  const api = useApi();
  const queryClient = useQueryClient();

  const models = createQuery(() => ({
    ...modelsQuery(api),
    enabled: load,
    refetchInterval: (query) => (anyInstalling(query.state.data?.items ?? []) ? INSTALL_FALLBACK_POLL_MS : false),
  }));

  let license = $state<LicenseRequest | null>(null);

  const mutation = createMutation(() => ({
    mutationFn: (body: ModelInstallBody) => installModels(api, body),
    onSuccess: (response) => {
      queryClient.setQueryData<ModelList>(modelKeys.list(), { items: response.items });
      if (response.started.length) toast(m.models_install_started({ count: response.started.flatMap((started) => started.keys).length }));
    },
    onError: (error, body) => {
      // 本地的表过期了（比如刚换了模型登记）：后端要求许可时补一次确认。
      if (isApiError(error) && error.code === "model_license_required" && !body.accept_license) {
        const items = licenseItems(current(), body.keys);
        license = { keys: body.keys, items };
        return;
      }
      toast.error(m.models_install_failed({ reason: apiErrorMessage(error) }));
      void queryClient.invalidateQueries({ queryKey: modelKeys.list() });
    },
  }));

  function current(): readonly ModelItem[] {
    return queryClient.getQueryData<ModelList>(modelKeys.list())?.items ?? [];
  }

  async function loaded(): Promise<readonly ModelItem[]> {
    if (queryClient.getQueryData<ModelList>(modelKeys.list())) return current();
    return (await queryClient.fetchQuery(modelsQuery(api))).items;
  }

  useEvent("job.updated", ({ job }) => {
    const list = queryClient.getQueryData<ModelList>(modelKeys.list());
    if (!list) return;
    const merged = mergeJob(list.items, job);
    if (!merged.matched) return;
    queryClient.setQueryData<ModelList>(modelKeys.list(), { items: merged.items });
    if (merged.finished) void queryClient.invalidateQueries({ queryKey: modelKeys.list() });
  });
  useEvent("resync", () => {
    void queryClient.invalidateQueries({ queryKey: modelKeys.all });
  });

  async function install(keys: readonly string[]): Promise<boolean> {
    if (!keys.length || mutation.isPending) return false;
    let items: readonly ModelItem[];
    try {
      items = await loaded();
    } catch (error) {
      toast.error(m.models_install_failed({ reason: apiErrorMessage(error) }));
      return false;
    }
    const gated = licenseItems(items, installSet(items, keys));
    if (gated.length) {
      license = { keys: [...keys], items: gated };
      return false;
    }
    mutation.mutate({ keys: [...keys] });
    return true;
  }

  return {
    get items() {
      return models.data?.items ?? [];
    },
    get loaded() {
      return models.data !== undefined;
    },
    get loading() {
      return models.isPending && load;
    },
    get error() {
      return models.error;
    },
    get submitting() {
      return mutation.isPending;
    },
    get license() {
      return license;
    },
    install,
    async installMissing() {
      let items: readonly ModelItem[];
      try {
        items = await loaded();
      } catch (error) {
        toast.error(m.models_install_failed({ reason: apiErrorMessage(error) }));
        return 0;
      }
      const keys = items.filter(canInstall).map((item) => item.key);
      if (!keys.length) {
        toast(m.models_nothing_missing());
        return 0;
      }
      await install(keys);
      return keys.length;
    },
    acceptLicense() {
      if (!license) return;
      const keys = [...license.keys];
      license = null;
      mutation.mutate({ keys, accept_license: true });
    },
    dismissLicense() {
      license = null;
    },
    refetch() {
      void models.refetch();
    },
  };
}
