#!/usr/bin/env python3
"""Run a Linux mygo host against disposable Python state and check shutdown.

This checks the native host/backend lifecycle, not visual behavior or downloads.
Use a source-runtime host build; no real LDOS config or library is loaded.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DESKTOP = ROOT / "desktop"
BACKEND = ROOT / "gallery-dl-backend"


def prepare_config(work: Path, python: Path, port: int) -> Path:
    config = json.loads((BACKEND / "config.example.json").read_text(encoding="utf-8"))
    runtime = work / "runtime"
    credentials = work / "credentials"
    config.update({
        "runtime_dir": str(runtime),
        "database_path": str(runtime / "backend.sqlite3"),
        "default_output_root": str(runtime / "downloads"),
        "allowed_output_roots": [str(runtime / "downloads")],
        "allowed_config_roots": [str(credentials)],
        "allowed_cookie_roots": [str(credentials)],
    })
    config["server"].update(host="127.0.0.1", port=port, cors_origins=["mygo://localhost"])
    config["encrypted_dns"]["enabled"] = False
    config["gallery"].update(
        repo_path=str(ROOT / "gallery-dl-codeberg"),
        cache_file=str(credentials / "managed" / "cache.sqlite3"),
        python_executable=str(python),
        migrate_default_auth=False,
    )
    config["proxy"].update(
        enabled=False, auto_start=False, transport_core_enabled=False,
        allowed_node_roots=[str(work / "subscriptions")],
    )
    config["dedup"].update(enabled=False, model_dir=str(work / "models"))
    destination = work / "backend.json"
    destination.write_text(json.dumps(config), encoding="utf-8")
    destination.chmod(0o600)
    return destination


def session_processes(session: int) -> list[int]:
    """Only consider this smoke's private process session; ignore zombies."""
    result = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            if os.getsid(pid) != session:
                continue
            stat = (entry / "stat").read_text()
            if stat.rsplit(")", 1)[1].split()[0] != "Z":
                result.append(pid)
        except (ProcessLookupError, FileNotFoundError, PermissionError):
            continue
    return result


