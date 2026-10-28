// 启动门，从旧版 App.svelte 移植：轮询宿主的后端状态，就绪后读运行时 origin，
// 用 /healthz 确认服务可用，再把 Api 交给外壳。失败后按退避间隔自动重试。

import { createApi as defaultCreateApi, data, type Api } from "#lib/api/client.ts";
import { isAbortError } from "#lib/api/errors.ts";
import { sanitizeHealth } from "#lib/api/queries/system.ts";
import type { PlatformAdapter } from "#lib/platform/adapter.ts";
import type { BackendStatus } from "#lib/platform/sanitize.ts";

export type BootPhase = "starting" | "connecting" | "ready" | "failed";

/** 宿主报告后端正常、但前端连不上时的原因。 */
export type BootFailure = "runtime_unavailable" | "request_failed" | "unhealthy";

export interface BootSnapshot {
  readonly phase: BootPhase;
  /** 最近一次宿主报告的后端状态。 */
  readonly status: BackendStatus | null;
  readonly failure: BootFailure | null;
  /** `failure === "request_failed"` 时的 ApiError，界面用 apiErrorMessage() 显示。 */
  readonly error: unknown;
  readonly api: Api | null;
  readonly backendVersion: string | null;
}

export interface BootTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface BootGateOptions {
  readonly platform: PlatformAdapter;
  readonly onChange: (snapshot: BootSnapshot) => void;
  readonly createApi?: (origin: string) => Api;
  readonly timers?: BootTimers;
  /** 等待后端启动时的轮询间隔。 */
  readonly pollMs?: number;
  /** 就绪后继续轮询宿主状态，后端退出时退回启动门。 */
  readonly readyPollMs?: number;
  /** 连接失败后的退避上限。 */
  readonly maxRetryMs?: number;
}

export interface BootGate {
  /** 立即重试，并重置退避。 */
  retry(): void;
  stop(): void;
}

export const INITIAL_BOOT: BootSnapshot = Object.freeze({
  phase: "starting",
  status: null,
  failure: null,
  error: null,
  api: null,
  backendVersion: null,
});

const defaultTimers: BootTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function startBootGate({
  platform,
  onChange,
  createApi = (origin) => defaultCreateApi(origin),
  timers = defaultTimers,
  pollMs = 500,
  readyPollMs = 2_000,
  maxRetryMs = 5_000,
}: BootGateOptions): BootGate {
  let active = true;
  let running = false;
  let timer: unknown = null;
  let failures = 0;
  let controller: AbortController | null = null;
  let snapshot = INITIAL_BOOT;

  const emit = (next: Partial<BootSnapshot>) => {
    snapshot = Object.freeze({ ...snapshot, ...next });
    onChange(snapshot);
  };

  const schedule = (ms: number) => {
    if (!active) return;
    timer = timers.setTimeout(() => void tick(), ms);
  };

  const backoff = () => Math.min(maxRetryMs, pollMs * 2 ** Math.min(failures - 1, 16));

  const fail = (status: BackendStatus, failure: BootFailure, error: unknown = null) => {
    failures += 1;
    emit({ phase: "failed", status, failure, error, api: null });
    schedule(backoff());
  };

  async function connect(status: BackendStatus) {
    // 失败后的自动重试不闪回“连接中”，保留上一次的失败说明。
    if (snapshot.phase !== "failed") emit({ phase: "connecting", status, failure: null, error: null });

    let api: Api;
    let backendVersion: string | null;
    try {
      const runtime = await platform.getRuntimeMetadata();
      api = createApi(runtime.apiOrigin);
      backendVersion = runtime.backendVersion;
    } catch {
      if (active) fail(status, "runtime_unavailable");
      return;
    }

    controller = new AbortController();
    try {
      const health = sanitizeHealth(await data(api.client.GET("/healthz", { signal: controller.signal })));
      if (!active) return;
      if (!health.ok) return fail(status, "unhealthy");
    } catch (error) {
      if (!active || isAbortError(error)) return;
      return fail(status, "request_failed", error);
    } finally {
      controller = null;
    }

    failures = 0;
    emit({ phase: "ready", status, failure: null, error: null, api, backendVersion });
    schedule(readyPollMs);
  }

  async function tick() {
    timer = null;
    if (!active || running) return;
    running = true;
    try {
      const status = await platform.getBackendStatus().catch(
        (): BackendStatus => ({ state: "failed", code: "platform_unavailable" }),
      );
      if (!active) return;
      if (status.state === "ready") {
        if (snapshot.phase === "ready") schedule(readyPollMs);
        else await connect(status);
        return;
      }
      failures = 0;
      emit({ phase: status.state === "starting" ? "starting" : "failed", status, failure: null, error: null, api: null });
      schedule(pollMs);
    } finally {
      running = false;
    }
  }

  void tick();

  return {
    retry() {
      if (!active || running) return;
      if (timer !== null) timers.clearTimeout(timer);
      failures = 0;
      void tick();
    },
    stop() {
      active = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
      controller?.abort();
    },
  };
}
