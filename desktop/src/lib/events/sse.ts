// 实时连接：先拉 /api/v1/jobs 快照，再用它的游标连 /api/v1/events（SSE）。
//
// - 每条事件先按 DomainEvents 校验，合格的交给总线；不认识的事件和坏载荷直接丢掉。
// - 断线时自己关掉 EventSource（不让浏览器按 3s 自动重连），按封顶的指数退避重连，
//   带上最后收到的事件 id（`?last_event_id=`），后端从那里补发。
// - 补不上时后端发 `resync`：转发给总线（页面重拉自己的查询），同时重拉任务快照。
// EventSource 由工厂注入，单元测试不需要真实连接。

import { fetchJobSnapshot, plainText, sanitizeEventId, sanitizeJob, type Job, type JobSnapshot } from "#lib/api/queries/jobs.ts";
import { boundedCount, isPlainRecord, ownValue } from "#lib/api/sanitize.ts";
import type { Api } from "#lib/api/client.ts";

import type { DomainEventKind, DomainEvents, EventBus } from "./bus.ts";

export type ConnectionState = "connecting" | "open" | "retrying" | "closed";

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

type Handle = ReturnType<typeof setTimeout>;

export interface RealtimeOptions {
  readonly origin: string;
  readonly bus: EventBus;
  readonly loadSnapshot: (signal: AbortSignal) => Promise<JobSnapshot>;
  /** 快照是权威的：调用方用它整表替换任务列表。 */
  readonly onSnapshot: (items: readonly Job[]) => void;
  readonly onState?: (state: ConnectionState) => void;
  readonly createSource?: (url: string) => EventSourceLike;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** 连接保持这么久才算稳定，之后再断线从最短退避重新算。 */
  readonly stableMs?: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly schedule?: (run: () => void, ms: number) => Handle;
  readonly cancel?: (handle: Handle) => void;
}

export interface Realtime {
  readonly state: ConnectionState;
  /** 最后确认的事件 id；重连时从这里续。 */
  readonly lastEventId: string;
  stop(): void;
}

const MAX_EVENT_CHARS = 256 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const WORD = /^[a-z][a-z0-9_]{0,31}$/;

type Parser<K extends DomainEventKind> = (data: Record<string, unknown>) => DomainEvents[K] | null;

function id(record: Record<string, unknown>, key: string): string | null {
  const value = ownValue(record, key);
  return typeof value === "string" && ID.test(value) ? value : null;
}

function word(record: Record<string, unknown>, key: string): string | null {
  const value = ownValue(record, key);
  return typeof value === "string" && WORD.test(value) ? value : null;
}

/** 可选的 id 字段：缺失、空串、不合法都当作没有。 */
function optionalIds<T extends string>(record: Record<string, unknown>, keys: readonly T[]): Partial<Record<T, string>> {
  const result: Partial<Record<T, string>> = {};
  for (const key of keys) {
    const value = id(record, key);
    if (value) result[key] = value;
  }
  return result;
}

const PARSERS: { readonly [K in DomainEventKind]: Parser<K> } = {
  "job.updated": (data) => {
    try {
      return { job: sanitizeJob(ownValue(data, "job")) };
    } catch {
      return null;
    }
  },
  "dataset.updated": (data) => {
    const dataset = id(data, "dataset_id");
    if (!dataset) return null;
    const reason = plainText(ownValue(data, "reason"), 64);
    return reason ? { dataset_id: dataset, reason } : { dataset_id: dataset };
  },
  "dataset.stage.updated": (data) => {
    const dataset = id(data, "dataset_id");
    const stage = word(data, "stage");
    const status = word(data, "status");
    if (!dataset || !stage || !status) return null;
    return { dataset_id: dataset, stage, status, ...optionalIds(data, ["run_id", "review_id", "export_id"] as const) };
  },
  "dataset.export.updated": (data) => {
    const dataset = id(data, "dataset_id");
    const exportId = id(data, "export_id");
    const status = word(data, "status");
    return dataset && exportId && status ? { dataset_id: dataset, export_id: exportId, status } : null;
  },
  "captions.updated": (data) => {
    const dataset = id(data, "dataset_id");
    if (!dataset) return null;
    return {
      dataset_id: dataset,
      batch_id: id(data, "batch_id") ?? "",
      changed: boundedCount(ownValue(data, "changed")),
      reason: plainText(ownValue(data, "reason"), 64),
    };
  },
  "atlas.updated": (data) => {
    const dataset = id(data, "dataset_id");
    const status = word(data, "status");
    return dataset && status ? { dataset_id: dataset, status, run_id: id(data, "run_id") ?? "" } : null;
  },
  resync: (data) => ({
    last_event_id: sanitizeEventId(ownValue(data, "last_event_id")),
    reason: plainText(ownValue(data, "reason"), 64),
  }),
};

