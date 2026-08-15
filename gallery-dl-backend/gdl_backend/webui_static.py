from __future__ import annotations

import os

from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


class WebUIStaticFiles(StaticFiles):
    """Serve WebUI assets with validators and mandatory revalidation."""

    _JAVASCRIPT_CONTENT_TYPE = "text/javascript; charset=utf-8"

    def file_response(
        self,
        full_path: str | os.PathLike[str],
        stat_result: os.stat_result,
        scope: Scope,
        status_code: int = 200,
    ) -> Response:
        response = super().file_response(full_path, stat_result, scope, status_code)
        response.headers["Cache-Control"] = "no-cache"
        if (
            response.status_code != 304
            and os.path.splitext(os.fspath(full_path))[1].lower() == ".js"
        ):
            response.media_type = "text/javascript"
            response.headers["Content-Type"] = self._JAVASCRIPT_CONTENT_TYPE
        return response
