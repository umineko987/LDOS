"""语义地图服务与 /datasets/{id}/atlas 路由：用一个假 worker 跑完整的运行、缓存、取消和失败路径。"""

from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

from gdl_backend._database_gallery_repository import gallery_asset_id
from gdl_backend.api_routes.atlas import AtlasResponse, AtlasStateResponse
from gdl_backend.atlas_service import atlas_digest, fingerprint
from tests.test_dataset_service import DatasetTestBase, png_bytes


FAKE_WORKER = r'''
import argparse
import json
import os
import sys
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--job")
parser.add_argument("--output-dir")
args, _ = parser.parse_known_args()
mode = os.environ.get("FAKE_ATLAS_MODE", "ok")
job = json.loads(Path(args.job).read_text(encoding="utf-8"))
record = os.environ.get("FAKE_ATLAS_RECORD")
if record:
    with open(record, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"argv": sys.argv[1:], "job": job}) + "\n")


def emit(**event):
    print(json.dumps(event), flush=True)


out = Path(args.output_dir)
items = job["items"]
count = len(items)
emit(type="start", items=count)
emit(type="progress", stage="embed", done=0, total=count)
if mode == "slow":
    time.sleep(60)
if mode == "fail":
    emit(type="error", code="model_unavailable", message="DINOv2 模型不可用")
    sys.exit(1)
if mode == "crash":
    sys.stderr.write("Traceback: boom\n")
    sys.exit(3)
emit(type="progress", stage="embed", done=count, total=count)
emit(type="stage", stage="layout")
(out / "sprites").mkdir(parents=True, exist_ok=True)
(out / "sprites" / "sheet-0000.png").write_bytes(b"\x89PNG\r\n\x1a\nfake-sheet")
split = (count + 1) // 2
records = []
for index, item in enumerate(items):
    records.append({
        "asset_id": item["asset_id"],
        "sha256": item["sha256"],
        "x": round(-1 + 2 * index / max(count - 1, 1), 5),
        "y": 0.0,
        "cluster": 0 if index < split else 1,
        "outlier": 0.9 if index == count - 1 else 0.1,
        "sprite": [0, index],
    })
clusters = []
for cluster in sorted({record["cluster"] for record in records}):
    members = [record for record in records if record["cluster"] == cluster]
    clusters.append({
        "id": cluster,
        "size": len(members),
        "share": round(len(members) / count, 6),
        "medoid_asset_id": members[0]["asset_id"],
        "x": 0.0,
        "y": 0.0,
    })
sheets = ["../../escape.png"] if mode == "evil" else ["sprites/sheet-0000.png"]
atlas = {
    "schema_version": 1,
    "generated_at": time.time(),
    "input_digest": "worker-digest",
    "method": "trivial",
    "params": {"perplexity": 30.0, "iterations": 750, "exact_max": 1000, "clusters": len(clusters),
               "seed": 0, "knn": 10, "outlier_threshold": 0.6886},
    "counts": {"input": count, "items": count, "skipped": 0, "clusters": len(clusters), "outliers": 1},
    "items": records,
    "clusters": clusters,
    "vectors": {"dims": 32, "dtype": "int8", "encoding": "base64", "order": "items",
                "scales": [0.0] * 32, "data": ""},
    "sprites": {"format": "png", "sheet_size": 2048, "cell_size": 64, "columns": 32,
                "per_sheet": 1024, "sheets": sheets},
    "skipped": [],
    "timings_seconds": {},
}
temporary = out / "atlas.json.tmp"
temporary.write_text(json.dumps(atlas), encoding="utf-8")
os.replace(temporary, out / "atlas.json")
emit(type="done", output=str(out / "atlas.json"), items=count, skipped=0, clusters=len(clusters),
     method="trivial", seconds=0.01)
'''


