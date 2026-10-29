// 网络页各分区的写操作：同一分区一次只跑一个，结束后（成功或失败）重拉该分区的查询。
// 代理池的写接口不回新状态，必须重拉；失败时状态也可能已经部分改变，所以同样重拉。

import { useQueryClient } from "@tanstack/svelte-query";
import { toast } from "svelte-sonner";

import { apiErrorMessage } from "#lib/api/messages.ts";
import { m } from "#lib/paraglide/messages.js";

export interface Writer {
  /** 正在执行的操作标识；null 表示空闲。 */
  readonly busy: string | null;
  /** 成功返回 true。`done` 是成功提示。 */
  run(key: string, work: () => Promise<void>, done?: () => string): Promise<boolean>;
}

export function useWriter(queryKey: readonly unknown[]): Writer {
  const queryClient = useQueryClient();
  let busy = $state<string | null>(null);

  return {
    get busy() {
      return busy;
    },
    async run(key, work, done) {
      if (busy) return false;
      busy = key;
      try {
        await work();
        if (done) toast.success(done());
        return true;
      } catch (error) {
        toast.error(m.network_action_failed({ reason: apiErrorMessage(error) }));
        return false;
      } finally {
        // 等新状态回来再放开按钮，免得按旧状态再点一次。
        await queryClient.invalidateQueries({ queryKey }).catch(() => undefined);
        busy = null;
      }
    },
  };
}
