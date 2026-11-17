"""Test-only guard, also auto-loaded by isolated worker subprocesses."""

import sys


def _deny_external_io(event, args):
    if event.startswith(("socket.", "sqlite3.connect")):
        raise AssertionError(f"executor test attempted forbidden I/O: {event}")


sys.addaudithook(_deny_external_io)