def port_open(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.2)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def stop_session(session: int) -> None:
    """Failure cleanup is scoped to the process session we created."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for pid in session_processes(session):
            try:
                os.kill(pid, sig)
            except ProcessLookupError:
                pass
        deadline = time.monotonic() + 3
        while session_processes(session) and time.monotonic() < deadline:
            time.sleep(0.1)


def http_json(opener: urllib.request.OpenerDirector, port: int, path: str) -> dict:
    with opener.open(f"http://127.0.0.1:{port}{path}", timeout=1) as response:
        if response.status != 200:
            raise RuntimeError(f"{path}: HTTP {response.status}")
        return json.load(response)


def run(executable: Path, python: Path, timeout: float, hold: float) -> None:
    # Reserve a free loopback port while preparing the private config. The host
    # must bind it after release; a race fails the smoke instead of reusing state.
    with tempfile.TemporaryDirectory(prefix="ldos-mygo-smoke-") as directory:
        work = Path(directory)
        work.chmod(0o700)
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
            config = prepare_config(work, python, port)
        env = os.environ.copy()
        for key in list(env):
            if key.startswith(("GDL_BACKEND_", "LDOS_DESKTOP_")) or key in {"PYTHONHOME", "PYTHONPATH", "MYGO_DEV_URL"}:
                del env[key]
        env.update({
            "HOME": str(work / "home"),
            "XDG_CONFIG_HOME": str(work / "config"),
            "XDG_DATA_HOME": str(work / "data"),
            "XDG_CACHE_HOME": str(work / "cache"),
            "XDG_STATE_HOME": str(work / "state"),
            "GDL_BACKEND_CONFIG": str(config),
            "GDL_BACKEND_HOST": "127.0.0.1",
            "GDL_BACKEND_PORT": str(port),
            "PYTHON": str(python),
            "LDOS_DESKTOP_SOURCE": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        # Keep XDG_RUNTIME_DIR, DISPLAY and Wayland/DBus access for the real GUI.
        for key in ("HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"):
            Path(env[key]).mkdir(parents=True, exist_ok=True)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        log_path = work / "host.log"
        with log_path.open("w+") as log:
            process = subprocess.Popen(
                [str(executable)], cwd=DESKTOP, env=env,
                stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
            )
            try:
                deadline = time.monotonic() + timeout
                while True:
                    if process.poll() is not None:
                        raise RuntimeError(f"host exited before health check: {process.returncode}")
                    try:
                        health = http_json(opener, port, "/healthz")
                        if health.get("ok") is not True:
                            raise RuntimeError("/healthz did not return ok=true")
                        break
                    except (urllib.error.URLError, TimeoutError, ConnectionError):
                        if time.monotonic() >= deadline:
                            raise RuntimeError(f"Go backend did not become healthy within {timeout:g}s")
                        time.sleep(0.2)
                # Prove the responding backend belongs to this host and uses our
                # disposable config, rather than an unrelated listener.
                backend_pids = []
                for pid in session_processes(process.pid):
                    try:
                        args = (Path("/proc") / str(pid) / "cmdline").read_bytes().split(b"\0")
                    except FileNotFoundError:
                        continue
                    if os.path.basename(args[0]) == b"ldos-backend" and os.fsencode(config) in args:
                        backend_pids.append(pid)
                if not backend_pids:
                    raise RuntimeError("healthy listener has no supervised Go backend child with the private config")
                ready = http_json(opener, port, "/readyz")
                if ready.get("ready") is not True:
                    raise RuntimeError("/readyz did not return ready=true with dedup disabled")
                service_info = http_json(opener, port, "/")
                if service_info.get("service") != "gallery-dl-backend":
                    raise RuntimeError("/ did not identify gallery-dl-backend")
                version = service_info.get("version")
                if not isinstance(version, str) or not version.strip():
                    raise RuntimeError("/ did not return a non-empty backend version")
                if not (work / "runtime" / "backend.sqlite3").is_file():
                    raise RuntimeError("backend did not create the isolated database")
                print(f"ready: host={process.pid}, Go backend={backend_pids}, origin=http://127.0.0.1:{port}, version={version}", flush=True)
                if hold:
                    print(f"Private test window remains open for {hold:g}s; do not open real data.", flush=True)
                    time.sleep(hold)
                # Native SIGTERM exercises host shutdown. Killing children here
                # would hide a lifecycle regression, so cleanup only runs later.
                process.terminate()
                try:
                    process.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    raise RuntimeError("host did not stop within 20s of SIGTERM")
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline and (session_processes(process.pid) or port_open(port)):
                    time.sleep(0.2)
                remaining = session_processes(process.pid)
                if remaining or port_open(port):
                    raise RuntimeError(f"host shutdown left processes {remaining} or loopback port {port}")
                print("PASS: isolated Go health/ready/version checks, host shutdown, no session processes or listener remain.")
            except BaseException:
                log.flush()
                log.seek(0)
                print(log.read(), file=sys.stderr)
                raise
            finally:
                stop_session(process.pid)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--executable", type=Path, default=DESKTOP / "build/linux-amd64/ldos")
    parser.add_argument("--python", type=Path, default=BACKEND / ".venv/bin/python")
    parser.add_argument("--timeout", type=float, default=45)
    parser.add_argument("--hold", type=float, default=0, help="seconds to inspect the private window before shutdown")
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("this smoke only accepts Linux")
    if args.timeout <= 0 or args.hold < 0:
        parser.error("--timeout must be positive and --hold must not be negative")
    # Do not resolve the virtualenv Python symlink: its path selects the venv.
    executable, python = args.executable.absolute(), args.python.absolute()
    for path in (executable, python):
        if not path.is_file() or not os.access(path, os.X_OK):
            parser.error(f"missing executable: {path}")
    if not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")):
        parser.error("a Linux graphical session is required (DISPLAY or WAYLAND_DISPLAY)")
    try:
        run(executable, python, args.timeout, args.hold)
    except (OSError, ValueError, RuntimeError, KeyboardInterrupt) as error:
        print(f"mygo Linux smoke failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
