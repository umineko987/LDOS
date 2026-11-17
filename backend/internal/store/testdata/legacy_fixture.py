"""Test-only legacy oracle. Every database path is supplied by Go's t.TempDir()."""
from __future__ import annotations

import importlib
import json
import sqlite3
import sys
import threading
import types
from contextlib import contextmanager
from pathlib import Path

root = Path(__file__).resolve().parents[4]
package = types.ModuleType("gdl_backend")
package.__path__ = [str(root / "gallery-dl-backend" / "gdl_backend")]
sys.modules["gdl_backend"] = package
schema = importlib.import_module("gdl_backend._database_schema")
tasks = importlib.import_module("gdl_backend._database_task_repository")

conn = sqlite3.connect(sys.argv[1], isolation_level=None)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA foreign_keys=ON")
conn.execute("PRAGMA journal_mode=WAL")


@contextmanager
def transaction():
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.rollback()
        raise
    else:
        conn.commit()


@contextmanager
def read():
    yield conn


schema.initialize_schema(conn, transaction)


def layout():
    result = {}
    for table in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"):
        name = table[0]
        indexes = []
        for index in conn.execute(f'PRAGMA index_list("{name}")'):
            item = dict(index)
            item.pop("seq")
            item["columns"] = [dict(row) for row in conn.execute(f'PRAGMA index_xinfo("{index[1]}")')]
            indexes.append(item)
        result[name] = {
            "columns": [dict(row) for row in conn.execute(f'PRAGMA table_info("{name}")')],
            "foreign_keys": [dict(row) for row in conn.execute(f'PRAGMA foreign_key_list("{name}")')],
            "indexes": sorted(indexes, key=lambda i: i["name"]),
        }
    return result


counter = 0


def next_id():
    global counter
    counter += 1
    return f"attempt-{counter}"


repo = tasks.TaskRepository(read=read, transaction=transaction, write_lock=threading.RLock(),
                            since_prune={}, max_logs_per_task=lambda: 5000,
                            clock=lambda: 1234.5, uuid4=next_id)
values = {"id": "legacy-task", "url": "https://example.org/图片", "site": "example",
          "output_dir": "/tmp/fixture", "proxy_mode": "direct", "max_attempts": 3,
          "extra_args": ["--verbose"], "policy": {"retry": True}}
trace = []
created, fresh = repo.create_task(values, idempotency_key="legacy-key")
trace.append([created, fresh])
trace.append(repo.claim_task("legacy-task"))
trace.append(repo.begin_attempt("legacy-task"))
repo.set_process("legacy-task", "attempt-1", 123, "marker")
repo.set_lease("legacy-task", "attempt-1", "node-1", "http://localhost:8888", "example")
trace.append(repo.get_task("legacy-task"))
trace.append(list(repo.create_task({}, idempotency_key="legacy-key")))
repo.finish_attempt("attempt-1", exit_code=2, status="failed", error_class="transient",
                    error_message="https://name:pw@example.org/?token=private", retryable=True)
trace.append(repo.requeue_task("legacy-task", next_run_at=1500, exit_code=2,
                              error_class="transient", error_message="retry", tried_proxy_ids=["b", "a", "b"],
                              expected_attempt_id="attempt-1"))
trace.append(repo.get_task("legacy-task"))
trace.append(repo.request_cancel("legacy-task"))
trace.append(repo.retry_task("legacy-task", 2))
trace.append(repo.claim_task("legacy-task"))
trace.append(repo.begin_attempt("legacy-task"))
trace.append(repo.request_cancel("legacy-task"))
trace.append(repo.recover_incomplete())
trace.append(repo.get_task("legacy-task"))
repo.append_log("legacy-task", None, "stderr", "password=private")
repo.append_log("legacy-task", "attempt-2", "stdout", "完成")
trace.append(repo.get_logs("legacy-task", tail=1))
trace.append(repo.get_events("legacy-task"))
trace.append(repo.list_tasks(status="cancelled", site="example", limit=0, offset=-1))
# Unrelated application content must survive Go Open unchanged.
conn.execute("INSERT INTO datasets(id,name,kind,created_at,updated_at) VALUES ('legacy-dataset','keep','custom',1,1)")
conn.execute("INSERT INTO gallery_review_presets VALUES ('preset','keep','{}')")
print(json.dumps({"layout": layout(), "trace": trace, "task": repo.get_task("legacy-task")}, ensure_ascii=False))
conn.close()