class AtlasTestBase(DatasetTestBase):
    def setUp(self) -> None:
        super().setUp()
        worker_dir = self.root / "fake-worker"
        worker_dir.mkdir()
        script = worker_dir / "atlas_worker.py"
        script.write_text(FAKE_WORKER, encoding="utf-8")
        dedup = self.settings.dedup
        dedup.enabled = True
        dedup.python_executable = Path(sys.executable)
        dedup.atlas_script = script
        dedup.model_dir = self.root / "models"
        dedup.shutdown_grace_seconds = 2.0
        self.record = self.root / "worker-calls.jsonl"
        self.mode("ok")
        self.source_id, self.library = self.import_library(
            {"set/1.png": png_bytes("#111111"), "set/2.png": png_bytes("#222222"), "set/3.png": png_bytes("#333333")}
        )
        self.dataset_id = self.new_dataset()
        self.service.attach_source(self.dataset_id, self.source_id)
        self.assertTrue(self.service.hashing.wait_idle(10))
        self.ids = [gallery_asset_id(self.source_id, f"set/{index}.png") for index in (1, 2, 3)]
        self.base = f"/api/v1/datasets/{self.dataset_id}/atlas"
        self.addCleanup(self.stop_atlas)

    def stop_atlas(self) -> None:
        # 取消可能还在跑的假 worker，免得临时目录删除时子进程还在写。
        for dataset_id in list(self.container.atlas._active):
            self.client.post(f"/api/v1/datasets/{dataset_id}/atlas/cancel")

    def mode(self, value: str) -> None:
        patcher = mock.patch.dict(os.environ, {"FAKE_ATLAS_MODE": value, "FAKE_ATLAS_RECORD": str(self.record)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def calls(self) -> list[dict]:
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text(encoding="utf-8").splitlines()]

    def start(self, dataset_id: str | None = None, **body) -> dict:
        base = self.base if dataset_id is None else f"/api/v1/datasets/{dataset_id}/atlas"
        response = self.client.post(f"{base}/run", json=body)
        self.assertEqual(response.status_code, 202, response.text)
        return AtlasStateResponse.model_validate(response.json()).model_dump()

    def atlas(self, dataset_id: str | None = None) -> dict:
        base = self.base if dataset_id is None else f"/api/v1/datasets/{dataset_id}/atlas"
        response = self.client.get(base)
        self.assertEqual(response.status_code, 200, response.text)
        return AtlasResponse.model_validate(response.json()).model_dump()

    def wait_done(self, dataset_id: str | None = None, timeout: float = 20.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            body = self.atlas(dataset_id)
            if body["status"] != "running":
                return body
            time.sleep(0.05)
        self.fail("语义地图运行未在限时内结束")

    def wait_phase(self, phase: str, dataset_id: str | None = None, timeout: float = 20.0) -> dict:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            body = self.atlas(dataset_id)
            if body["progress"] and body["progress"]["phase"] == phase:
                return body
            time.sleep(0.05)
        self.fail(f"语义地图运行没有进入 {phase}")

    def run_ready(self, **body) -> dict:
        self.start(**body)
        done = self.wait_done()
        self.assertIn(done["status"], {"ready", "stale"}, done)
        return done

    def runs_dir(self, dataset_id: str | None = None) -> Path:
        return self.settings.runtime_dir / "atlas" / (dataset_id or self.dataset_id) / "runs"

    def atlas_events(self) -> list[dict]:
        events, _ = self.container.events.events_after(0)
        return [dict(event.data) for event in events if event.kind == "atlas.updated"]

    def error_code(self, response) -> str:
        return response.json()["error"]["code"]


class AtlasRunTest(AtlasTestBase):
    def test_run_reaches_ready_with_hints_sprites_and_events(self) -> None:
        thumbnail = self.client.get(f"/api/v1/gallery/assets/{self.ids[0]}/thumbnail", params={"size": 256})
        self.assertEqual(thumbnail.status_code, 200, thumbnail.text)

        started = self.start()
        self.assertEqual(started["status"], "running")
        self.assertIsNone(started["run"])
        body = self.wait_done()

        self.assertEqual(body["status"], "ready")
        self.assertFalse(body["stale"])
        self.assertEqual([item["asset_id"] for item in body["items"]], self.ids)
        self.assertEqual(body["run"]["counts"]["items"], 3)
        self.assertEqual(body["run"]["params"]["outlier_threshold"], 0.6886)
        self.assertEqual(body["delta"], {"added": 0, "changed": 0, "removed_asset_ids": []})
        self.assertEqual([(c["id"], c["live_size"]) for c in body["clusters"]], [(0, 2), (1, 1)])
        self.assertEqual(body["hints"]["share_threshold"], 0.08)
        self.assertEqual([hint["cluster"] for hint in body["hints"]["over_represented"]], [0, 1])
        self.assertEqual(body["hints"]["outliers"], [self.ids[2]])
        run_id = body["run"]["run_id"]
        self.assertEqual(
            body["sprites"]["urls"],
            [f"/api/v1/datasets/{self.dataset_id}/atlas/sprites/0?run={run_id}"],
        )
        self.assertEqual(body["vectors"]["dims"], 32)

        [call] = self.calls()
        items = call["job"]["items"]
        self.assertEqual([item["asset_id"] for item in items], self.ids)
        self.assertTrue(all(Path(item["path"]).is_absolute() and item["sha256"] for item in items))
        self.assertIn("thumbnail_path", items[0])
        self.assertNotIn("thumbnail_path", items[1])
        self.assertEqual(call["job"]["options"], {})
        self.assertIn("--model-dir", call["argv"])

        run_dir = self.runs_dir() / run_id
        self.assertTrue((run_dir / "atlas.json").is_file())
        self.assertFalse((run_dir / "job.json").exists())
        current = json.loads((self.settings.runtime_dir / "atlas" / self.dataset_id / "current.json").read_text())
        self.assertEqual(current["run_id"], run_id)

        statuses = [(event["status"], event["run_id"]) for event in self.atlas_events()]
        self.assertEqual(statuses, [("running", run_id), ("succeeded", run_id)])
        job = self.container.jobs.get(f"atlas:{self.dataset_id}")
        self.assertEqual((job["kind"], job["status"]), ("atlas.run", "succeeded"))
        self.assertEqual(job["ref"], {"dataset_id": self.dataset_id, "run_id": run_id})

    def test_unchanged_digest_is_served_from_cache(self) -> None:
        first = self.run_ready()
        again = self.start()
        self.assertTrue(again["cached"])
        self.assertEqual(again["status"], "ready")
        self.assertEqual(again["run"]["run_id"], first["run"]["run_id"])
        self.assertEqual(len(self.calls()), 1)

        forced = self.run_ready(force=True)
        self.assertNotEqual(forced["run"]["run_id"], first["run"]["run_id"])
        self.assertEqual(len(self.calls()), 2)
        # 选项进摘要：换了簇数要重算。
        tuned = self.run_ready(clusters=2)
        self.assertEqual(self.calls()[-1]["job"]["options"], {"clusters": 2})
        self.assertEqual(tuned["run"]["options"], {"clusters": 2})
        self.assertTrue(self.start(clusters=2)["cached"])
        self.assertEqual(len(self.calls()), 3)
        # 只保留当前和上一次完成的运行。
        self.assertEqual(
            sorted(path.name for path in self.runs_dir().iterdir()),
            sorted([forced["run"]["run_id"], tuned["run"]["run_id"]]),
        )

    def test_missing_hashes_are_filled_before_the_worker_runs(self) -> None:
        with self.db._transaction() as conn:
            conn.execute("UPDATE gallery_assets SET content_sha256=''")
        self.assertTrue(any(not m["content_sha256"] for m in self.service.stage_input(self.dataset_id, "tag")))
        body = self.run_ready()
        self.assertTrue(all(item["sha256"] for item in self.calls()[0]["job"]["items"]))
        self.assertTrue(all(item["sha256"] for item in body["items"]))
        self.assertTrue(self.start()["cached"])

    def test_run_is_idempotent_while_running_and_cancel_discards_the_run(self) -> None:
        self.mode("slow")
        first = self.start()
        self.wait_phase("embed")
        second = self.start()
        self.assertEqual(second["running_run_id"], first["running_run_id"])
        run_id = first["running_run_id"]
        started = time.monotonic()
        cancelled = self.client.post(f"{self.base}/cancel")
        self.assertEqual(cancelled.status_code, 200, cancelled.text)
        self.assertLess(time.monotonic() - started, 10)
        body = cancelled.json()
        self.assertEqual((body["status"], body["run"], body["progress"]), ("none", None, None))
        self.assertFalse((self.runs_dir() / run_id).exists())
        self.assertEqual(self.atlas_events()[-1], {"dataset_id": self.dataset_id, "status": "cancelled", "run_id": run_id})
        self.assertEqual(self.container.jobs.get(f"atlas:{self.dataset_id}")["status"], "cancelled")
        self.assertEqual(len(self.calls()), 1)
        # 没有运行时取消是空操作。
        self.assertEqual(self.client.post(f"{self.base}/cancel").json()["status"], "none")

    def test_runs_are_serialised_and_a_queued_run_can_be_cancelled(self) -> None:
        other = self.new_dataset("角色B")
        self.service.attach_source(other, self.source_id)
        self.mode("slow")
        self.start()
        self.wait_phase("embed")
        queued = self.start(other)
        self.assertEqual(queued["progress"]["phase"], "queued")
        time.sleep(0.2)
        self.assertEqual(self.atlas(other)["progress"]["phase"], "queued")
        self.assertEqual(self.client.post(f"/api/v1/datasets/{other}/atlas/cancel").json()["status"], "none")
        self.assertEqual(self.atlas()["status"], "running")
        self.assertEqual(self.client.post(f"{self.base}/cancel").json()["status"], "none")
        self.assertEqual(len(self.calls()), 1)

    def test_failures_keep_the_previous_result(self) -> None:
        good = self.run_ready()
        run_id = good["run"]["run_id"]

        self.mode("fail")
        self.start(force=True)
        failed = self.wait_done()
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"]["code"], "atlas_model_unavailable")
        self.assertIn("DINOv2", failed["error"]["message"])
        self.assertEqual(failed["run"]["run_id"], run_id)
        self.assertEqual(len(failed["items"]), 3)
        self.assertEqual([path.name for path in self.runs_dir().iterdir()], [run_id])
        self.assertEqual(self.container.jobs.get(f"atlas:{self.dataset_id}")["status"], "failed")
        self.assertEqual(self.atlas_events()[-1]["status"], "failed")

        self.mode("crash")
        self.start(force=True)
        crashed = self.wait_done()
        self.assertEqual(crashed["error"]["code"], "atlas_worker_failed")
        self.assertIn("boom", crashed["error"]["message"])
        self.assertEqual(crashed["run"]["run_id"], run_id)

        # 越界的雪碧图路径在提交前被拒绝，current 不动。
        self.mode("evil")
        self.start(force=True)
        evil = self.wait_done()
        self.assertEqual(evil["error"]["code"], "atlas_output_invalid")
        self.assertEqual(evil["run"]["run_id"], run_id)

        self.mode("ok")
        recovered = self.run_ready(force=True)
        self.assertEqual(recovered["status"], "ready")
        self.assertIsNone(recovered["error"])

    def test_first_run_cleans_orphaned_directories(self) -> None:
        atlas_root = self.settings.runtime_dir / "atlas"
        (atlas_root / "deleted-dataset" / "runs" / "0000000000001-aaaaaaaa").mkdir(parents=True)
        half = self.runs_dir() / "0000000000002-bbbbbbbb"
        half.mkdir(parents=True)
        (half / "job.json").write_text("{}", encoding="utf-8")
        body = self.run_ready()
        self.assertFalse((atlas_root / "deleted-dataset").exists())
        self.assertEqual([path.name for path in self.runs_dir().iterdir()], [body["run"]["run_id"]])

    def test_unavailable_empty_and_unknown_dataset(self) -> None:
        self.settings.dedup.enabled = False
        response = self.client.post(f"{self.base}/run", json={})
        self.assertEqual((response.status_code, self.error_code(response)), (409, "atlas_unavailable"))
        body = self.atlas()
        self.assertEqual((body["status"], body["availability"]), ("none", {"available": False, "reason": "dedup_disabled"}))
        self.settings.dedup.enabled = True
        self.settings.dedup.atlas_script = self.root / "missing.py"
        response = self.client.post(f"{self.base}/run", json={})
        self.assertEqual((response.status_code, self.error_code(response)), (409, "atlas_unavailable"))
        self.assertEqual(self.atlas()["availability"]["reason"], "worker_missing")
        self.settings.dedup.atlas_script = self.root / "fake-worker" / "atlas_worker.py"

        empty = self.new_dataset("空")
        response = self.client.post(f"/api/v1/datasets/{empty}/atlas/run")
        self.assertEqual((response.status_code, self.error_code(response)), (422, "atlas_empty"))

        for method, path in (
            ("get", "/api/v1/datasets/nope/atlas"),
            ("post", "/api/v1/datasets/nope/atlas/run"),
            ("post", "/api/v1/datasets/nope/atlas/cancel"),
            ("get", "/api/v1/datasets/nope/atlas/sprites/0"),
        ):
            with self.subTest(path=path):
                response = getattr(self.client, method)(path)
                self.assertEqual((response.status_code, self.error_code(response)), (404, "dataset_not_found"))
        for body in ({"clusters": 0}, {"perplexity": 1}, {"unknown": True}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post(f"{self.base}/run", json=body).status_code, 422)
        self.assertEqual(self.calls(), [])


class AtlasStaleTest(AtlasTestBase):
    def test_exclusions_hide_points_and_additions_make_the_map_stale(self) -> None:
        self.service.decide(self.dataset_id, stage="clean", asset_ids=[self.ids[2]], decision="exclude")
        body = self.run_ready()
        self.assertEqual([item["asset_id"] for item in body["items"]], self.ids[:2])
        digest = body["current_digest"]

        # 往回加图：之前清洗排除的图回到打标输入 → stale。
        self.service.decide(self.dataset_id, stage="clean", asset_ids=[self.ids[2]], decision="clear")
        body = self.atlas()
        self.assertEqual((body["status"], body["stale"]), ("stale", True))
        self.assertEqual(body["delta"]["added"], 1)
        self.assertNotEqual(body["current_digest"], digest)
        self.run_ready()

        # 排除只是隐藏点：地图仍可用，簇的 live 占比跟着变。
        self.service.decide(self.dataset_id, stage="clean", asset_ids=[self.ids[0]], decision="exclude")
        body = self.atlas()
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["delta"]["removed_asset_ids"], [self.ids[0]])
        self.assertEqual([c["live_size"] for c in body["clusters"]], [1, 1])
        self.assertEqual(body["clusters"][0]["live_share"], 0.5)

    def test_root_changes_make_the_map_stale(self) -> None:
        self.run_ready()
        other_source, _ = self.import_library({"4.png": png_bytes("#444444")}, name="lib2")
        self.service.attach_source(self.dataset_id, other_source)
        body = self.atlas()
        self.assertEqual((body["status"], body["delta"]["added"]), ("stale", 1))
        self.run_ready()

        (self.library / "set/2.png").write_bytes(png_bytes("#abcdef"))
        self.bump_mtime(self.library / "set/2.png")
        self.catalog.scan_source(self.source_id)
        self.wait_scan(self.source_id)
        self.assertTrue(self.service.hashing.wait_idle(10))
        body = self.atlas()
        self.assertEqual((body["status"], body["delta"]["changed"]), ("stale", 1))

        roots = self.service.list_roots(self.dataset_id)
        lib2 = next(root for root in roots if root["source_id"] == other_source)
        self.run_ready()
        self.service.detach_root(self.dataset_id, lib2["root_id"])
        body = self.atlas()
        self.assertEqual(body["status"], "ready")
        self.assertEqual(body["delta"]["removed_asset_ids"], [gallery_asset_id(other_source, "4.png")])

    def test_digest_helpers(self) -> None:
        self.assertEqual(fingerprint({"content_sha256": "ab", "size_bytes": 1, "modified_ns": 2}), "ab")
        self.assertEqual(fingerprint({"content_sha256": None, "size_bytes": 1, "modified_ns": 2}), "1:2")
        self.assertEqual(atlas_digest({"b": "2", "a": "1"}, {}), atlas_digest({"a": "1", "b": "2"}, {}))
        self.assertNotEqual(atlas_digest({"a": "1"}, {}), atlas_digest({"a": "1"}, {"clusters": 2}))


class AtlasLabelTest(AtlasTestBase):
    def test_items_carry_names_and_clusters_carry_top_tags(self) -> None:
        self.service.update(self.dataset_id, {"trigger_word": "sks"})
        # 假 worker 把前两张分进簇 0、第三张进簇 1；第三张没有 caption。
        (self.library / "set/1.txt").write_text("sks, 1girl, smile, hat", encoding="utf-8")
        (self.library / "set/2.txt").write_text("sks, smile, 1girl, outdoors", encoding="utf-8")
        self.catalog.scan_source(self.source_id)
        self.wait_scan(self.source_id)
        body = self.run_ready()
        self.assertEqual([item["name"] for item in body["items"]], ["1.png", "2.png", "3.png"])
        self.assertEqual(
            [(cluster["id"], cluster["top_tags"]) for cluster in body["clusters"]],
            [(0, ["1girl", "smile", "hat"]), (1, [])],
        )

        # 改 caption 换 ETag，重新统计。
        etag = self.client.get(self.base).headers["etag"]
        response = self.client.post(
            f"/api/v1/datasets/{self.dataset_id}/captions/ops",
            json={"asset_ids": [self.ids[1]], "ops": [{"op": "add", "tags": ["hat", "solo"]}]},
        )
        self.assertEqual(response.status_code, 200, response.text)
        changed = self.client.get(self.base, headers={"If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["etag"], etag)
        self.assertEqual(changed.json()["clusters"][0]["top_tags"], ["1girl", "hat", "smile"])

        # 触发词改了也换 ETag：旧触发词变回普通标签参与统计。
        etag = changed.headers["etag"]
        self.service.update(self.dataset_id, {"trigger_word": "zzz"})
        changed = self.client.get(self.base, headers={"If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.json()["clusters"][0]["top_tags"], ["1girl", "hat", "sks"])

        # 被移出输入的图不计票、没有名字。
        self.service.decide(self.dataset_id, stage="clean", asset_ids=[self.ids[0]], decision="exclude")
        body = self.atlas()
        self.assertEqual(body["clusters"][0]["top_tags"], ["1girl", "hat", "outdoors"])
        self.assertEqual([item["name"] for item in body["items"]], [None, "2.png", "3.png"])


class AtlasHttpTest(AtlasTestBase):
    def test_atlas_etag_and_not_modified(self) -> None:
        empty = self.client.get(self.base)
        self.assertEqual(empty.json()["status"], "none")
        self.run_ready()
        first = self.client.get(self.base)
        etag = first.headers["etag"]
        self.assertEqual(first.headers["cache-control"], "private, no-cache")
        self.assertNotEqual(etag, empty.headers["etag"])
        cached = self.client.get(self.base, headers={"If-None-Match": etag})
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.headers["etag"], etag)
        self.assertEqual(cached.content, b"")

        self.service.decide(self.dataset_id, stage="clean", asset_ids=[self.ids[1]], decision="exclude")
        changed = self.client.get(self.base, headers={"If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["etag"], etag)

    def test_sprite_route_serves_sheets_and_rejects_traversal(self) -> None:
        body = self.run_ready()
        url = body["sprites"]["urls"][0]
        run_id = body["run"]["run_id"]
        sheet = self.client.get(url)
        self.assertEqual(sheet.status_code, 200, sheet.text)
        self.assertEqual(sheet.headers["content-type"], "image/png")
        self.assertEqual(sheet.headers["cache-control"], "private, max-age=31536000, immutable")
        self.assertEqual(sheet.headers["cross-origin-resource-policy"], "cross-origin")
        self.assertEqual(sheet.content, b"\x89PNG\r\n\x1a\nfake-sheet")
        again = self.client.get(url, headers={"If-None-Match": sheet.headers["etag"]})
        self.assertEqual(again.status_code, 304)
        floating = self.client.get(f"{self.base}/sprites/0")
        self.assertEqual((floating.status_code, floating.headers["cache-control"]), (200, "private, no-cache"))

        for path, status in (
            (f"{self.base}/sprites/1", 404),
            (f"{self.base}/sprites/-1", 422),
            (f"{self.base}/sprites/x", 422),
            (f"{self.base}/sprites/0?run=../../etc", 422),
            (f"{self.base}/sprites/0?run=0000000000000-deadbeef", 404),
            (f"{self.base}/sprites/..%2F..%2Fcurrent.json", 404),
        ):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, status)

        # 运行目录里的雪碧图被换成指向外面的链接时不跟随。
        outside = self.root / "outside.png"
        outside.write_bytes(b"secret")
        target = self.runs_dir() / run_id / "sprites" / "sheet-0000.png"
        target.unlink()
        target.symlink_to(outside)
        response = self.client.get(url)
        self.assertEqual((response.status_code, self.error_code(response)), (404, "atlas_sprite_not_found"))

    def test_remove_and_restore_record_dedup_decisions(self) -> None:
        self.run_ready()
        # 去重审核自己的排除不应被 restore 清掉。
        self.service.decide(self.dataset_id, stage="dedup", asset_ids=[self.ids[1]], decision="exclude", reason="近重复")
        removed = self.client.post(f"{self.base}/remove", json={"asset_ids": [self.ids[0]]})
        self.assertEqual(removed.status_code, 200, removed.text)
        self.assertEqual(removed.json()["updated"], 1)
        dedup = removed.json()["funnel"]["stages"][2]
        self.assertEqual((dedup["stage"], dedup["excluded"]), ("dedup", 2))
        decisions = {
            row["asset_id"]: (row["stage"], row["decision"], row["reason"])
            for row in self.db.datasets.list_decisions(self.dataset_id)
        }
        self.assertEqual(decisions[self.ids[0]], ("dedup", "exclude", "atlas"))
        body = self.atlas()
        self.assertEqual(sorted(body["delta"]["removed_asset_ids"]), sorted(self.ids[:2]))
        self.assertEqual(body["hints"]["outliers"], [self.ids[2]])
        events, _ = self.container.events.events_after(0)
        self.assertIn(
            {"dataset_id": self.dataset_id, "reason": "atlas"},
            [dict(event.data) for event in events if event.kind == "dataset.updated"],
        )

        restored = self.client.post(f"{self.base}/restore", json={"asset_ids": self.ids[:2]})
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json()["updated"], 1)
        remaining = {row["asset_id"]: row["reason"] for row in self.db.datasets.list_decisions(self.dataset_id)}
        self.assertEqual(remaining, {self.ids[1]: "近重复"})
        self.assertEqual(self.atlas()["delta"]["removed_asset_ids"], [self.ids[1]])

        nothing = self.client.post(f"{self.base}/restore", json={"asset_ids": [self.ids[2]]})
        self.assertEqual(nothing.json()["updated"], 0)
        stranger = self.client.post(f"{self.base}/remove", json={"asset_ids": ["stranger"]})
        self.assertEqual((stranger.status_code, self.error_code(stranger)), (422, "dataset_asset_not_member"))
        self.assertEqual(self.client.post(f"{self.base}/remove", json={"asset_ids": []}).status_code, 422)


if __name__ == "__main__":
    unittest.main()
