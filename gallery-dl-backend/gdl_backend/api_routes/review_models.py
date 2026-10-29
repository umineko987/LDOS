"""爬取审核 / 图库审核 / 筛选预设路由的响应模型。

沿用 passthrough_models 的做法：模型只把字段写进 OpenAPI，不改写负载
（extra="allow"、strict=True、路由配 response_model_exclude_unset=True）。

- desktop 投影由 review._desktop_review_response 显式构造，键总是齐全，模型写成必填；
- 图库审核在 desktop 投影上去掉 batch_id、补上审核身份和筛选配置，图片行
  额外带上绑定的图库资产；
- legacy 负载直接是数据库行，只声明列类型确定的字段，全部可选。

联合类型里投影模型在前：它带必填字段和 response_profile 字面量，legacy 负载
验证不过时落到宽松的 legacy 模型，输出都是原样透传。
"""

from __future__ import annotations

from typing import Any, Literal

from .passthrough_models import Number, PassthroughModel


# ---- 筛选配置 ----


class ReviewFilterOptions(PassthroughModel):
    basic_dedup: bool
    filter_monochrome: bool
    filter_sketch: bool
    filter_character: bool
    similarity_groups: bool
    reference_asset_ids: list[str]


class ReviewFilterConfig(PassthroughModel):
    preset_name: str
    options: ReviewFilterOptions


class ReviewPreset(PassthroughModel):
    id: str
    name: str
    builtin: bool
    options: ReviewFilterOptions


class ReviewPresetList(PassthroughModel):
    items: list[ReviewPreset]


# ---- desktop 投影 ----


class DesktopReviewImageMetadata(PassthroughModel):
    w: int
    h: int
    classification: Literal["rough", "monochrome"] | None = None


class DesktopReviewImage(PassthroughModel):
    id: str
    ordinal: int
    readable: bool
    recommended: bool
    selected: bool
    metadata: DesktopReviewImageMetadata
    # 只出现在图库审核里：图片绑定的图库资产和预览地址。
    asset_id: str | None = None
    source_id: str | None = None
    directory_id: str | None = None
    relative_path: str | None = None
    source_display_name: str | None = None
    disposition: str | None = None
    hasError: bool | None = None
    url: str | None = None


class DesktopReviewGroup(PassthroughModel):
    id: str
    ordinal: int
    kind: str
    decided: bool
    images: list[DesktopReviewImage]


class DesktopReviewGroupPage(PassthroughModel):
    items: list[DesktopReviewGroup]
    byte_truncated: bool
    total: int
    limit: int
    offset: int


class _DesktopReviewSummary(PassthroughModel):
    response_profile: str
    status: str
    totalImageCount: int
    totalGroupCount: int
    duplicateGroupCount: int
    unreadableImageCount: int
    automaticGroupCount: int
    automaticRejectedImageCount: int
    selectedImageCount: int
    decidedGroupCount: int
    keptImageCount: int
    rejectedImageCount: int
    failedImageCount: int
    hasError: bool


class DesktopCrawlReviewOperation(_DesktopReviewSummary):
    response_profile: Literal["desktop-review-operation-v1"]
    batch_id: str


class DesktopCrawlReview(_DesktopReviewSummary):
    response_profile: Literal["desktop-review-v1"]
    batch_id: str
    groups: DesktopReviewGroupPage


class GalleryReviewDirectory(PassthroughModel):
    directory_id: str | None = None
    source_id: str | None = None
    source_display_name: str | None = None
    relative_path: str | None = None
    name: str | None = None


class DesktopGalleryReviewOperation(_DesktopReviewSummary):
    response_profile: Literal["desktop-gallery-review-operation-v1"]
    review_id: str
    version: int
    directories: list[GalleryReviewDirectory]
    created_at: Number
    updated_at: Number
    filter_config: ReviewFilterConfig | None
    filteredImageCount: int


class DesktopGalleryReview(DesktopGalleryReviewOperation):
    response_profile: Literal["desktop-gallery-review-v1"]
    groups: DesktopReviewGroupPage


# ---- legacy 爬取审核 ----


class LegacyCrawlReviewImage(PassthroughModel):
    id: str | None = None
    group_id: str | None = None
    ordinal: int | None = None
    relative_path: str | None = None
    file_hash: str | None = None
    metadata: dict[str, Any] | None = None
    readable: bool | None = None
    recommended: bool | None = None
    selected: bool | None = None
    disposition: str | None = None
    final_relative_path: str | None = None
    error: str | None = None
    url: str | None = None


class LegacyCrawlReviewGroup(PassthroughModel):
    id: str | None = None
    ordinal: int | None = None
    kind: str | None = None
    match_levels: list[Any] | None = None
    reason: str | None = None
    decided: bool | None = None
    images: list[LegacyCrawlReviewImage] | None = None
    image_count: int | None = None
    selected_image_count: int | None = None


class LegacyCrawlReviewGroupPage(PassthroughModel):
    items: list[LegacyCrawlReviewGroup] | None = None
    total: int | None = None
    limit: int | None = None
    offset: int | None = None


class LegacyCrawlReview(PassthroughModel):
    batch_id: str | None = None
    status: str | None = None
    total_image_count: int | None = None
    total_group_count: int | None = None
    duplicate_group_count: int | None = None
    unreadable_image_count: int | None = None
    automatic_group_count: int | None = None
    automatic_rejected_image_count: int | None = None
    selected_image_count: int | None = None
    decided_group_count: int | None = None
    kept_image_count: int | None = None
    rejected_image_count: int | None = None
    failed_image_count: int | None = None
    error: str | None = None
    created_at: Number | None = None
    updated_at: Number | None = None
    started_at: Number | None = None
    ready_at: Number | None = None
    applied_at: Number | None = None
    # 只出现在 GET 审核详情里。
    groups: LegacyCrawlReviewGroupPage | None = None


CrawlReviewResponse = DesktopCrawlReview | LegacyCrawlReview
CrawlReviewOperationResponse = DesktopCrawlReviewOperation | LegacyCrawlReview


__all__ = [
    "CrawlReviewOperationResponse",
    "CrawlReviewResponse",
    "DesktopGalleryReview",
    "DesktopGalleryReviewOperation",
    "ReviewPreset",
    "ReviewPresetList",
]
