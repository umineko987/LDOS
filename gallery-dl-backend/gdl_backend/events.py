"""进程内事件总线与统一任务（Job）模型：活动中心的数据源。

- ``EventBus``：任意线程 ``publish``；asyncio 订阅者经 ``call_soon_threadsafe`` 唤醒。
  环形缓冲保留最近 ``EVENT_BUFFER_SIZE`` 条事件，事件 id 为 ``<epoch>-<seq>``；
  断线重连按 Last-Event-ID 补发，补不上（缓冲已滚过、来自上一个进程或格式不对）
  就先发 ``resync``，客户端据此全量重新拉取。
- ``JobRegistry``：所有长任务（打标、扫描、采集批次、去重审核、导出……）的统一投影。
  每次变化发布一条 ``job.updated`` 事件；纯进度变化按 ``min_publish_interval`` 节流，
  被节流的变化由 ``flush()``（采样器每秒调用）补发。
"""

from __future__ import annotations

import asyncio
import secrets
import threading
import time
from collections import deque
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass, field
from itertools import islice
from typing import Any, Literal

EVENT_BUFFER_SIZE = 2048
JOB_EVENT = "job.updated"
HELLO_EVENT = "hello"
RESYNC_EVENT = "resync"

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled"]
JOB_STATUSES: frozenset[str] = frozenset({"queued", "running", "succeeded", "failed", "cancelled"})
TERMINAL_JOB_STATUSES: frozenset[str] = frozenset({"succeeded", "failed", "cancelled"})


@dataclass(frozen=True, slots=True)
class BusEvent:
    seq: int
    id: str
    kind: str
    data: Mapping[str, Any]
    time: float


@dataclass(frozen=True, slots=True)
class StreamMarker:
    """流控制标记：``hello``（建立连接）或 ``resync``（无法补齐，需全量拉取）。"""

    kind: Literal["hello", "resync"]
    id: str
    reason: str = ""


class _Waiter:
    __slots__ = ("loop", "event")

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self.loop = loop
        self.event = asyncio.Event()

    def wake(self) -> None:
        try:
            self.loop.call_soon_threadsafe(self.event.set)
        except RuntimeError:
            # 订阅者所在的事件循环已关闭；它的流也随之结束，无需唤醒。
            pass


