"""crawls / tasks / discovery 路由的响应模型。

这几组路由的负载早于 OpenAPI 类型化，而且随 view 参数换形状。这里的模型
只负责把字段写进 OpenAPI 供前端生成类型，不改写负载：

- extra="allow"：没声明的字段原样透传；
- strict=True：不做类型转换（int 不会被改成 float，字符串不会被解析成数字）；
- 字段都可选，路由配合 response_model_exclude_unset=True，负载里没有的
  字段不会被补成 null。

随 view 变化的路由用「desktop 投影 | legacy 负载」联合类型：desktop 投影由
路由显式构造，类型写得精确；legacy 负载直接来自数据库行，只声明列类型确定
的字段。
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


Number = int | float


class PassthroughModel(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)


# ---- 任务 ----


class TaskResponse(PassthroughModel):
    id: str | None = None
    url: str | None = None
    site: str | None = None
    subcategory: str | None = None
    extractor: str | None = None
    status: str | None = None
    priority: int | None = None
    output_dir: str | None = None
    proxy_mode: str | None = None
    max_attempts: int | None = None
    attempt_count: int | None = None
    next_run_at: Number | None = None
    created_at: Number | None = None
    updated_at: Number | None = None
    started_at: Number | None = None
    finished_at: Number | None = None
    cancel_requested: bool | None = None
    exit_code: int | None = None
    last_error_class: str | None = None
    last_error: str | None = None
    artifact_count: int | None = None
    artifact_bytes: int | None = None
    extra_args: list[Any] | None = None
    policy: dict[str, Any] | None = None
    tried_proxy_ids: list[Any] | None = None


class TaskListResponse(PassthroughModel):
    items: list[TaskResponse] | None = None
    limit: int | None = None
    offset: int | None = None


class TaskLogResponse(PassthroughModel):
    id: int | None = None
    task_id: str | None = None
    attempt_id: str | None = None
    ts: Number | None = None
    stream: str | None = None
    line: str | None = None


class TaskLogListResponse(PassthroughModel):
    items: list[TaskLogResponse] | None = None


class TaskEventResponse(PassthroughModel):
    id: int | None = None
    task_id: str | None = None
    ts: Number | None = None
    event_type: str | None = None
    payload: Any = None


class TaskEventListResponse(PassthroughModel):
    items: list[TaskEventResponse] | None = None


class TaskFileResponse(PassthroughModel):
    path: str | None = None
    size: int | None = None
    modified_at: Number | None = None


class TaskFileListResponse(PassthroughModel):
    items: list[TaskFileResponse] | None = None


# ---- 爬取批次 ----


class CrawlReviewSummaryResponse(PassthroughModel):
    batch_id: str | None = None
    status: str | None = None
    total_image_count: int | None = None
    duplicate_group_count: int | None = None
    decided_group_count: int | None = None
    total_group_count: int | None = None


class CrawlCurrentAddressResponse(PassthroughModel):
    source_order: int | None = None
    address_order: int | None = None
    address_id: str | None = None
    site: str | None = None
    url: str | None = None
    status: str | None = None


class CrawlAddressResponse(PassthroughModel):
    id: str | None = None
    site: str | None = None
    source_order: int | None = None
    address_order: int | None = None
    url: str | None = None
    label: str | None = None
    address_type: str | None = None
    status: str | None = None
    planned_task_count: int | None = None
    succeeded_task_count: int | None = None
    failed_task_count: int | None = None
    cancelled_task_count: int | None = None
    pre_dedup_skipped_count: int | None = None
    probed_proxy_count: int | None = None
    healthy_proxy_count: int | None = None
    planning_error: str | None = None


class CrawlSourceGroupResponse(PassthroughModel):
    order: int | None = None
    site: str | None = None
    status: str | None = None
    pre_dedup_skipped_count: int | None = None
    addresses: list[CrawlAddressResponse] | None = None


class CrawlBatchResponse(PassthroughModel):
    """批次详情。view=desktop 时 response_profile='desktop-crawl-v1'，字段有界。"""

    response_profile: str | None = None
    id: str | None = None
    status: str | None = None
    output_dir: str | None = None
    concurrency: int | None = None
    max_tasks: int | None = None
    task_count: int | None = None
    succeeded_task_count: int | None = None
    failed_task_count: int | None = None
    cancelled_task_count: int | None = None
    pre_dedup_skipped_count: int | None = None
    cancel_requested: bool | None = None
    created_at: Number | None = None
    updated_at: Number | None = None
    started_at: Number | None = None
    finished_at: Number | None = None
    last_error: str | None = None
    resumable: bool | None = None
    source_count: int | None = None
    address_count: int | None = None
    current: CrawlCurrentAddressResponse | None = None
    sources: list[CrawlSourceGroupResponse] | None = None
    review: CrawlReviewSummaryResponse | None = None
    address_rows_limit: int | None = None
    address_rows_truncated: bool | None = None
    # 只出现在创建批次的响应里。
    created: bool | None = None
    requested_concurrency: int | None = None
    effective_concurrency: int | None = None


class CrawlBatchListResponse(PassthroughModel):
    items: list[CrawlBatchResponse] | None = None
    limit: int | None = None
    offset: int | None = None


class CrawlTaskResponse(TaskResponse):
    source_order: int | None = None
    address_order: int | None = None
    sequence_no: int | None = None
    crawl_address_id: str | None = None


class CrawlTaskListResponse(PassthroughModel):
    items: list[CrawlTaskResponse] | None = None
    limit: int | None = None
    offset: int | None = None


class CrawlBatchOperationResponse(PassthroughModel):
    """重试/重新爬取：legacy 返回计数 + batch；view=desktop 只返回批次状态。"""

    response_profile: str | None = None
    id: str | None = None
    status: str | None = None
    cancel_requested: bool | None = None
    batch_id: str | None = None
    batch: CrawlBatchResponse | None = None
    retried_count: int | None = None
    requeued_task_count: int | None = None
    replanned_address_count: int | None = None
    task_ids: list[str] | None = None
    address_ids: list[str] | None = None
    replanned_address_ids: list[str] | None = None
    requeue_succeeded: bool | None = None


# ---- 搜索 ----


class SearchTagNamespaceResponse(PassthroughModel):
    namespace: str | None = None
    label: str | None = None
    aliases: list[str] | None = None


class SearchSiteResponse(PassthroughModel):
    site: str | None = None
    aliases: list[str] | None = None
    candidate_kind: str | None = None
    authentication: str | None = None
    tag_namespaces: list[SearchTagNamespaceResponse] | None = None


class SearchSiteListResponse(PassthroughModel):
    items: list[SearchSiteResponse] | None = None


class SearchAutocompleteResponse(PassthroughModel):
    query: str | None = None
    source: str | None = None
    items: list[Any] | None = None


class DesktopSearchCandidateResponse(PassthroughModel):
    id: str | None = None
    url: str | None = None
    address_type: str | None = None
    label: str | None = None
    tag: str | None = None
    title: str | None = None
    confidence: str | None = None
    origin: str | None = None
    thumbnail_url: str | None = None
    media_count: int | None = None
    evidence_reasons: list[str] | None = None
    related_profile_count: int | None = None
    metadata: dict[str, list[str]] | None = None


class DesktopSearchFacetTagResponse(PassthroughModel):
    tag: str | None = None
    count: int | None = None


class DesktopSearchFacetResponse(PassthroughModel):
    namespace: str | None = None
    label: str | None = None
    gallery_count: int | None = None
    tags: list[DesktopSearchFacetTagResponse] | None = None


class DesktopSearchErrorResponse(PassthroughModel):
    code: str | None = None
    message: str | None = None


class DesktopSearchAuthResponse(PassthroughModel):
    state: str | None = None
    authorized: bool | None = None


class DesktopSearchSourceResponse(PassthroughModel):
    site: str | None = None
    status: str | None = None
    evidence_count: int | None = None
    preview_count: int | None = None
    attempts: int | None = None
    alias_keywords: list[str] | None = None
    error: DesktopSearchErrorResponse | None = None
    enrichment_error_count: int | None = None
    auth: DesktopSearchAuthResponse | None = None
    tag_facets: list[DesktopSearchFacetResponse] | None = None
    addresses: list[DesktopSearchCandidateResponse] | None = None
    weak_evidence: list[DesktopSearchCandidateResponse] | None = None


class DesktopSearchProfileResponse(PassthroughModel):
    artist_name: str | None = None
    platform: str | None = None
    url: str | None = None


class DesktopSearchResponse(PassthroughModel):
    response_profile: Literal["desktop"]
    projection_truncated: bool | None = None
    candidate_limit: int | None = None
    sources: list[DesktopSearchSourceResponse] | None = None
    related_profiles: list[DesktopSearchProfileResponse] | None = None


class SearchResponse(PassthroughModel):
    """legacy 搜索结果：来源结果按原样透传。"""

    keyword: str | None = None
    source_count: int | None = None
    address_count: int | None = None
    weak_evidence_count: int | None = None
    sources: list[Any] | None = None
    related_profiles: list[Any] | None = None
    enrichment_errors: list[Any] | None = None
    selection_contract: dict[str, Any] | None = None
    tag_filter_contract: dict[str, Any] | None = None


__all__ = [
    "CrawlBatchListResponse",
    "CrawlBatchOperationResponse",
    "CrawlBatchResponse",
    "CrawlTaskListResponse",
    "DesktopSearchResponse",
    "SearchAutocompleteResponse",
    "SearchResponse",
    "SearchSiteListResponse",
    "TaskEventListResponse",
    "TaskFileListResponse",
    "TaskListResponse",
    "TaskLogListResponse",
    "TaskResponse",
]
