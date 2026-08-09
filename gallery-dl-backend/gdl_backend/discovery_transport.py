from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Generic, TypeVar
from urllib.parse import urlsplit

from .discovery_contracts import DiscoveryError
from .encrypted_dns import (
    EncryptedDNSError,
    NetworkTargetValidator,
    validate_network_target_syntax,
)
from .file_security import ensure_private_directory
from .gallery import GalleryRunner
from .proxy import ProxyLease, ProxyPoolAdapter, ProxyPoolUnavailable
from .redaction import redact_text
from .schemas import ProxyMode, SitePolicy


T = TypeVar("T")
SessionFactory = Callable[[], Any]
AttemptOperation = Callable[["DiscoveryAttempt"], Awaitable[T]]
AttemptClassifier = Callable[[Exception, "DiscoveryAttempt"], "AttemptFailure"]
AttemptCleanup = Callable[["DiscoveryAttempt"], Awaitable[None] | None]


@dataclass(frozen=True, slots=True)
class HttpJsonResponse:
    status_code: int
    text: str
    payload: Any
    json_error: Exception | None
    raw_response: Any


class DiscoveryHttpSession:
    """One bounded HTTP session using the transport's injected client factory."""

    def __init__(
        self,
        factory: SessionFactory,
        *,
        backend: str,
        proxy_url: str | None,
    ) -> None:
        self._factory = factory
        self._backend = backend
        self._proxy_url = proxy_url
        self._session: Any = None

    def __enter__(self) -> DiscoveryHttpSession:
        session = self._factory()
        if hasattr(session, "trust_env"):
            session.trust_env = False
        headers = getattr(session, "headers", None)
        if headers is not None:
            headers["User-Agent"] = "gallery-dl-backend/0.3"
        self._session = session
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        close = getattr(self._session, "close", None)
        if callable(close):
            close()
        self._session = None

    def request_json(
        self,
        method: str,
        url: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        timeout: float,
        text_limit: int = 4000,
        default_status_code: int = 200,
        parse_json: bool = True,
    ) -> HttpJsonResponse:
        if self._session is None:
            raise RuntimeError("HTTP session is not active")
        kwargs: dict[str, Any] = {
            "timeout": max(1.0, float(timeout)),
            "allow_redirects": False,
            "verify": True,
        }
        if params is not None:
            kwargs["params"] = params
        if json_body is not None:
            kwargs["json"] = json_body
        if self._backend == "curl":
            kwargs["proxy"] = self._proxy_url
        elif self._backend == "requests":
            kwargs["proxies"] = (
                {"http": self._proxy_url, "https": self._proxy_url}
                if self._proxy_url
                else None
            )
        else:
            raise ValueError(f"unsupported discovery HTTP backend: {self._backend}")
        request = getattr(self._session, str(method).lower())
        response = request(url, **kwargs)
        status_code = int(
            getattr(response, "status_code", default_status_code) or 0
        )
        text = str(getattr(response, "text", "") or "")[: max(0, int(text_limit))]
        if parse_json:
            try:
                payload = response.json()
                json_error = None
            except Exception as exc:
                payload = None
                json_error = exc
        else:
            payload = None
            json_error = None
        return HttpJsonResponse(
            status_code,
            text,
            payload,
            json_error,
            response,
        )


@dataclass(frozen=True, slots=True)
class DiscoveryAttempt:
    operation_id: str
    attempt: int
    mode: ProxyMode
    lease: ProxyLease | None
    proxy: dict[str, Any]


