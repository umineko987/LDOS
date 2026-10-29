"""代理池 / 站点授权 / 站点设置路由的响应模型。

沿用 passthrough_models 的做法：模型只把字段写进 OpenAPI，不改写负载
（extra="allow"、strict=True、路由配 response_model_exclude_unset=True）。

这三组路由都按 view 参数换形状：

- desktop / vault / policy 投影由路由显式构造，键总是齐全，模型写成必填，
  前端拿到的类型不带多余的可选；
- legacy 负载来自运行时对象，模型全部可选、可空，只作说明。新前端应当
  使用投影视图（legacy 代理状态里的节点行带有打码后的 endpoint 等工程信息）。

联合类型里投影模型在前：它们带必填字段（多数还有 response_profile 字面量），
legacy 负载验证不过时落到宽松的 legacy 模型，输出都是原样透传。
"""

from __future__ import annotations

from typing import Any, Literal

from .passthrough_models import Number, PassthroughModel


# ---- 代理池：desktop 投影 ----


class DesktopProxyNode(PassthroughModel):
    id: str
    name: str
    protocol: str
    endpoint: str
    tags: list[str]
    healthy: bool
    retry_eligible: bool
    ref_count: int | None
    success_count: int | None
    fail_count: int | None
    last_latency_ms: Number | None
    cooldown_until: Number | None
    last_error: str


class DesktopProxyTransportCore(PassthroughModel):
    enabled: bool | None = None
    running: bool | None = None
    listeners: int | None = None
    last_error: str | None = None


class DesktopProxySourceSummary(PassthroughModel):
    subscriptions: int | None = None
    source_nodes: int | None = None
    pool_nodes: int | None = None
    core_candidates: int | None = None
    core_nodes: int | None = None
    skipped_nodes: int | None = None
    warnings: list[str]


class DesktopProxyStatus(PassthroughModel):
    response_profile: Literal["desktop-proxy-v1"]
    enabled: bool | None
    engine: str | None
    managed_by_backend: bool | None
    auto_start: bool | None
    running: bool | None
    total: int | None
    healthy: int | None
    retry_eligible: int | None
    leases: int | None
    configured_revision: str | None
    active_revision: str | None
    reload_required: bool | None
    last_error: str
    transport_core: DesktopProxyTransportCore
    sources: DesktopProxySourceSummary
    nodes: list[DesktopProxyNode]
    node_rows_total: int
    node_rows_truncated: bool


class DesktopProxySubscription(PassthroughModel):
    id: str
    source: str
    scheme: str
    host: str
    port: int | None
    credentials_redacted: bool
    sensitive_parts_redacted: bool


class DesktopProxyNodeFile(PassthroughModel):
    configured: bool
    source: str
    display_path: str | None


class DesktopProxyInlineNode(PassthroughModel):
    id: str
    source: str
    scheme: str
    name: str
    host: str
    port: int | None
    requires_transport_core: bool


class DesktopProxySourceCounts(PassthroughModel):
    subscriptions: int | None = None
    node_file: int | None = None
    inline_nodes: int | None = None
    total: int | None = None


class DesktopProxySources(PassthroughModel):
    response_profile: Literal["desktop-proxy-sources-v1"]
    source: str
    has_runtime_override: bool
    runtime_override_valid: bool
    configured_revision: str
    active_revision: str | None
    reload_required: bool
    subscriptions: list[DesktopProxySubscription]
    node_file: DesktopProxyNodeFile
    inline_nodes: list[DesktopProxyInlineNode]
    counts: DesktopProxySourceCounts
    subscription_rows_truncated: bool
    inline_node_rows_truncated: bool


class DesktopProxyOperation(PassthroughModel):
    """desktop 视图下的写操作只回执；调用方随后重拉状态。"""

    response_profile: Literal["desktop-proxy-operation-v1"]


# ---- 代理池：legacy 负载 ----


