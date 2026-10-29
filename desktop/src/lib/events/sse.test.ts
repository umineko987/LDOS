import { describe, expect, it, vi } from "vitest";

import { createApi } from "#lib/api/client.ts";
import type { Job, JobSnapshot } from "#lib/api/queries/jobs.ts";

import { createEventBus, type DomainEventKind } from "./bus.ts";
import {
  backoffDelay,
  DOMAIN_EVENT_KINDS,
  eventsUrl,
  parseDomainEvent,
  snapshotLoader,
  startRealtime,
  type EventSourceLike,
  type RealtimeOptions,
} from "./sse.ts";

const ORIGIN = "http://127.0.0.1:8787";

const RAW_JOB = {
  id: "crawl:b1",
  kind: "crawl.batch",
  title: "采集批次 b1",
  status: "running",
  current: 3,
  total: 10,
  message: "",
  ref: { batch_id: "b1" },
  started_at: 100,
  updated_at: 110,
};

class FakeSource implements EventSourceLike {
  readonly listeners = new Map<string, ((event: Event) => void)[]>();
  closed = false;

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown, lastEventId = ""): void {
    const event = { type, data: typeof data === "string" ? data : JSON.stringify(data), lastEventId } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

interface Harness {
  sources: FakeSource[];
  timers: { run: () => void; ms: number }[];
  snapshots: (readonly Job[])[];
  states: string[];
  clock: { now: number };
  loadSnapshot: ReturnType<typeof vi.fn>;
  realtime: ReturnType<typeof startRealtime>;
  bus: ReturnType<typeof createEventBus>;
  flush: () => Promise<void>;
  last: () => FakeSource;
}

function harness(overrides: Partial<RealtimeOptions> = {}, snapshot?: () => Promise<JobSnapshot>): Harness {
  const sources: FakeSource[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const snapshots: (readonly Job[])[] = [];
  const states: string[] = [];
  const clock = { now: 0 };
  const bus = createEventBus();
  const loadSnapshot = vi.fn(snapshot ?? (async () => ({ items: [], lastEventId: "e-5" })));
  const realtime = startRealtime({
    origin: ORIGIN,
    bus,
    loadSnapshot,
    onSnapshot: (items) => snapshots.push(items),
    onState: (state) => states.push(state),
    createSource: (url) => {
      const source = new FakeSource(url);
      sources.push(source);
      return source;
    },
    now: () => clock.now,
    random: () => 0.5,
    schedule: (run, ms) => {
      timers.push({ run, ms });
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: vi.fn(),
    ...overrides,
  });
  return {
    sources,
    timers,
    snapshots,
    states,
    clock,
    loadSnapshot,
    realtime,
    bus,
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    last: () => sources.at(-1)!,
  };
}

describe("parseDomainEvent", () => {
  it("校验 job.updated 并消毒其中的 Job", () => {
    expect(parseDomainEvent("job.updated", JSON.stringify({ job: RAW_JOB }))).toMatchObject({
      job: { id: "crawl:b1", status: "running", ref: { batch_id: "b1" } },
    });
    expect(parseDomainEvent("job.updated", JSON.stringify({ job: { ...RAW_JOB, status: "exploded" } }))).toBeNull();
  });

  it("各领域事件只保留契约字段，缺必需字段时丢弃", () => {
    expect(parseDomainEvent("dataset.updated", '{"dataset_id":"d1","reason":"roots","extra":1}')).toEqual({
      dataset_id: "d1",
      reason: "roots",
    });
    expect(parseDomainEvent("dataset.updated", '{"dataset_id":"d1"}')).toEqual({ dataset_id: "d1" });
    expect(parseDomainEvent("dataset.updated", '{"dataset_id":"../x"}')).toBeNull();
    expect(
      parseDomainEvent("dataset.stage.updated", '{"dataset_id":"d1","stage":"clean","status":"running","run_id":"r1","review_id":""}'),
    ).toEqual({ dataset_id: "d1", stage: "clean", status: "running", run_id: "r1" });
    expect(parseDomainEvent("dataset.stage.updated", '{"dataset_id":"d1","stage":"clean"}')).toBeNull();
    expect(parseDomainEvent("dataset.export.updated", '{"dataset_id":"d1","export_id":"x1","status":"succeeded"}')).toEqual({
      dataset_id: "d1",
      export_id: "x1",
      status: "succeeded",
    });
    expect(parseDomainEvent("dataset.export.updated", '{"dataset_id":"d1","status":"succeeded"}')).toBeNull();
    expect(parseDomainEvent("captions.updated", '{"dataset_id":"d1","batch_id":"b","changed":3,"reason":"ops"}')).toEqual({
      dataset_id: "d1",
      batch_id: "b",
      changed: 3,
      reason: "ops",
    });
    expect(parseDomainEvent("captions.updated", '{"dataset_id":"d1","changed":-1}')).toEqual({
      dataset_id: "d1",
      batch_id: "",
      changed: 0,
      reason: "",
    });
    expect(parseDomainEvent("captions.updated", "{}")).toBeNull();
    expect(parseDomainEvent("atlas.updated", '{"dataset_id":"d1","status":"ready","run_id":null}')).toEqual({
      dataset_id: "d1",
      status: "ready",
      run_id: "",
    });
    expect(parseDomainEvent("atlas.updated", '{"dataset_id":"d1"}')).toBeNull();
    expect(parseDomainEvent("resync", '{"last_event_id":"ab-9","reason":"buffer_overflow"}')).toEqual({
      last_event_id: "ab-9",
      reason: "buffer_overflow",
    });
  });

  it("拒绝非 JSON、非对象、超长载荷", () => {
    expect(parseDomainEvent("dataset.updated", "not json")).toBeNull();
    expect(parseDomainEvent("dataset.updated", "[1]")).toBeNull();
    expect(parseDomainEvent("dataset.updated", 42)).toBeNull();
    expect(parseDomainEvent("dataset.updated", `{"dataset_id":"d1","pad":"${"x".repeat(300_000)}"}`)).toBeNull();
  });

  it("覆盖总线里声明的全部事件", () => {
    const kinds: DomainEventKind[] = [
      "job.updated",
      "dataset.updated",
      "dataset.stage.updated",
      "dataset.export.updated",
      "captions.updated",
      "atlas.updated",
      "resync",
    ];
    expect([...DOMAIN_EVENT_KINDS].sort()).toEqual(kinds.sort());
  });
});

describe("eventsUrl / backoffDelay", () => {
  it("游标放在查询参数里，没有游标时不带", () => {
    expect(eventsUrl(ORIGIN, "")).toBe(`${ORIGIN}/api/v1/events`);
    expect(eventsUrl(ORIGIN, "ab-3")).toBe(`${ORIGIN}/api/v1/events?last_event_id=ab-3`);
  });

  it("指数增长、封顶、带抖动", () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, () => 0.5)).toBe(8000);
    expect(backoffDelay(10, 1000, 30_000, () => 0.5)).toBe(30_000);
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(800);
    expect(backoffDelay(0, 1000, 30_000, () => 1)).toBe(1200);
    expect(backoffDelay(99, 1000, 30_000, () => 1)).toBe(30_000);
  });
});

