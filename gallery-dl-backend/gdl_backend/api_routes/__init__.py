"""FastAPI router factories used by the application composition root."""

from .auth import create_auth_router
from .crawls import create_crawls_router
from .diagnostics import create_diagnostics_router
from .discovery import create_discovery_router
from .gallery import create_gallery_router
from .policies import create_policies_router
from .proxy import create_proxy_router
from .review import create_review_router
from .scheduler import create_scheduler_router
from .setup import create_setup_router
from .tagger import create_tagger_router
from .tasks import create_ordered_task_enqueuer, create_tasks_router

__all__ = [
    "create_auth_router",
    "create_crawls_router",
    "create_diagnostics_router",
    "create_discovery_router",
    "create_ordered_task_enqueuer",
    "create_gallery_router",
    "create_policies_router",
    "create_proxy_router",
    "create_review_router",
    "create_scheduler_router",
    "create_setup_router",
    "create_tagger_router",
    "create_tasks_router",
]