export const DOMAIN_EVENT_KINDS = Object.freeze(Object.keys(PARSERS) as DomainEventKind[]);

/** 解析一条 SSE 的 data（JSON 文本）；不合契约返回 null。 */
export function parseDomainEvent<K extends DomainEventKind>(kind: K, raw: unknown): DomainEvents[K] | null {
  if (typeof raw !== "string" || raw.length > MAX_EVENT_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(value)) return null;
  return (PARSERS[kind] as Parser<K>)(value);
}

export function eventsUrl(origin: string, lastEventId: string): string {
  const url = new URL("/api/v1/events", `${origin}/`);
  if (lastEventId) url.searchParams.set("last_event_id", lastEventId);
  return url.href;
}

/** 第 `attempt` 次重连前的等待：base·2^attempt，封顶，再乘 0.8–1.2 的抖动。 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random: () => number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  const jitter = 0.8 + 0.4 * Math.min(1, Math.max(0, random()));
  return Math.round(Math.min(maxMs, exponential * jitter));
}

export function startRealtime({
  origin,
  bus,
  loadSnapshot,
  onSnapshot,
  onState = () => {},
  createSource = (url) => new EventSource(url),
  baseDelayMs = 1_000,
  maxDelayMs = 30_000,
  stableMs = 10_000,
  now = Date.now,
  random = Math.random,
  schedule = (run, ms) => setTimeout(run, ms),
  cancel = (handle) => clearTimeout(handle),
}: RealtimeOptions): Realtime {
  let state: ConnectionState = "connecting";
  let cursor = "";
  let attempt = 0;
  let openedAt: number | null = null;
  let source: EventSourceLike | null = null;
  let timer: Handle | null = null;
  let snapshot: AbortController | null = null;
  let stopped = false;

  function setState(next: ConnectionState) {
    if (state === next) return;
    state = next;
    onState(next);
  }

  function retry(connect: () => void) {
    if (stopped) return;
    setState("retrying");
    const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
    attempt += 1;
    timer = schedule(() => {
      timer = null;
      connect();
    }, delay);
  }

  /** 返回快照是否成功；失败时不动现有任务表。 */
  async function refreshSnapshot(): Promise<boolean> {
    snapshot?.abort();
    const controller = new AbortController();
    snapshot = controller;
    try {
      const result = await loadSnapshot(controller.signal);
      if (stopped || controller.signal.aborted) return false;
      onSnapshot(result.items);
      if (!cursor) cursor = result.lastEventId;
      return true;
    } catch {
      return false;
    } finally {
      if (snapshot === controller) snapshot = null;
    }
  }

  function track(event: Event) {
    const next = sanitizeEventId((event as MessageEvent).lastEventId);
    if (next) cursor = next;
  }

  function open() {
    if (stopped) return;
    if (state !== "retrying") setState("connecting");
    const current = createSource(eventsUrl(origin, cursor));
    source = current;
    openedAt = null;

    current.addEventListener("open", () => {
      if (source !== current) return;
      openedAt = now();
      setState("open");
    });
    current.addEventListener("error", () => {
      if (source !== current) return;
      current.close();
      source = null;
      if (openedAt !== null && now() - openedAt >= stableMs) attempt = 0;
      retry(open);
    });
    current.addEventListener("hello", track);
    for (const kind of DOMAIN_EVENT_KINDS) {
      current.addEventListener(kind, (event) => {
        if (source !== current) return;
        const payload = parseDomainEvent(kind, (event as MessageEvent).data);
        track(event);
        if (payload === null) return;
        if (kind === "resync") {
          const marker = payload as DomainEvents["resync"];
          if (marker.last_event_id) cursor = marker.last_event_id;
          void refreshSnapshot();
        }
        bus.dispatch(kind, payload);
      });
    }
  }

  async function begin() {
    if (await refreshSnapshot()) open();
    else retry(() => void begin());
  }

  void begin();

  return {
    get state() {
      return state;
    },
    get lastEventId() {
      return cursor;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      snapshot?.abort();
      if (timer !== null) cancel(timer);
      timer = null;
      source?.close();
      source = null;
      setState("closed");
    },
  };
}

/** 外壳用：快照走生成的 API 客户端。 */
export function snapshotLoader(api: Api): (signal: AbortSignal) => Promise<JobSnapshot> {
  return (signal) => fetchJobSnapshot(api, signal);
}