describe("startRealtime", () => {
  it("先拉快照，再用快照游标连接；open 后状态变为 open", async () => {
    const h = harness({}, async () => ({ items: [], lastEventId: "e-5" }));
    expect(h.realtime.state).toBe("connecting");
    await h.flush();
    expect(h.snapshots).toEqual([[]]);
    expect(h.last().url).toBe(`${ORIGIN}/api/v1/events?last_event_id=e-5`);
    h.last().emit("open");
    expect(h.realtime.state).toBe("open");
    expect(h.states).toEqual(["open"]);
  });

  it("合格的事件交给总线并推进游标，坏载荷只推进游标", async () => {
    const h = harness();
    const jobs = vi.fn();
    const datasets = vi.fn();
    h.bus.subscribe("job.updated", jobs);
    h.bus.subscribe("dataset.updated", datasets);
    await h.flush();
    h.last().emit("job.updated", { job: RAW_JOB }, "e-6");
    h.last().emit("dataset.updated", { nope: true }, "e-7");
    h.last().emit("dataset.updated", { dataset_id: "d1" }, "e-8");
    expect(jobs).toHaveBeenCalledOnce();
    expect(jobs.mock.calls[0]![0].job.id).toBe("crawl:b1");
    expect(datasets).toHaveBeenCalledExactlyOnceWith({ dataset_id: "d1" });
    expect(h.realtime.lastEventId).toBe("e-8");
  });

  it("hello 只记录游标", async () => {
    const h = harness({}, async () => ({ items: [], lastEventId: "" }));
    await h.flush();
    expect(h.last().url).toBe(`${ORIGIN}/api/v1/events`);
    h.last().emit("hello", { last_event_id: "e-1", reason: "" }, "e-1");
    expect(h.realtime.lastEventId).toBe("e-1");
  });

  it("resync：转发给总线、采用新游标、重拉快照", async () => {
    const h = harness();
    const resync = vi.fn();
    h.bus.subscribe("resync", resync);
    await h.flush();
    h.last().emit("resync", { last_event_id: "f-0", reason: "unknown_cursor" }, "f-0");
    await h.flush();
    expect(resync).toHaveBeenCalledExactlyOnceWith({ last_event_id: "f-0", reason: "unknown_cursor" });
    expect(h.loadSnapshot).toHaveBeenCalledTimes(2);
    expect(h.snapshots).toHaveLength(2);
    expect(h.realtime.lastEventId).toBe("f-0");
  });

  it("断线后关闭旧连接，按退避重连并带上最后的游标", async () => {
    const h = harness();
    await h.flush();
    const first = h.last();
    first.emit("open");
    first.emit("dataset.updated", { dataset_id: "d1" }, "e-9");
    first.emit("error");
    expect(first.closed).toBe(true);
    expect(h.realtime.state).toBe("retrying");
    expect(h.timers.map((timer) => timer.ms)).toEqual([1000]);

    // 旧连接上迟到的事件被忽略。
    first.emit("open");
    expect(h.realtime.state).toBe("retrying");

    h.timers[0]!.run();
    expect(h.last()).not.toBe(first);
    expect(h.last().url).toBe(`${ORIGIN}/api/v1/events?last_event_id=e-9`);
    h.last().emit("error");
    expect(h.timers.map((timer) => timer.ms)).toEqual([1000, 2000]);
    h.last().emit("error");
    expect(h.timers).toHaveLength(2);
  });

  it("连接稳定一段时间后再断线，退避从头算", async () => {
    const h = harness({ stableMs: 10_000 });
    await h.flush();
    h.last().emit("error");
    h.timers[0]!.run();
    h.last().emit("error");
    h.timers[1]!.run();
    expect(h.timers.map((timer) => timer.ms)).toEqual([1000, 2000]);
    h.last().emit("open");
    h.clock.now = 20_000;
    h.last().emit("error");
    expect(h.timers.at(-1)!.ms).toBe(1000);
  });

  it("快照失败时按退避重试，成功后才连接", async () => {
    let fail = true;
    const h = harness({}, async () => {
      if (fail) throw new Error("offline");
      return { items: [], lastEventId: "e-1" };
    });
    await h.flush();
    expect(h.sources).toHaveLength(0);
    expect(h.realtime.state).toBe("retrying");
    fail = false;
    h.timers[0]!.run();
    await h.flush();
    expect(h.sources).toHaveLength(1);
    expect(h.last().url).toContain("last_event_id=e-1");
  });

  it("stop 关闭连接、取消计时器，之后不再连接", async () => {
    const cancel = vi.fn();
    const h = harness({ cancel });
    await h.flush();
    h.last().emit("error");
    h.realtime.stop();
    expect(cancel).toHaveBeenCalledOnce();
    expect(h.realtime.state).toBe("closed");
    h.timers[0]!.run();
    expect(h.sources).toHaveLength(1);
    h.realtime.stop();
    expect(h.states.filter((state) => state === "closed")).toHaveLength(1);
  });

  it("stop 时进行中的快照被丢弃", async () => {
    let resolve!: (value: JobSnapshot) => void;
    const h = harness({}, () => new Promise((done) => (resolve = done)));
    const source = h.sources.length;
    h.realtime.stop();
    resolve({ items: [], lastEventId: "e-1" });
    await h.flush();
    expect(h.snapshots).toHaveLength(0);
    expect(h.sources).toHaveLength(source);
  });

  it("stop 时关闭活动连接", async () => {
    const h = harness();
    await h.flush();
    h.realtime.stop();
    expect(h.last().closed).toBe(true);
  });

  it("默认参数可用（真实计时器、EventSource 工厂由调用方给）", async () => {
    vi.useFakeTimers();
    try {
      const sources: FakeSource[] = [];
      const realtime = startRealtime({
        origin: ORIGIN,
        bus: createEventBus(),
        loadSnapshot: async () => ({ items: [], lastEventId: "" }),
        onSnapshot: () => {},
        createSource: (url) => {
          const source = new FakeSource(url);
          sources.push(source);
          return source;
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(sources).toHaveLength(1);
      sources[0]!.emit("error");
      await vi.advanceTimersByTimeAsync(1_300);
      expect(sources).toHaveLength(2);
      realtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("snapshotLoader", () => {
  it("通过 API 客户端拉 /api/v1/jobs", async () => {
    const api = createApi(ORIGIN, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ items: [RAW_JOB], last_event_id: "e-3" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    });
    const snapshot = await snapshotLoader(api)(new AbortController().signal);
    expect(snapshot.lastEventId).toBe("e-3");
    expect(snapshot.items.map((job) => job.id)).toEqual(["crawl:b1"]);
  });
});