class EventBus:
    def __init__(
        self,
        *,
        buffer_size: int = EVENT_BUFFER_SIZE,
        clock: Callable[[], float] = time.time,
        epoch: str | None = None,
    ) -> None:
        self.epoch = epoch or secrets.token_hex(4)
        self._clock = clock
        self._lock = threading.Lock()
        self._buffer: deque[BusEvent] = deque(maxlen=max(1, int(buffer_size)))
        self._seq = 0
        self._waiters: set[_Waiter] = set()
        self._closed = False

    # ---- 发布 ----

    def publish(self, kind: str, data: Mapping[str, Any] | None = None) -> BusEvent | None:
        """线程安全地追加一条事件；总线关闭后返回 None。"""

        with self._lock:
            if self._closed:
                return None
            self._seq += 1
            event = BusEvent(
                seq=self._seq,
                id=self._format_id(self._seq),
                kind=kind,
                data=dict(data or {}),
                time=self._clock(),
            )
            self._buffer.append(event)
            waiters = tuple(self._waiters)
        for waiter in waiters:
            waiter.wake()
        return event

    # ---- 查询 ----

    @property
    def last_event_id(self) -> str:
        with self._lock:
            return self._format_id(self._seq)

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._waiters)

    @property
    def closed(self) -> bool:
        with self._lock:
            return self._closed

    def parse_event_id(self, value: str | None) -> int | None:
        """解析本进程签发的事件 id；外来 epoch、未来序号或格式错误返回 None。"""

        if not value:
            return None
        epoch, separator, raw_seq = value.strip().rpartition("-")
        if not separator or epoch != self.epoch or not raw_seq.isdigit():
            return None
        seq = int(raw_seq)
        with self._lock:
            return seq if seq <= self._seq else None

    def events_after(self, seq: int) -> tuple[list[BusEvent], bool]:
        """返回序号 ``seq`` 之后的事件；第二项为 False 表示缓冲已滚过，需要 resync。"""

        with self._lock:
            if seq >= self._seq:
                return [], True
            oldest = self._buffer[0].seq if self._buffer else self._seq + 1
            if seq < oldest - 1:
                return [], False
            return list(islice(self._buffer, seq - oldest + 1, None)), True

    # ---- 订阅 ----

    async def stream(self, last_event_id: str | None = None) -> AsyncIterator[BusEvent | StreamMarker]:
        """订阅事件流，直到总线关闭或调用方取消。

        - 不带游标：先发 ``hello``（携带当前游标），之后只推新事件；
        - 带合法游标：直接补发游标之后的事件；
        - 游标无法补齐：先发 ``resync``，再从当前位置继续。
        """

        waiter = _Waiter(asyncio.get_running_loop())
        with self._lock:
            if self._closed:
                return
            self._waiters.add(waiter)
            current = self._seq
        try:
            if last_event_id is None or not last_event_id.strip():
                cursor = current
                yield StreamMarker(HELLO_EVENT, self._format_id(cursor))
            else:
                parsed = self.parse_event_id(last_event_id)
                if parsed is None:
                    cursor = current
                    yield StreamMarker(RESYNC_EVENT, self._format_id(cursor), "unknown_cursor")
                else:
                    cursor = parsed
            while True:
                waiter.event.clear()
                if self.closed:
                    return
                events, complete = self.events_after(cursor)
                if not complete:
                    with self._lock:
                        cursor = self._seq
                    yield StreamMarker(RESYNC_EVENT, self._format_id(cursor), "buffer_overflow")
                    continue
                if events:
                    for event in events:
                        cursor = event.seq
                        yield event
                    continue
                await waiter.event.wait()
        finally:
            with self._lock:
                self._waiters.discard(waiter)

    def close(self) -> None:
        """结束所有订阅流；之后的 publish 被忽略。"""

        with self._lock:
            self._closed = True
            waiters = tuple(self._waiters)
        for waiter in waiters:
            waiter.wake()

    def reopen(self) -> None:
        """容器重新启动时恢复发布；序号与缓冲保留，已断开的客户端按游标补发。"""

        with self._lock:
            self._closed = False

    def _format_id(self, seq: int) -> str:
        return f"{self.epoch}-{seq}"


@dataclass(slots=True)
class Job:
    id: str
    kind: str
    title: str
    status: str
    current: int | None
    total: int | None
    message: str
    ref: dict[str, str]
    started_at: float
    updated_at: float
    finished_at: float | None = None
    _published_at: float = field(default=0.0, repr=False)
    _dirty: bool = field(default=False, repr=False)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "title": self.title,
            "status": self.status,
            "current": self.current,
            "total": self.total,
            "message": self.message,
            "ref": dict(self.ref),
            "started_at": self.started_at,
            "updated_at": self.updated_at,
            "finished_at": self.finished_at,
        }


