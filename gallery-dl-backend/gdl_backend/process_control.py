from __future__ import annotations

import asyncio
import os
import signal
from pathlib import Path


async def terminate_process(process: asyncio.subprocess.Process, grace_seconds: float) -> None:
    if process.returncode is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        try:
            process.terminate()
        except ProcessLookupError:
            return
    try:
        await asyncio.wait_for(process.wait(), timeout=max(0.2, float(grace_seconds)))
        return
    except asyncio.TimeoutError:
        pass
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            process.kill()
        except ProcessLookupError:
            pass
    try:
        await asyncio.wait_for(process.wait(), timeout=5)
    except asyncio.TimeoutError:
        try:
            process.kill()
        except ProcessLookupError:
            return
        try:
            await asyncio.wait_for(process.wait(), timeout=3)
        except asyncio.TimeoutError:
            return


def process_command_line(pid: int) -> str:
    if int(pid) <= 0:
        return ""
    path = Path(f"/proc/{int(pid)}/cmdline")
    try:
        return path.read_bytes().replace(b"\x00", b" ").decode("utf-8", "replace")
    except OSError:
        return ""


def terminate_stale_process(pid: int | None, marker: str | None) -> bool:
    if not pid or not marker:
        return False
    command = process_command_line(int(pid))
    if not command or marker not in command or "gdl_backend.worker_entry" not in command:
        return False
    try:
        os.killpg(int(pid), signal.SIGTERM)
        return True
    except (ProcessLookupError, PermissionError):
        return False
