import { afterEach, describe, expect, it, vi } from "vitest";

import { createApi } from "#lib/api/client.ts";
import type { PlatformAdapter } from "#lib/platform/adapter.ts";
import type { BackendStatus } from "#lib/platform/sanitize.ts";

import { INITIAL_BOOT, startBootGate, type BootSnapshot } from "./gate.ts";
import { bootMessage, bootTitle } from "./messages.ts";

const ORIGIN = "http://127.0.0.1:9123";

function platform(statuses: BackendStatus[], metadata: () => Promise<unknown> = async () => ({})) {
  const queue = [...statuses];
  return {
    mode: "tauri",
    capabilities: { selectDirectory: true, selectBrowserExecutable: true, revealInFileManager: true },
    getBackendStatus: vi.fn(async () => (queue.length > 1 ? queue.shift()! : queue[0]!)),
    getRuntimeMetadata: vi.fn(async () => {
      await metadata();
      return { apiOrigin: ORIGIN, backendVersion: "0.5.2" };
    }),
    selectDirectory: vi.fn(),
    selectBrowserExecutable: vi.fn(),
    revealInFileManager: vi.fn(),
  } satisfies PlatformAdapter;
}

function healthResponses(...responses: Array<Response | Error>) {
  const fetchImpl = vi.fn(async (_request: Request) => {
    const next = responses.length > 1 ? responses.shift()! : responses[0]!;
    if (next instanceof Error) throw next;
    return next.clone();
  });
  return { fetchImpl, createApi: (origin: string) => createApi(origin, { fetchImpl }) };
}

const healthy = () => new Response(JSON.stringify({ ok: true, components: { database: { status: "ok" } }, time: 1 }));
const unhealthy = () => new Response(JSON.stringify({ ok: false, components: { database: { status: "error" } } }));

function run(adapter: PlatformAdapter, api: ReturnType<typeof healthResponses>) {
  const snapshots: BootSnapshot[] = [];
  const gate = startBootGate({ platform: adapter, createApi: api.createApi, onChange: (next) => snapshots.push(next) });
  return { gate, snapshots, last: () => snapshots.at(-1)! };
}

describe("startBootGate", () => {
  afterEach(() => vi.useRealTimers());

  it("等待后端启动，就绪后用 /healthz 确认再交出 Api", async () => {
    vi.useFakeTimers();
    const adapter = platform([{ state: "starting", code: null }, { state: "ready", code: null }]);
    const api = healthResponses(healthy());
    const { gate, snapshots, last } = run(adapter, api);

    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: "starting", status: { state: "starting" } });
    expect(bootTitle(last())).toBe("正在准备工作台");
    expect(bootMessage(last())).toBe("正在启动本地服务");

    await vi.advanceTimersByTimeAsync(500);
    expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(["starting", "connecting", "ready"]);
    expect(bootMessage(snapshots[1]!)).toBe("正在连接本地服务");
    expect(last().api?.origin).toBe(ORIGIN);
    expect(last().backendVersion).toBe("0.5.2");
    expect(bootMessage(last())).toBe("本地服务已就绪");
    expect(new URL(api.fetchImpl.mock.calls[0]![0].url).pathname).toBe("/healthz");

    // 就绪后放慢轮询，状态不变就不再发请求。
    await vi.advanceTimersByTimeAsync(2_000);
    expect(adapter.getBackendStatus).toHaveBeenCalledTimes(3);
    expect(api.fetchImpl).toHaveBeenCalledTimes(1);
    gate.stop();
  });

  it("后端退出时撤回 Api 并显示宿主给的原因", async () => {
    vi.useFakeTimers();
    const adapter = platform([
      { state: "ready", code: null },
      { state: "failed", code: "backend_exited" },
    ]);
    const { gate, last } = run(adapter, healthResponses(healthy()));
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe("ready");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(last()).toMatchObject({ phase: "failed", api: null, failure: null });
    expect(bootTitle(last())).toBe("本地服务暂时不可用");
    expect(bootMessage(last())).toBe("后端进程意外退出");
    gate.stop();
  });

  it("健康检查失败按退避重试，期间保持失败状态", async () => {
    vi.useFakeTimers();
    const adapter = platform([{ state: "ready", code: null }]);
    const api = healthResponses(unhealthy(), new Error("offline"), healthy());
    const { gate, snapshots, last } = run(adapter, api);

    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: "failed", failure: "unhealthy" });
    expect(bootMessage(last())).toBe("本地服务健康检查失败");

    await vi.advanceTimersByTimeAsync(500);
    expect(last()).toMatchObject({ phase: "failed", failure: "request_failed", error: { code: "network_error" } });
    expect(bootMessage(last())).toBe("无法连接到 LDOS 服务");

    await vi.advanceTimersByTimeAsync(999);
    expect(api.fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(last().phase).toBe("ready");
    expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(["connecting", "failed", "failed", "ready"]);
    gate.stop();
  });

  it("读不到运行时地址时失败，retry() 立即重试", async () => {
    vi.useFakeTimers();
    let broken = true;
    const adapter = platform([{ state: "ready", code: null }], async () => {
      if (broken) throw new Error("private");
    });
    const { gate, last } = run(adapter, healthResponses(healthy()));
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: "failed", failure: "runtime_unavailable" });
    expect(bootMessage(last())).toBe("无法读取本地服务地址");

    broken = false;
    gate.retry();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().phase).toBe("ready");
    gate.stop();
    gate.retry();
    expect(adapter.getBackendStatus).toHaveBeenCalledTimes(2);
  });

  it("stop() 中止进行中的健康检查且不再更新", async () => {
    vi.useFakeTimers();
    const adapter = platform([{ state: "ready", code: null }]);
    let release: (() => void) | undefined;
    const fetchImpl = vi.fn(
      (request: Request) =>
        new Promise<Response>((resolve, reject) => {
          release = () => resolve(healthy());
          request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const snapshots: BootSnapshot[] = [];
    const gate = startBootGate({
      platform: adapter,
      createApi: (origin) => createApi(origin, { fetchImpl }),
      onChange: (next) => snapshots.push(next),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    gate.retry(); // 进行中的检查不会被重复发起
    gate.stop();
    release?.();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(["connecting"]);
    expect(adapter.getBackendStatus).toHaveBeenCalledTimes(1);
  });

  it("宿主状态读取异常时按 platform_unavailable 处理", async () => {
    vi.useFakeTimers();
    const adapter = platform([{ state: "starting", code: null }]);
    adapter.getBackendStatus.mockRejectedValueOnce(new Error("bridge crashed"));
    const { gate, last } = run(adapter, healthResponses(healthy()));
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ phase: "failed", status: { code: "platform_unavailable" } });
    expect(bootMessage(last())).toBe("桌面宿主暂时不可用");
    gate.stop();
  });
});

describe("bootMessage", () => {
  it("覆盖宿主状态的兜底文案", () => {
    expect(bootMessage(INITIAL_BOOT)).toBe("正在启动本地服务");
    expect(bootMessage({ ...INITIAL_BOOT, phase: "failed", status: { state: "failed", code: null } })).toBe(
      "桌面宿主发生错误",
    );
    expect(bootMessage({ ...INITIAL_BOOT, phase: "failed", status: { state: "stopped", code: null } })).toBe(
      "后端服务已停止",
    );
    expect(bootMessage({ ...INITIAL_BOOT, status: { state: "starting", code: "backend_start_timeout" } })).toBe(
      "等待后端启动超时",
    );
  });
});
