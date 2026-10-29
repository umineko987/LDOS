// 任务结束的 toast：成功 / 失败各一条，带「打开」；短时间里结束很多个时并成一条汇总（限流见 job-notifier.ts）。
// 取消的任务不提示；成功的任务在用户已经停在它的页面上、或页面声明了自己给反馈（LiveJobs.silence）时不提示。
// 失败总是提示。

import { toast } from "svelte-sonner";

import { goto } from "$app/navigation";
import type { Job } from "#lib/api/queries/jobs.ts";
import { createJobNotifier, type JobNotifier } from "#lib/events/job-notifier.ts";
import { jobLink } from "#lib/events/jobs.ts";
import { m } from "#lib/paraglide/messages.js";

const FAILURE_MS = 8_000;

export interface JobToastOptions {
  readonly isSilenced: (jobId: string) => boolean;
  /** 汇总 toast 的「查看」打开活动抽屉。 */
  readonly openActivity: () => void;
  /** 当前路由路径（不带 `#` 和查询串）。 */
  readonly currentPath?: () => string;
}

export function currentHashPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  const path = hash.split(/[?#]/, 1)[0] ?? "";
  return path || "/";
}

export function shouldToast(job: Job, isSilenced: (jobId: string) => boolean, currentPath: string): boolean {
  if (job.status === "failed") return true;
  if (job.status !== "succeeded" || isSilenced(job.id)) return false;
  return jobLink(job) !== currentPath;
}

export function createJobToasts({ isSilenced, openActivity, currentPath = currentHashPath }: JobToastOptions): JobNotifier {
  return createJobNotifier({
    filter: (job) => shouldToast(job, isSilenced, currentPath()),
    show(job) {
      const link = jobLink(job);
      const options = {
        id: `job:${job.id}`,
        description: job.message || undefined,
        action: link ? { label: m.activity_open(), onClick: () => void goto(`#${link}`) } : undefined,
      };
      if (job.status === "failed") toast.error(m.activity_toast_failed({ title: job.title }), { ...options, duration: FAILURE_MS });
      else toast.success(m.activity_toast_succeeded({ title: job.title }), options);
    },
    summarize(count, failed) {
      const action = { label: m.activity_toast_view(), onClick: openActivity };
      const title = m.activity_toast_summary({ count });
      if (failed) toast.error(title, { description: m.activity_toast_summary_failed({ failed }), action, duration: FAILURE_MS });
      else toast.success(title, { action });
    },
  });
}