class LegacyProxyStatus(PassthroughModel):
    enabled: bool | None = None
    engine: str | None = None
    managed_by_backend: bool | None = None
    auto_start: bool | None = None
    executable_required: bool | None = None
    running: bool | None = None
    configured_revision: str | None = None
    active_revision: str | None = None
    reload_required: bool | None = None
    total: int | None = None
    healthy: int | None = None
    retry_eligible: int | None = None
    leases: int | None = None
    last_error: str | None = None
    transport_core: dict[str, Any] | None = None
    sources: dict[str, Any] | None = None
    probe_cache: dict[str, Any] | None = None
    nodes: list[dict[str, Any]] | None = None
    health_loop: dict[str, Any] | None = None


class LegacyProxySources(PassthroughModel):
    source: str | None = None
    has_runtime_override: bool | None = None
    runtime_override_valid: bool | None = None
    configured_revision: str | None = None
    active_revision: str | None = None
    reload_required: bool | None = None
    subscriptions: list[dict[str, Any]] | None = None
    node_file: dict[str, Any] | None = None
    inline_nodes: list[dict[str, Any]] | None = None
    counts: dict[str, Any] | None = None


class LegacyProxyProbe(PassthroughModel):
    total: int | None = None
    healthy: int | None = None
    results: list[dict[str, Any]] | None = None
    target: str | None = None
    cached: bool | None = None
    age_seconds: Number | None = None


ProxyStatusResponse = DesktopProxyStatus | LegacyProxyStatus
ProxySourcesResponse = DesktopProxySources | LegacyProxySources
ProxySourceChangeResponse = DesktopProxyOperation | LegacyProxySources
ProxyLifecycleResponse = DesktopProxyOperation | LegacyProxyStatus
ProxyProbeResponse = DesktopProxyOperation | LegacyProxyProbe


# ---- 站点授权：vault 投影 ----


VaultSessionState = Literal[
    "starting", "starting_browser", "awaiting_login", "awaiting_code", "exchanging",
    "authorized", "cancelled", "timed_out", "failed", "token_ready",
]
AuthSite = Literal["danbooru", "twitter", "pixiv", "exhentai", "pawchive"]


class VaultSession(PassthroughModel):
    session_id: str
    state: VaultSessionState
    created_at: Number | None
    expires_at: Number | None
    site: AuthSite | None = None
    cookie_count: int | None = None


class VaultCookies(PassthroughModel):
    present: bool
    valid: bool
    cookie_count: int
    updated_at: Number | None


class VaultSiteStatus(PassthroughModel):
    site: AuthSite
    label: str
    method: Literal["anonymous", "managed_browser", "oauth"]
    state: Literal["ready", "authorized", "authorizing", "required"]
    authorized: bool
    summary: str
    updated_at: Number | None
    invalidated_at: Number | None
    actions: list[str]
    browser: Literal["project_chrome"] | None = None
    profile: Literal["shared"] | None = None
    cookies: VaultCookies | None = None
    login: VaultSession | None = None
    oauth: VaultSession | None = None


class VaultProxyStatus(PassthroughModel):
    proxy_url: str | None = None  # 打码后的地址
    source: Literal["runtime", "config", "none"]
    credentials_redacted: bool
    browser_running: bool
    restart_pending: bool
    updated_at: Number | None


class VaultBrowserProfile(PassthroughModel):
    shared: bool
    present: bool
    running: bool
    resetting: bool
    sites: list[str]


class VaultBrowserRuntime(PassthroughModel):
    available: bool
    name: str | None
    source: Literal["auto", "configured", "none"]
    message: str


class VaultStatuses(PassthroughModel):
    items: list[VaultSiteStatus]
    browser_profile: VaultBrowserProfile
    authorization_proxy: VaultProxyStatus
    managed: bool
    secrets_exposed: bool
    response_profile: Literal["vault"]


class VaultBrowserResult(PassthroughModel):
    session: VaultSession | None
    status: VaultSiteStatus


class VaultBrowserProfileReset(PassthroughModel):
    browser_profile: VaultBrowserProfile
    auth: VaultStatuses


