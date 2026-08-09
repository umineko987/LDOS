"""FastAPI router factories used by the application composition root."""

from .auth import create_auth_router
from .diagnostics import create_diagnostics_router
from .proxy import create_proxy_router
from .scheduler import create_scheduler_router
from .tasks import create_ordered_task_enqueuer, create_tasks_router

__all__ = [
    "create_auth_router",
    "create_diagnostics_router",
    "create_ordered_task_enqueuer",
    "create_proxy_router",
    "create_scheduler_router",
    "create_tasks_router",
]
