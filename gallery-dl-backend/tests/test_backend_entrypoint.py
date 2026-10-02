from __future__ import annotations

import io
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from gdl_backend import __main__ as backend_entrypoint


class _BlockingStream:
    def __init__(self) -> None:
        self.started = threading.Event()
        self.release = threading.Event()

    def read(self) -> bytes:
        self.started.set()
        self.release.wait(timeout=2)
        return b""


class BackendEntrypointTests(unittest.TestCase):
    def test_parent_pipe_eof_requests_uvicorn_graceful_exit(self) -> None:
        server = SimpleNamespace(should_exit=False)
        stream = _BlockingStream()
        watcher = threading.Thread(
            target=backend_entrypoint._watch_parent_pipe,
            args=(server, stream),
        )
        watcher.start()
        self.assertTrue(stream.started.wait(timeout=1))
        self.assertFalse(server.should_exit)

        stream.release.set()
        watcher.join(timeout=1)

        self.assertFalse(watcher.is_alive())
        self.assertTrue(server.should_exit)

    def test_parent_pipe_read_failure_also_requests_shutdown(self) -> None:
        server = SimpleNamespace(should_exit=False)
        stream = io.BytesIO()
        stream.close()

        backend_entrypoint._watch_parent_pipe(server, stream)

        self.assertTrue(server.should_exit)

    def test_normal_cli_path_keeps_uvicorn_run_contract(self) -> None:
        app = object()
        settings = SimpleNamespace(
            server=SimpleNamespace(host="127.0.0.1", port=8787)
        )
        with (
            patch.object(backend_entrypoint, "create_app", return_value=app),
            patch.object(backend_entrypoint.uvicorn, "run") as run,
            patch.object(backend_entrypoint.uvicorn, "Config") as config,
            patch.object(backend_entrypoint.uvicorn, "Server") as server,
        ):
            backend_entrypoint._run_server(settings)

        run.assert_called_once_with(
            app,
            host="127.0.0.1",
            port=8787,
            log_level="info",
        )
        config.assert_not_called()
        server.assert_not_called()

    def test_desktop_distribution_does_not_mount_a_second_frontend(self) -> None:
        app = object()
        settings = SimpleNamespace(
            server=SimpleNamespace(host="127.0.0.1", port=8787)
        )
        with (
            patch.object(backend_entrypoint, "create_app", return_value=app) as create_app,
            patch.object(backend_entrypoint.uvicorn, "run"),
        ):
            backend_entrypoint._run_server(settings)

        create_app.assert_called_once_with(settings)

    def test_supervised_path_uses_server_and_parent_pipe_watcher(self) -> None:
        app = object()
        config = object()
        settings = SimpleNamespace(
            server=SimpleNamespace(host="127.0.0.1", port=9123)
        )

        class FakeServer:
            should_exit = False

            def run(self) -> None:
                deadline = threading.Event()
                for _ in range(100):
                    if self.should_exit:
                        return
                    deadline.wait(0.01)
                raise AssertionError("parent pipe watcher did not request shutdown")

        fake_server = FakeServer()
        with (
            patch.object(backend_entrypoint, "create_app", return_value=app),
            patch.object(backend_entrypoint.uvicorn, "run") as run,
            patch.object(backend_entrypoint.uvicorn, "Config", return_value=config) as config_type,
            patch.object(backend_entrypoint.uvicorn, "Server", return_value=fake_server) as server_type,
        ):
            backend_entrypoint._run_server(settings, io.BytesIO())

        config_type.assert_called_once_with(
            app,
            host="127.0.0.1",
            port=9123,
            log_level="info",
        )
        server_type.assert_called_once_with(config)
        run.assert_not_called()
        self.assertTrue(fake_server.should_exit)

    def test_main_enables_parent_pipe_only_for_explicit_supervision(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            config_path.write_text("{}", encoding="utf-8")
            settings = Mock()
            settings.server.host = "127.0.0.1"
            settings.server.port = 8787
            with (
                patch.object(sys, "argv", ["gdl-backend", "--config", str(config_path)]),
                patch.dict(os.environ, {"GDL_BACKEND_PARENT_PIPE": "1"}),
                patch.object(backend_entrypoint.AppSettings, "load", return_value=settings),
                patch.object(backend_entrypoint, "_run_server") as run_server,
            ):
                backend_entrypoint.main()

        settings.validate.assert_called_once_with()
        run_server.assert_called_once_with(settings, sys.stdin.buffer)


if __name__ == "__main__":
    unittest.main()