class AttemptFailure(RuntimeError):
    """Source-owned classification consumed by the shared retry boundary."""

    def __init__(
        self,
        message: str,
        *,
        error_class: str = "backend_error",
        retryable: bool = False,
        proxy_fault: bool = False,
        auth_context: str = "",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.error_class = error_class
        self.retryable = retryable
        self.proxy_fault = proxy_fault
        self.auth_context = auth_context
        self.details = dict(details or {})


class AttemptsExhausted(RuntimeError):
    def __init__(
        self,
        failure: AttemptFailure,
        *,
        attempts: int,
        proxy: dict[str, Any],
    ) -> None:
        super().__init__(failure.message)
        self.failure = failure
        self.attempts = attempts
        self.proxy = proxy


@dataclass(frozen=True, slots=True)
class TransportResult(Generic[T]):
    value: T
    attempts: int
    proxy: dict[str, Any]


class _StaticNetworkTargetValidator:
    """Fallback only for directly constructed test services; production injects one."""

    @staticmethod
    def validate_static(url: str) -> Any:
        return validate_network_target_syntax(url, False)

    def validate_direct(self, url: str) -> tuple[str, ...]:
        self.validate_static(url)
        return ()

    def validate_proxy(self, url: str, lease: ProxyLease) -> tuple[str, ...]:
        self.validate_static(url)
        raise EncryptedDNSError(
            "encrypted_dns_unavailable",
            "代理搜索缺少加密 DNS 校验器，已拒绝连接",
            retryable=False,
            proxy_fault=False,
        )


class DiscoveryTransport:
    """Injected execution boundary shared by all discovery source adapters."""

    def __init__(
        self,
        gallery: GalleryRunner,
        proxy: ProxyPoolAdapter,
        runtime_dir: Path,
        *,
        network_validator: NetworkTargetValidator | None = None,
        auth_failure_callback: Callable[[str, str | None, str], Awaitable[bool]] | None = None,
        requests_session_factory: SessionFactory,
        curl_session_factory: SessionFactory,
    ) -> None:
        self.gallery = gallery
        self.proxy = proxy
        self.runtime_dir = Path(os.path.abspath(os.fspath(runtime_dir / "discovery")))
        ensure_private_directory(self.runtime_dir)
        self.network_validator = network_validator or _StaticNetworkTargetValidator()
        self.auth_failure_callback = auth_failure_callback
        self._requests_session_factory = requests_session_factory
        self._curl_session_factory = curl_session_factory

    @staticmethod
    def proxy_metadata(mode: ProxyMode, lease: ProxyLease | None) -> dict[str, Any]:
        if lease is None:
            return {
                "mode": mode,
                "used": False,
                "node_id": None,
                "node_name": None,
                "protocol": None,
            }
        endpoint = str(lease.endpoint or "")
        parsed = urlsplit(endpoint)
        secrets = tuple(
            value
            for value in (
                endpoint,
                parsed.netloc,
                parsed.hostname,
                str(parsed.port) if parsed.port is not None else "",
            )
            if value
        )
        return {
            "mode": mode,
            "used": True,
            "node_id": redact_text(lease.node_id, secrets=secrets, limit=128),
            "node_name": redact_text(lease.name, secrets=secrets, limit=200),
            "protocol": redact_text(lease.protocol, secrets=secrets, limit=50),
        }

    def network_error(
        self,
        error: EncryptedDNSError,
        *,
        mode: ProxyMode,
        lease: ProxyLease | None,
        attempts: int,
    ) -> DiscoveryError:
        return DiscoveryError(
            error.code,
            error.message,
            details={
                "attempts": attempts,
                "proxy": self.proxy_metadata(mode, lease),
            },
        )

    async def validate_direct(self, url: str) -> tuple[str, ...]:
        try:
            result = await asyncio.to_thread(self.network_validator.validate_direct, url)
        except EncryptedDNSError as exc:
            raise self.network_error(
                exc,
                mode="direct",
                lease=None,
                attempts=0,
            ) from exc
        except ValueError as exc:
            raise DiscoveryError(
                "invalid_network_target",
                redact_text(exc, limit=500),
                details={
                    "attempts": 0,
                    "proxy": self.proxy_metadata("direct", None),
                },
            ) from exc
        return tuple(result or ())

    async def validate_proxy(self, url: str, lease: ProxyLease) -> tuple[str, ...]:
        result = await asyncio.to_thread(
            self.network_validator.validate_proxy,
            url,
            lease,
        )
        return tuple(result or ())

    def http_session(
        self,
        *,
        backend: str,
        proxy_url: str | None,
    ) -> DiscoveryHttpSession:
        factory = (
            self._curl_session_factory
            if backend == "curl"
            else self._requests_session_factory
        )
        return DiscoveryHttpSession(
            factory,
            backend=backend,
            proxy_url=proxy_url,
        )

    async def run_http(self, operation: Callable[[], T]) -> T:
        return await asyncio.to_thread(operation)

    async def capture(self, operation_id: str, **kwargs: Any) -> Any:
        return await self.gallery.capture(operation_id, **kwargs)

    def operation_directory(self, operation_id: str) -> Path:
        return self.runtime_dir / operation_id

    def cleanup_operation_directory(self, operation_id: str) -> None:
        operation_dir = self.operation_directory(operation_id)
        if (
            operation_dir.parent == self.runtime_dir
            and operation_dir.name.startswith("discover-")
        ):
            shutil.rmtree(operation_dir, ignore_errors=True)

    async def notify_auth_failure(
        self,
        site: str,
        cookies_file: str | None,
        context: str,
    ) -> None:
        if self.auth_failure_callback is None:
            return
        try:
            await self.auth_failure_callback(site, cookies_file, context)
        except Exception:
            pass

    async def acquire_lease(
        self,
        operation_id: str,
        *,
        mode: ProxyMode,
        policy: SitePolicy,
        tried: set[str],
        node_tags: list[str],
        fallback_node_tags: list[str] | None,
        secure_target: bool,
        acquire_error_fatal: bool,
        attempt: int,
        last_proxy: dict[str, Any],
        required_message: str,
    ) -> ProxyLease | None:
        if mode == "direct":
            return None
        try:
            lease = await asyncio.to_thread(
                self.proxy.acquire,
                operation_id,
                node_tags=node_tags,
                exclude_ids=tried,
                allowed_ids=getattr(policy, "allowed_proxy_ids", None),
                probe_before_use=policy.probe_before_use,
                probe_url=policy.probe_url,
            )
            if lease is None and fallback_node_tags is not None:
                lease = await asyncio.to_thread(
                    self.proxy.acquire,
                    operation_id,
                    node_tags=fallback_node_tags,
                    exclude_ids=tried,
                    allowed_ids=getattr(policy, "allowed_proxy_ids", None),
                    probe_before_use=policy.probe_before_use,
                    probe_url=policy.probe_url,
                )
        except ProxyPoolUnavailable as exc:
            raise DiscoveryError(
                "proxy_unavailable",
                "代理不可用，已终止（不会回退直连）",
                details={"attempts": attempt, "proxy": last_proxy},
            ) from exc
        except Exception as exc:
            if acquire_error_fatal:
                raise DiscoveryError(
                    "proxy_unavailable",
                    "代理租约获取失败，已拒绝回退直连",
                    details={"attempts": attempt, "proxy": last_proxy},
                ) from exc
            return None
        if lease is None and secure_target:
            raise DiscoveryError(
                "proxy_dns_failed",
                "当前没有可用于代理 DNS 校验的健康节点，已拒绝回退直连",
                details={"attempts": attempt, "proxy": last_proxy},
            )
        if lease is None and mode == "required":
            raise DiscoveryError(
                "proxy_unavailable",
                required_message,
                details={"attempts": attempt, "proxy": last_proxy},
            )
        return lease

    async def release_lease(
        self,
        attempt: DiscoveryAttempt,
        *,
        proxy_fault: bool,
        reason: str,
    ) -> None:
        lease = attempt.lease
        if lease is None:
            return
        endpoint = str(lease.endpoint or "")
        parsed = urlsplit(endpoint)
        secrets = tuple(
            value
            for value in (
                endpoint,
                parsed.netloc,
                parsed.hostname,
                str(parsed.port) if parsed.port is not None else "",
            )
            if value
        )
        safe_reason = redact_text(reason, secrets=secrets, limit=1000) if proxy_fault else ""
        try:
            await asyncio.to_thread(
                self.proxy.release,
                attempt.operation_id,
                proxy_fault=proxy_fault,
                reason=safe_reason,
            )
        except Exception:
            pass

    async def execute_with_retries(
        self,
        *,
        target_url: str,
        policy: SitePolicy,
        proxy_mode: ProxyMode | None,
        operation_prefix: str,
        secure_target: bool,
        operation: AttemptOperation[T],
        classify_exception: AttemptClassifier,
        node_tags: list[str] | None = None,
        fallback_node_tags: list[str] | None = None,
        acquire_error_fatal: bool = True,
        required_lease_message: str = "当前没有符合站点策略的健康代理节点",
        direct_target_prevalidated: bool = False,
        cleanup: AttemptCleanup | None = None,
    ) -> TransportResult[T]:
        mode: ProxyMode = proxy_mode or policy.proxy_mode
        attempts = max(1, policy.retry_limit + 1)
        tried: set[str] = set()
        last_proxy = self.proxy_metadata(mode, None)
        last_failure = AttemptFailure("搜索任务没有返回结果", retryable=False)

        if secure_target and mode == "direct" and not direct_target_prevalidated:
            await self.validate_direct(target_url)

        for attempt_number in range(1, attempts + 1):
            operation_id = f"{operation_prefix}-{uuid.uuid4().hex}"
            lease = await self.acquire_lease(
                operation_id,
                mode=mode,
                policy=policy,
                tried=tried,
                node_tags=list(policy.node_tags if node_tags is None else node_tags),
                fallback_node_tags=fallback_node_tags,
                secure_target=secure_target,
                acquire_error_fatal=acquire_error_fatal,
                attempt=attempt_number,
                last_proxy=last_proxy,
                required_message=required_lease_message,
            )
            current = DiscoveryAttempt(
                operation_id=operation_id,
                attempt=attempt_number,
                mode=mode,
                lease=lease,
                proxy=self.proxy_metadata(mode, lease),
            )
            last_proxy = current.proxy
            failure: AttemptFailure | None = None
            dns_error: EncryptedDNSError | None = None
            try:
                if secure_target and lease is not None:
                    await self.validate_proxy(target_url, lease)
                value = await operation(current)
                return TransportResult(value, attempt_number, current.proxy)
            except EncryptedDNSError as exc:
                dns_error = exc
                failure = AttemptFailure(
                    exc.message,
                    error_class="proxy_error" if exc.proxy_fault else "network_target",
                    retryable=exc.retryable,
                    proxy_fault=bool(lease is not None and exc.proxy_fault),
                )
                if not failure.proxy_fault:
                    raise self.network_error(
                        exc,
                        mode=mode,
                        lease=lease,
                        attempts=attempt_number,
                    ) from exc
            except DiscoveryError:
                raise
            except AttemptFailure as exc:
                failure = exc
            except Exception as exc:
                failure = classify_exception(exc, current)
            finally:
                if failure is not None and failure.proxy_fault and lease is not None:
                    tried.add(lease.node_id)
                await self.release_lease(
                    current,
                    proxy_fault=bool(failure and failure.proxy_fault),
                    reason=failure.message if failure is not None else "",
                )
                if cleanup is not None:
                    cleanup_result = cleanup(current)
                    if asyncio.iscoroutine(cleanup_result):
                        await cleanup_result

            if failure is None:
                raise RuntimeError("discovery transport lost the attempt result")
            last_failure = failure
            if not failure.retryable or attempt_number >= attempts:
                if dns_error is not None:
                    raise self.network_error(
                        dns_error,
                        mode=mode,
                        lease=lease,
                        attempts=attempt_number,
                    ) from dns_error
                break
            delay = policy.backoff_base_seconds * (2 ** max(0, attempt_number - 1))
            if delay:
                await asyncio.sleep(min(delay, 10.0))

        raise AttemptsExhausted(
            last_failure,
            attempts=attempts,
            proxy=last_proxy,
        )
