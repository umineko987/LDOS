from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Literal, Mapping

from .classifier import FailureDecision
from .schemas import TaskPolicy


ProxyAcquireOutcome = Literal["pool_unavailable", "acquire_error", "empty"]
ProxyFailureAction = Literal["fallback_direct", "fail"]
TaskTransition = Literal["cancelled", "succeeded", "requeue", "failed"]
AttemptStatus = Literal["cancelled", "succeeded", "failed"]


@dataclass(frozen=True)
class ProxyFailurePlan:
    action: ProxyFailureAction
    retryable: bool
    proxy_fault: bool


def parse_task_policy(task: Mapping[str, Any]) -> TaskPolicy:
    """Validate the persisted policy without consulting runtime services."""

    return TaskPolicy.model_validate(task.get("policy") or {})


def resolve_allowed_proxy_ids(
    policy: TaskPolicy,
    probe_node_ids: Iterable[str] | None = None,
) -> set[str] | None:
    """Resolve explicit/probed allowlists from data supplied by the caller."""

    if policy.allowed_proxy_ids is not None:
        return set(policy.allowed_proxy_ids)
    if not policy.proxy_probe_scope:
        return None
    return set(probe_node_ids or ())


def proxy_failure_plan(
    proxy_mode: str,
    outcome: ProxyAcquireOutcome,
) -> ProxyFailurePlan:
    """Describe whether an acquisition failure may fall back to direct."""

    if proxy_mode not in {"prefer", "required"}:
        raise ValueError(f"unsupported proxy acquisition mode: {proxy_mode}")
    if outcome == "pool_unavailable":
        return ProxyFailurePlan("fail", retryable=False, proxy_fault=False)
    if proxy_mode == "required":
        return ProxyFailurePlan(
            "fail",
            retryable=True,
            proxy_fault=outcome == "acquire_error",
        )
    return ProxyFailurePlan("fallback_direct", retryable=False, proxy_fault=False)


def upgrade_partial_artifact_failure(
    decision: FailureDecision,
    artifact_count: int,
) -> FailureDecision:
    """Upgrade only a non-retryable extraction failure with saved artifacts."""

    if (
        decision.error_class == "extraction_error"
        and not decision.retryable
        and artifact_count > 0
    ):
        return FailureDecision(
            "extraction_partial",
            True,
            decision.proxy_fault,
            decision.message,
        )
    return decision


def attempt_status(decision: FailureDecision) -> AttemptStatus:
    if decision.error_class == "success":
        return "succeeded"
    if decision.error_class == "cancelled":
        return "cancelled"
    return "failed"


def decide_task_transition(
    decision: FailureDecision,
    *,
    cancel_requested: bool,
    attempt_no: int,
    max_attempts: int,
) -> TaskTransition:
    """Choose the task transition; retryability is bounded by attempt budget."""

    if cancel_requested or decision.error_class == "cancelled":
        return "cancelled"
    if decision.error_class == "success":
        return "succeeded"
    if decision.retryable and attempt_no < max_attempts:
        return "requeue"
    return "failed"


def retry_delay_seconds(
    *,
    base_seconds: float,
    attempt_no: int,
    backoff_anchor_attempt: int,
    cap_seconds: float,
    jitter_seconds: float,
) -> float:
    """Calculate capped exponential backoff from explicit clock-independent data."""

    exponent = max(0, int(attempt_no) - 1 - int(backoff_anchor_attempt or 0))
    delay = min(float(base_seconds) * (2 ** exponent), float(cap_seconds))
    return delay + float(jitter_seconds)


def updated_tried_proxy_ids(
    tried_proxy_ids: Iterable[str],
    *,
    proxy_node_id: str | None,
    proxy_fault: bool,
) -> list[str]:
    tried = list(tried_proxy_ids)
    if proxy_node_id is not None and proxy_fault and proxy_node_id not in tried:
        tried.append(proxy_node_id)
    return tried
