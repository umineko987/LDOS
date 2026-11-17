from __future__ import annotations

import argparse
import os
import sys
import threading
from collections.abc import Callable
from functools import partial
from pathlib import Path
from typing import Any, BinaryIO

import uvicorn

from .app import create_app
from .config import AppSettings, PROJECT_DIR


# SSE 长连接不会自行结束；uvicorn 关停时先等连接，超过这个时限才取消请求并执行 lifespan 收尾。
GRACEFUL_SHUTDOWN_SECONDS = 3


def _close_event_streams(app: Any) -> None:
    container = getattr(getattr(app, "state", None), "container", None)
    events = getattr(container, "events", None)
    if events is not None:
        events.close()


def _watch_parent_pipe(
    server: uvicorn.Server,
    stream: BinaryIO,
    on_exit: Callable[[], None] | None = None,
) -> None:
    try:
        stream.read()
    except (OSError, ValueError):
        pass
    if on_exit is not None:
        try:
            on_exit()
        except Exception:
            pass
    server.should_exit = True


def _run_server(settings: AppSettings, parent_stream: BinaryIO | None = None) -> None:
    app = create_app(settings)
    options = {
        "host": settings.server.host,
        "port": settings.server.port,
        "log_level": "info",
        "timeout_graceful_shutdown": GRACEFUL_SHUTDOWN_SECONDS,
    }
    if parent_stream is None:
        uvicorn.run(app, **options)
        return

    server = uvicorn.Server(uvicorn.Config(app, **options))
    threading.Thread(
        target=_watch_parent_pipe,
        # 桌面端要求退出时先结束 SSE 流，uvicorn 就不必等到超时。
        args=(server, parent_stream, partial(_close_event_streams, app)),
        name="gdl-backend-parent-pipe",
        daemon=True,
    ).start()
    server.run()


def main() -> None:
    os.umask(0o077)
    parser = argparse.ArgumentParser(description="gallery-dl + native proxy backend")
    parser.add_argument("--config", help="JSON 配置文件路径")
    parser.add_argument("--host", help="覆盖监听地址")
    parser.add_argument("--port", type=int, help="覆盖监听端口")
    args = parser.parse_args()
    requested_config = args.config or os.environ.get("GDL_BACKEND_CONFIG")
    config_path = (
        Path(requested_config).expanduser().resolve()
        if requested_config
        else (PROJECT_DIR / "config.json")
    )
    if not config_path.is_file():
        parser.error(
            f"配置文件不存在：{config_path}；请先从仓库根目录运行 "
            "./scripts/setup-linux.sh --device cpu，或复制 config.example.json 后用 --config 指定"
        )
    settings = AppSettings.load(config_path)
    if args.host:
        settings.server.host = args.host
    if args.port:
        settings.server.port = args.port
    settings.validate()
    parent_stream = (
        sys.stdin.buffer
        if os.environ.get("GDL_BACKEND_PARENT_PIPE") == "1"
        else None
    )
    _run_server(settings, parent_stream)


if __name__ == "__main__":
    main()