# ---- 站点授权：legacy 负载 ----


class LegacyAuthStatus(PassthroughModel):
    site: str | None = None
    label: str | None = None
    method: str | None = None
    state: str | None = None
    authorized: bool | None = None
    summary: str | None = None
    actions: list[str] | None = None
    browser: str | None = None
    profile: str | None = None
    # updated_at / invalidated_at 来自元数据文件，类型不保证，不声明（原样透传）。
    cookies: dict[str, Any] | None = None
    login: dict[str, Any] | None = None
    oauth: dict[str, Any] | None = None


class LegacyAuthStatuses(PassthroughModel):
    items: list[dict[str, Any]] | None = None
    browser_profile: dict[str, Any] | None = None
    authorization_proxy: dict[str, Any] | None = None
    managed: bool | None = None
    secrets_exposed: bool | None = None


class LegacyAuthProxyStatus(PassthroughModel):
    proxy_url: str | None = None
    source: str | None = None
    config_proxy_url: str | None = None
    credentials_redacted: bool | None = None
    browser_running: bool | None = None
    browser_proxy_url: str | None = None
    restart_pending: bool | None = None


class LegacyBrowserRuntime(PassthroughModel):
    available: bool | None = None
    name: str | None = None
    source: str | None = None
    message: str | None = None


class LegacyBrowserLoginResult(PassthroughModel):
    session: dict[str, Any] | None = None
    status: dict[str, Any] | None = None


class LegacyPixivSession(PassthroughModel):
    session_id: str | None = None
    state: str | None = None
    message: str | None = None
    authorization_url: str | None = None
    created_at: Number | None = None
    expires_at: Number | None = None
    error: str | None = None


class LegacyBrowserProfileReset(PassthroughModel):
    browser_profile: dict[str, Any] | None = None
    auth: dict[str, Any] | None = None


AuthStatusesResponse = VaultStatuses | LegacyAuthStatuses
AuthSiteResponse = VaultSiteStatus | LegacyAuthStatus
AuthProxyResponse = VaultProxyStatus | LegacyAuthProxyStatus
AuthBrowserRuntimeResponse = VaultBrowserRuntime | LegacyBrowserRuntime
AuthBrowserLoginResponse = VaultBrowserResult | LegacyBrowserLoginResult
AuthPixivStartResponse = VaultSession | LegacyPixivSession | None
AuthBrowserProfileResetResponse = VaultBrowserProfileReset | LegacyBrowserProfileReset


# ---- 站点设置 ----


class PolicyFields(PassthroughModel):
    max_concurrency: int
    retry_limit: int
    backoff_base_seconds: Number
    proxy_mode: Literal["direct", "prefer", "required"]


class PolicyState(PassthroughModel):
    editable: bool
    reason: str
    policy: PolicyFields | None


class PolicyViewItem(PassthroughModel):
    site: str
    label: str
    supported: bool
    authorization: str
    selection_mode: str
    availability: str
    inherited: bool
    has_override: bool
    editable: bool
    reason: str
    updated_at: Number | None
    policy: PolicyFields | None


class PolicyViewSnapshot(PassthroughModel):
    response_profile: Literal["policy"]
    secrets_exposed: bool
    effect_scope: str
    concurrency_protection: str
    default_source: str
    persistence: str
    default: PolicyState
    items: list[PolicyViewItem]
    unknown_override_count: int


class LegacySitePolicy(PassthroughModel):
    site: str | None = None
    policy: PolicyFields | None = None
    updated_at: Number | None = None
    inherited: bool | None = None


class LegacySitePolicies(PassthroughModel):
    default: PolicyFields | None = None
    items: list[LegacySitePolicy] | None = None


class SitePolicyDeleted(PassthroughModel):
    response_profile: Literal["policy"] | None = None  # 仅 policy 视图
    deleted: bool
    site: str


SitePoliciesResponse = PolicyViewSnapshot | LegacySitePolicies
SitePolicyResponse = PolicyViewItem | LegacySitePolicy
