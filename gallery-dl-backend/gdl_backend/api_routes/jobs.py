"""活动中心：统一任务列表与 SSE 事件流。"""

from __future__ import annotations

from collections.abc import AsyncIterable
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, Query
from fastapi.sse import EventSourceResponse, ServerSentEvent
from pydantic import BaseModel, Field

from ..events import HELLO_EVENT, StreamMarker
from .dependencies import get_service

# 浏览器 EventSource 断线后按此间隔（毫秒）自动重连。
SSE_RETRY_MS = 2000


class JobResponse(BaseModel):
    id: str = Field(min_length=1, max_length=200)
    kind: str = Field(
        min_length=1,
        max_length=64,
        description="tagger.prepare | tagger.tag | gallery.scan | crawl.batch | dedup.review | gallery.export | models.install | …",
    )
    title: str
    status: Literal["queued", "running", "succeeded", "failed", "cancelled"]
    current: int | None = Field(default=None, ge=0)
    total: int | None = Field(default=None, ge=0)
    message: str
    ref: dict[str, str] = Field(description="关联对象 id，例如 dataset_id、batch_id、source_id")
    started_at: float
    updated_at: float
    finished_at: float | None = None


class JobListResponse(BaseModel):
    items: list[JobResponse]
    last_event_id: str = Field(description="打开 /api/v1/events 时作为 last_event_id 传入，可无缝衔接")


def create_jobs_router() -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["jobs"])

    @router.get("/jobs", response_model=JobListResponse)
    async def list_jobs(container: Any = Depends(get_service)):
        # 先采样一次：没有 SSE 客户端时采样器不跑，列表也不能陈旧。
        await container.job_sampler.refresh()
        return {"items": container.jobs.list(), "last_event_id": container.events.last_event_id}

    @router.get(
        "/events",
        response_class=EventSourceResponse,
        description=(
            "SSE 事件流。事件类型：hello（新连接）与 resync（游标无法补齐，客户端须全量重新拉取），"
            "data 均为 {last_event_id, reason}；job.updated 的 data 为 {job: JobResponse}，"
            "以及各领域服务发布的 `<领域>.<动作>` 事件。断线重连时浏览器自动带 Last-Event-ID；"
            "首次连接可用 last_event_id 查询参数衔接 GET /api/v1/jobs 返回的游标。"
        ),
    )
    async def stream_events(
        last_event_id: str | None = Query(default=None, max_length=64),
        last_event_id_header: str | None = Header(default=None, alias="Last-Event-ID", max_length=64),
        container: Any = Depends(get_service),
    ) -> AsyncIterable[ServerSentEvent]:
        cursor = last_event_id_header or last_event_id
        async for item in container.events.stream(cursor):
            if isinstance(item, StreamMarker):
                yield ServerSentEvent(
                    event=item.kind,
                    id=item.id,
                    data={"last_event_id": item.id, "reason": item.reason},
                    retry=SSE_RETRY_MS if item.kind == HELLO_EVENT else None,
                )
            else:
                yield ServerSentEvent(event=item.kind, id=item.id, data=dict(item.data))

    return router
