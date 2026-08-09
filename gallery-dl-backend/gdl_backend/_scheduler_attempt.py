from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from ._scheduler_artifacts import ArtifactCatalog
from ._scheduler_decisions import (
    attempt_status,
    parse_task_policy,
    proxy_failure_plan,
    resolve_allowed_proxy_ids,
    upgrade_partial_artifact_failure,
)
from .classifier import FailureDecision, classify_result
from .database import Database
from .gallery import GalleryRunner
from .log_writer import TaskLogWriter
from .proxy import ProxyLease, ProxyPoolAdapter, ProxyPoolUnavailable
from .redaction import redact_text
from .schemas import TaskPolicy


@dataclass(frozen=True)
class AttemptResult:
    attempt_id: str
    attempt_no: int
    task: dict[str, Any] | None
    policy: TaskPolicy | None
    decision: FailureDecision
    exit_code: int | None
    proxy_node_id: str | None


class AttemptExecutor:
    """Coordinate one claimed attempt without owning task dispatch or final state."""

    def __init__(
        self,
        database: Database,
        gallery: GalleryRunner,
        proxy: ProxyPoolAdapter,
        log_writer: TaskLogWriter,
        *,
        artifact_catalog: ArtifactCatalog,
        auth_failure_callback: Callable[
            [str, str | None, str], Awaitable[bool]
        ]
        | None,
        is_stopping: Callable[[], bool],
        monotonic_clock: Callable[[], float],
    ) -> None:
        self._db = database
        self._gallery = gallery
        self._proxy = proxy
        self._log_writer = log_writer
        self._artifact_catalog = artifact_catalog
        self._auth_failure_callback = auth_failure_callback
        self._is_stopping = is_stopping
        self._monotonic_clock = monotonic_clock

    def _allowed_proxy_ids(self, policy: TaskPolicy) -> set[str] | None:
        probe_node_ids: list[str] | None = None
        if policy.allowed_proxy_ids is None and policy.proxy_probe_scope:
            probe = self._db.get_crawl_address_proxy_probe(
                policy.proxy_probe_scope
            )
            probe_node_ids = probe["node_ids"] if probe is not None else None
        return resolve_allowed_proxy_ids(policy, probe_node_ids)

    async def execute(self, task_id: str) -> AttemptResult:
        attempt_id = ""
        attempt_no = 0
        lease: ProxyLease | None = None
        decision = FailureDecision(
            "backend_error",
            False,
            False,
            "后端任务初始化失败",
        )
        exit_code: int | None = None
        task: dict[str, Any] | None = None
        policy: TaskPolicy | None = None
        auth_failure_context = ""
        task_artifacts: set[Path] = set()
        artifact_progress = {"count": 0, "bytes": 0, "last_write": 0.0}
        try:
            attempt = self._db.begin_attempt(task_id)
            attempt_id = attempt["id"]
            attempt_no = int(attempt["attempt_no"])
            task = attempt["task"]
            policy = parse_task_policy(task)

            async def log(stream: str, line: str) -> None:
                self._log_writer.push(task_id, attempt_id, stream, line)
                if stream == "stdout" and task is not None:
                    artifact = self._artifact_catalog.from_output(
                        line,
                        task["output_dir"],
                    )
                    if artifact is not None and artifact not in task_artifacts:
                        task_artifacts.add(artifact)
                        # Stat only the newly seen file and accumulate, instead of
                        # re-stat'ing the whole set on every output line (that was
                        # O(N²) stats + N DB writes for a multi-file task). Throttle
                        # the DB write to ~1/s; the exact total is recomputed once at
                        # the end of the attempt.
                        size = await asyncio.to_thread(
                            self._artifact_catalog.size,
                            artifact,
                        )
                        if size is not None:
                            artifact_progress["count"] += 1
                            artifact_progress["bytes"] += size
                            now = self._monotonic_clock()
                            if now - artifact_progress["last_write"] >= 1.0:
                                artifact_progress["last_write"] = now
                                await asyncio.to_thread(
                                    self._db.update_artifacts,
                                    task_id,
                                    artifact_progress["count"],
                                    artifact_progress["bytes"],
                                )

            async def started(pid: int, marker: str) -> None:
                self._db.set_process(task_id, attempt_id, pid, marker)

            proxy_mode = task["proxy_mode"]
            if proxy_mode != "direct":
                tried = set(task.get("tried_proxy_ids") or [])
                allowed_proxy_ids = self._allowed_proxy_ids(policy)
                try:
                    lease = await asyncio.to_thread(
                        self._proxy.acquire,
                        task_id,
                        node_tags=policy.node_tags,
                        exclude_ids=tried,
                        allowed_ids=allowed_proxy_ids,
                        probe_before_use=policy.probe_before_use,
                        probe_url=policy.probe_url,
                    )
                except ProxyPoolUnavailable as exc:
                    # A failed proxy core never degrades to direct, including in
                    # prefer mode. The pure plan keeps that policy centralized.
                    plan = proxy_failure_plan(
                        proxy_mode,
                        "pool_unavailable",
                    )
                    decision = FailureDecision(
                        "proxy_unavailable",
                        plan.retryable,
                        plan.proxy_fault,
                        "代理不可用，任务已终止（不会回退直连）："
                        f"{redact_text(exc, limit=500)}",
                    )
                    await log("backend", decision.message)
                    raise _ExecutionFinished
                except Exception as exc:
                    plan = proxy_failure_plan(proxy_mode, "acquire_error")
                    if plan.action == "fail":
                        decision = FailureDecision(
                            "proxy_unavailable",
                            plan.retryable,
                            plan.proxy_fault,
                            "required 模式下代理租约获取失败："
                            f"{redact_text(exc, limit=500)}",
                        )
                        await log("backend", decision.message)
                        raise _ExecutionFinished
                    await log(
                        "backend",
                        "代理池降级，本次任务使用直连："
                        f"{redact_text(exc, limit=500)}",
                    )
                    lease = None
                if lease is not None:
                    public_endpoint = redact_text(lease.endpoint, limit=500)
                    self._db.set_lease(
                        task_id,
                        attempt_id,
                        lease.node_id,
                        public_endpoint,
                        task["site"],
                    )
                    await log(
                        "backend",
                        f"已分配代理节点 {lease.name} ({lease.protocol}) -> "
                        f"{public_endpoint}",
                    )
                else:
                    plan = proxy_failure_plan(proxy_mode, "empty")
                    if plan.action == "fail":
                        decision = FailureDecision(
                            "proxy_unavailable",
                            plan.retryable,
                            plan.proxy_fault,
                            "当前没有符合站点策略的健康代理节点",
                        )
                        await log("backend", decision.message)
                        raise _ExecutionFinished
                    await log(
                        "backend",
                        "代理池当前无可租用节点，本次任务使用直连",
                    )

            current = self._db.get_task(task_id)
            if current and current.get("cancel_requested"):
                decision = FailureDecision(
                    "cancelled",
                    False,
                    False,
                    "任务已取消",
                )
                raise _ExecutionFinished

            extra_args = [*policy.extra_args, *(task.get("extra_args") or [])]
            result = await self._gallery.run(
                task_id,
                url=task["url"],
                output_dir=task["output_dir"],
                proxy_url=lease.endpoint if lease else None,
                http_timeout=policy.http_timeout,
                gallery_retries=policy.gallery_retries,
                task_timeout=policy.task_timeout_seconds,
                stall_timeout=(
                    policy.download_stall_timeout_seconds
                    if task["site"] == "exhentai"
                    else 0.0
                ),
                cookies_file=task.get("cookies_file"),
                config_file=task.get("config_file"),
                credentials_ref=task.get("credentials_ref"),
                extra_args=extra_args,
                on_line=log,
                on_started=started,
                site=task["site"],
                eh_download=policy.eh_download,
            )
            exit_code = result.exit_code
            auth_failure_context = result.output_tail
            latest = self._db.get_task(task_id)
            cancelled = bool(latest and latest.get("cancel_requested"))
            if self._is_stopping() and not cancelled:
                decision = FailureDecision(
                    "backend_shutdown",
                    True,
                    False,
                    "后端停止，任务将重新排队",
                )
            else:
                decision = classify_result(
                    result.exit_code,
                    result.output_tail,
                    cancelled=cancelled,
                    timed_out=result.timed_out,
                )
                # gallery-dl ORs exit bits across files. Saved artifacts turn a
                # terminal extraction error into the existing bounded retry path.
                decision = upgrade_partial_artifact_failure(
                    decision,
                    len(task_artifacts),
                )
        except _ExecutionFinished:
            pass
        except asyncio.CancelledError:
            decision = FailureDecision(
                "backend_shutdown",
                True,
                False,
                "后端停止，任务将重新排队",
            )
        except FileNotFoundError as exc:
            decision = FailureDecision(
                "backend_configuration",
                False,
                False,
                redact_text(exc, limit=1000),
            )
        except ValueError as exc:
            decision = FailureDecision(
                "backend_configuration",
                False,
                False,
                redact_text(exc, limit=1000),
            )
        except Exception as exc:
            decision = FailureDecision(
                "backend_error",
                True,
                False,
                redact_text(exc, limit=1000),
            )
        finally:
            try:
                if lease is not None:
                    await asyncio.to_thread(
                        self._proxy.release,
                        task_id,
                        proxy_fault=decision.proxy_fault,
                        reason=decision.message,
                    )
            except Exception as exc:
                if attempt_id:
                    self._log_writer.push(
                        task_id,
                        attempt_id,
                        "backend",
                        f"释放代理租约异常：{redact_text(exc, limit=500)}",
                    )
            finally:
                if attempt_id:
                    self._db.clear_lease(task_id, attempt_id)

        if (
            decision.error_class == "authentication"
            and task is not None
            and self._auth_failure_callback is not None
        ):
            try:
                invalidated = await self._auth_failure_callback(
                    task["site"],
                    task.get("cookies_file"),
                    auth_failure_context or decision.message,
                )
                if invalidated and attempt_id:
                    self._log_writer.push(
                        task_id,
                        attempt_id,
                        "backend",
                        "托管登录凭证已标记失效；后续排队任务等待重新授权。",
                    )
            except Exception as exc:
                if attempt_id:
                    self._log_writer.push(
                        task_id,
                        attempt_id,
                        "backend",
                        f"更新托管授权状态失败：{redact_text(exc, limit=500)}",
                    )

        if attempt_id:
            await self._log_writer.flush()
            self._db.finish_attempt(
                attempt_id,
                exit_code=exit_code,
                status=attempt_status(decision),
                error_class=decision.error_class,
                error_message=decision.message,
                retryable=decision.retryable,
                proxy_node_id=lease.node_id if lease else None,
                proxy_endpoint=(
                    redact_text(lease.endpoint, limit=500) if lease else None
                ),
            )
            if task is not None and task_artifacts:
                count, total = await asyncio.to_thread(
                    self._artifact_catalog.totals,
                    task_artifacts,
                )
                self._db.update_artifacts(task_id, count, total)

        return AttemptResult(
            attempt_id=attempt_id,
            attempt_no=attempt_no,
            task=task,
            policy=policy,
            decision=decision,
            exit_code=exit_code,
            proxy_node_id=lease.node_id if lease is not None else None,
        )


class _ExecutionFinished(Exception):
    pass
