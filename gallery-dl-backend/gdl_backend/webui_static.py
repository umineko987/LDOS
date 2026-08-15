from __future__ import annotations

import os

from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


class WebUIStaticFiles(StaticFiles):
    """Serve WebUI assets with validators and mandatory revalidation."""

    def file_response(
        self,
        full_path: str | os.PathLike[str],
        stat_result: os.stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers["Cache-Control"] = "no-cache"
        return response