def _optional_count(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return None


def _clean_ref(ref: Mapping[str, Any] | None) -> dict[str, str]:
    return {str(key): str(value) for key, value in (ref or {}).items() if value is not None}


class JobRegistry:
    """线程安全的 Job 表；活动任务常驻，终态任务按时间保留最近 ``retain_finished`` 条。"""

    def __init__(
        self,
        bus: EventBus,
        *,
        retain_finished: int = 200,
        min_publish_interval: float = 0.25,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._bus = bus
        self._retain_finished = max(1, int(retain_finished))
        self._min_publish_interval = max(0.0, float(min_publish_interval))
        self._clock = clock
        self._lock = threading.RLock()
        self._jobs: dict[str, Job] = {}

    def start(
        self,
        kind: str,
        title: str,
        *,
        job_id: str | None = None,
        status: JobStatus = "running",
        current: int | None = None,
        total: int | None = None,
        message: str = "",
        ref: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """登记（或重新开始）一个任务并立即发布。同 id 的终态任务会被重置。"""

        if status not in JOB_STATUSES:
            raise ValueError(f"unknown job status: {status}")
        now = self._clock()
        job_id = job_id or f"{kind}:{secrets.token_hex(6)}"
        with self._lock:
            job = Job(
                id=job_id,
                kind=kind,
                title=title,
                status=status,
                current=_optional_count(current),
                total=_optional_count(total),
                message=message,
                ref=_clean_ref(ref),
                started_at=now,
                updated_at=now,
                finished_at=now if status in TERMINAL_JOB_STATUSES else None,
            )
            self._jobs[job_id] = job
            self._prune_locked()
            return self._publish_locked(job)

    def update(
        self,
        job_id: str,
        *,
        status: JobStatus | None = None,
        current: int | None = None,
        total: int | None = None,
        message: str | None = None,
        title: str | None = None,
        ref: Mapping[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        """更新已登记的任务；未知 id 返回 None。纯进度/消息变化会被节流。"""

        if status is not None and status not in JOB_STATUSES:
            raise ValueError(f"unknown job status: {status}")
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            significant = False
            changed = False
            if status is not None and status != job.status:
                job.status = status
                job.finished_at = self._clock() if status in TERMINAL_JOB_STATUSES else None
                significant = True
            if title is not None and title != job.title:
                job.title = title
                significant = True
            if total is not None and _optional_count(total) != job.total:
                job.total = _optional_count(total)
                significant = True
            if ref is not None:
                cleaned = _clean_ref(ref)
                if cleaned != job.ref:
                    job.ref = cleaned
                    significant = True
            if current is not None and _optional_count(current) != job.current:
                job.current = _optional_count(current)
                changed = True
            if message is not None and message != job.message:
                job.message = message
                changed = True
            if not (significant or changed):
                return job.to_dict()
            now = self._clock()
            job.updated_at = now
            if job.status in TERMINAL_JOB_STATUSES:
                self._prune_locked()
            reached_total = job.total is not None and job.current is not None and job.current >= job.total
            if significant or reached_total or now - job._published_at >= self._min_publish_interval:
                return self._publish_locked(job)
            job._dirty = True
            return job.to_dict()

    def finish(
        self,
        job_id: str,
        status: JobStatus = "succeeded",
        *,
        message: str | None = None,
        current: int | None = None,
        total: int | None = None,
    ) -> dict[str, Any] | None:
        if status not in TERMINAL_JOB_STATUSES:
            raise ValueError(f"not a terminal job status: {status}")
        return self.update(job_id, status=status, message=message, current=current, total=total)

    def flush(self) -> int:
        """补发被节流的进度变化，返回发布条数。"""

        with self._lock:
            dirty = [job for job in self._jobs.values() if job._dirty]
            for job in dirty:
                self._publish_locked(job)
            return len(dirty)

    def get(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.to_dict() if job is not None else None

    def list(self) -> list[dict[str, Any]]:
        """活动任务在前（按开始时间），终态任务在后（最近结束的在前）。"""

        with self._lock:
            jobs = list(self._jobs.values())
        active = sorted(
            (job for job in jobs if job.status not in TERMINAL_JOB_STATUSES),
            key=lambda job: job.started_at,
        )
        finished = sorted(
            (job for job in jobs if job.status in TERMINAL_JOB_STATUSES),
            key=lambda job: job.finished_at or job.updated_at,
            reverse=True,
        )
        return [job.to_dict() for job in (*active, *finished)]

    def active_ids(self, kind_prefix: str = "") -> set[str]:
        with self._lock:
            return {
                job.id
                for job in self._jobs.values()
                if job.status not in TERMINAL_JOB_STATUSES and job.kind.startswith(kind_prefix)
            }

    def has_active(self) -> bool:
        with self._lock:
            return any(job.status not in TERMINAL_JOB_STATUSES for job in self._jobs.values())

    def has_pending_publish(self) -> bool:
        with self._lock:
            return any(job._dirty for job in self._jobs.values())

    def _publish_locked(self, job: Job) -> dict[str, Any]:
        job._published_at = self._clock()
        job._dirty = False
        payload = job.to_dict()
        self._bus.publish(JOB_EVENT, {"job": payload})
        return payload

    def _prune_locked(self) -> None:
        finished = [job for job in self._jobs.values() if job.status in TERMINAL_JOB_STATUSES]
        overflow = len(finished) - self._retain_finished
        if overflow <= 0:
            return
        finished.sort(key=lambda job: job.finished_at or job.updated_at)
        for job in finished[:overflow]:
            self._jobs.pop(job.id, None)


__all__ = [
    "EVENT_BUFFER_SIZE",
    "HELLO_EVENT",
    "JOB_EVENT",
    "JOB_STATUSES",
    "RESYNC_EVENT",
    "TERMINAL_JOB_STATUSES",
    "BusEvent",
    "EventBus",
    "Job",
    "JobRegistry",
    "JobStatus",
    "StreamMarker",
]
