"""数据集打标：tag 阶段运行（fake CLI）、候选分数 ETag/304、从打标写 caption。"""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import PropertyMock, patch

from gdl_backend._database_gallery_repository import gallery_asset_id, gallery_directory_id
from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.dataset_tagging import accepts_gzip
from tests.helpers import local_test_client, make_settings
from tests.test_dataset_service import DatasetTestBase, png_bytes

# 假 CLI：记下 argv 和 stdin，按 fake_tagger.json 里的分数回答 tag / candidates / compose。
FAKE_CLI = r'''
import json, os, sys, time

root = os.path.dirname(os.path.abspath(__file__))
config = json.load(open(os.path.join(root, "fake_tagger.json"), encoding="utf-8"))
argv = sys.argv[1:]
command = argv[2]
lines = [line for line in sys.stdin.read().split("\n") if line]
with open(os.path.join(root, "calls.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps({"command": command, "argv": argv, "stdin": lines}) + "\n")


def emit(payload):
    print(json.dumps(payload), flush=True)


def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default


models = arg("--models").split(",")
scores = config.get("scores", {})
if command == "tag":
    time.sleep(config.get("tag_sleep", 0))
    if config.get("tag_exit"):
        print("model exploded", file=sys.stderr)
        sys.exit(config["tag_exit"])
    emit({"type": "progress", "stage": "inferring", "done": len(lines), "total": len(lines)})
    emit({"type": "done", "command": "tag", "total": len(lines),
          "per_model": {m: {"inferred": len(lines), "cache_hits": 0} for m in models},
          "decode_errors": [], "unreadable": [], "captions_written": 0, "captions_skipped": 0})
    sys.exit(0)

if config.get("query_exit"):
    print("cannot load model", file=sys.stderr)
    sys.exit(config["query_exit"])
defaults = {"general": 0.35, "character": 0.85, "rating": 0.0}
header = [{"key": m, "adapter": "wd", "revision": "r1", "fingerprint": "fp-" + m,
           "vocabulary_fingerprint": "vf", "vocabulary_size": 100,
           "categories": ["general", "character", "rating"], "default_thresholds": defaults} for m in models]


def entries():
    for line in lines:
        sha, _, path = line.rpartition("\t")
        yield (sha or None), path


if command == "candidates":
    floor = float(arg("--floor", "0.05"))
    emit({"type": "models", "floor": floor, "models": header})
    for sha, path in entries():
        per = scores.get(os.path.basename(path))
        if per is None:
            emit({"type": "candidates", "path": path, "sha256": sha, "status": "missing_scores",
                  "models": {}, "missing_models": models})
            continue
        emit({"type": "candidates", "path": path, "sha256": sha, "status": "ok", "missing_models": [],
              "models": {m: [t for t in per.get(m, []) if t[2] >= floor or t[1] == "rating"] for m in models}})
    emit({"type": "done", "command": "candidates", "total": len(lines)})
elif command == "compose":
    overrides = {}
    for index, item in enumerate(argv):
        if item == "--model-threshold":
            overrides[(argv[index + 1], argv[index + 2])] = float(argv[index + 3])
    categories = arg("--categories")
    categories = categories.split(",") if categories else ["general", "character"]
    emit({"type": "models", "models": [
        {**model, "thresholds": {c: overrides.get((model["key"], c), defaults[c]) for c in defaults},
         "selected_categories": categories} for model in header]})
    for sha, path in entries():
        per = scores.get(os.path.basename(path))
        if per is None:
            emit({"type": "result", "path": path, "sha256": sha, "status": "missing_scores",
                  "missing_models": models, "tags": [], "caption": ""})
            continue
        texts = []
        for m in models:
            for name, category, score in per.get(m, []):
                if category not in categories or score < overrides.get((m, category), defaults[category]):
                    continue
                text = name if "--keep-underscores" in argv else name.replace("_", " ")
                if text not in texts:
                    texts.append(text)
        emit({"type": "result", "path": path, "sha256": sha, "status": "ok", "missing_models": [],
              "tags": [{"name": t, "text": t, "category": "general", "score": 1.0, "model": models[0]} for t in texts],
              "caption": ", ".join(texts)})
    emit({"type": "done", "command": "compose", "total": len(lines)})
'''

MODEL = "wd-vit-v3"


class DatasetTaggingTestBase(DatasetTestBase):
    def setUp(self) -> None:
        super().setUp()
        self.settings.tagger.python_executable = Path(sys.executable)
        self.settings.tagger.cli_script = self.root / "fake" / "cli.py"
        self.settings.tagger.cli_script.parent.mkdir()
        self.settings.tagger.cli_script.write_text(FAKE_CLI, encoding="utf-8")
        self.settings.tagger.model_dir = self.root / "models"
        self.settings.tagger.cache_path = self.root / "tags.sqlite3"
        self.configure(scores={})
        self.mock_installed((MODEL,))

        self.source_id, self.library = self.import_library(
            {
                "set/a.png": png_bytes("#100"),
                "set/a.txt": "1girl, solo",
                "set/b.png": png_bytes("#200"),
            }
        )
        self.dataset_id = self.new_dataset()
        self.service.update(self.dataset_id, {"trigger_word": "sks"})
        self.service.attach_directory(self.dataset_id, gallery_directory_id(self.source_id, "set"))
        self.ids = {name: gallery_asset_id(self.source_id, f"set/{name}.png") for name in ("a", "b")}

    def configure(self, **config) -> None:
        (self.root / "fake" / "fake_tagger.json").write_text(json.dumps(config), encoding="utf-8")

    def mock_installed(self, models: tuple[str, ...]) -> None:
        catalog = self.container.tagger.model_catalog()
        for entry in catalog:
            entry["installed"] = entry["key"] in models
        patcher = patch.object(self.container.tagger, "model_catalog", return_value=catalog)
        patcher.start()
        self.addCleanup(patcher.stop)

    def calls(self, command: str | None = None) -> list[dict]:
        path = self.root / "fake" / "calls.jsonl"
        if not path.exists():
            return []
        calls = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
        return [call for call in calls if command is None or call["command"] == command]

    def image(self, name: str) -> str:
        return str(self.library / "set" / f"{name}.png")

    def text(self, name: str) -> str | None:
        path = self.library / "set" / f"{name}.txt"
        return path.read_text(encoding="utf-8") if path.exists() else None


class TagStageRunTest(DatasetTaggingTestBase):
    def wait_run(self, run_id: str) -> dict:
        for _ in range(500):
            runs = self.client.get(f"/api/v1/datasets/{self.dataset_id}/stage-runs?stage=tag").json()["items"]
            run = next(run for run in runs if run["run_id"] == run_id)
            if run["status"] != "running":
                return run
            time.sleep(0.02)
        self.fail("tag 阶段运行未在限时内结束")

    def test_run_feeds_paths_on_stdin_and_records_stats(self) -> None:
        (self.library / "set" / "b.png").unlink()  # 扫描之后被删：跳过，不交给 CLI
        response = self.client.post(
            f"/api/v1/datasets/{self.dataset_id}/stages/tag/run",
            json={"models": [MODEL, MODEL], "batch_size": 4},
        )
        self.assertEqual(response.status_code, 202, response.text)
        run = response.json()
        self.assertEqual((run["stage"], run["status"]), ("tag", "running"))
        self.assertEqual(run["stats"], {"models": [MODEL], "total": 1, "skipped": 1})
        job = self.container.jobs.get(run["ref_id"])
        self.assertEqual(job["kind"], "tagger.tag")
        self.assertEqual(job["ref"]["dataset_id"], self.dataset_id)

        finished = self.wait_run(run["run_id"])
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["stats"]["per_model"], {MODEL: {"inferred": 1, "cache_hits": 0}})
        self.assertEqual(finished["stats"]["skipped"], 1)
        self.assertEqual(self.container.tagger.cache_generation, 1)

        [call] = self.calls("tag")
        argv = call["argv"]
        self.assertIn("--no-captions", argv)
        self.assertEqual(argv[argv.index("--inputs-file") + 1], "-")
        self.assertEqual(argv[argv.index("--batch-size") + 1], "4")
        self.assertEqual(call["stdin"], [self.image("a")])
        self.assertEqual(self.text("a"), "1girl, solo")

    def test_cli_failure_finishes_the_run_as_failed(self) -> None:
        self.configure(tag_exit=4)
        run = self.client.post(
            f"/api/v1/datasets/{self.dataset_id}/stages/tag/run", json={"models": [MODEL]}
        ).json()
        finished = self.wait_run(run["run_id"])
        self.assertEqual((finished["status"], finished["error_code"]), ("failed", "tagger_failed"))
        self.assertIn("model exploded", finished["stats"]["message"])

    def test_rejections_leave_no_stage_run(self) -> None:
        url = f"/api/v1/datasets/{self.dataset_id}/stages/tag/run"
        missing = self.client.post(url, json={"models": ["pixai-tagger-v1"]})
        self.assertEqual((missing.status_code, missing.json()["error"]["code"]), (409, "tagger_model_missing"))
        unknown = self.client.post(url, json={"models": ["nope"]})
        self.assertEqual((unknown.status_code, unknown.json()["error"]["code"]), (422, "unknown_tagger_model"))
        self.assertEqual(self.client.post("/api/v1/datasets/nope/stages/tag/run", json={"models": [MODEL]}).status_code, 404)
        self.settings.tagger.enabled = False
        disabled = self.client.post(url, json={"models": [MODEL]})
        self.assertEqual((disabled.status_code, disabled.json()["error"]["code"]), (409, "tagger_disabled"))
        self.settings.tagger.enabled = True

        self.configure(tag_sleep=1)
        first = self.client.post(url, json={"models": [MODEL]})
        self.assertEqual(first.status_code, 202)
        busy = self.client.post(url, json={"models": [MODEL]})
        self.assertEqual((busy.status_code, busy.json()["error"]["code"]), (409, "tagger_busy"))
        runs = self.client.get(f"/api/v1/datasets/{self.dataset_id}/stage-runs?stage=tag").json()["items"]
        self.assertEqual([run["run_id"] for run in runs], [first.json()["run_id"]])
        self.wait_run(first.json()["run_id"])

    def test_recover_interrupts_orphaned_tag_runs_only(self) -> None:
        stats = {"models": [MODEL], "total": 2, "skipped": 0}
        orphan = self.service.start_stage_run(self.dataset_id, "tag", ref_id="job-gone", stats=stats)
        live = self.service.start_stage_run(self.dataset_id, "tag", ref_id="job-live")
        clean = self.service.start_stage_run(self.dataset_id, "clean")
        with patch.object(type(self.container.tagger), "current_job_id", new_callable=PropertyMock) as current:
            current.return_value = "job-live"
            self.assertEqual(self.container.dataset_tagging.recover(), 1)
        recovered = self.db.datasets.get_stage_run(orphan["run_id"])
        self.assertEqual((recovered["status"], recovered["error_code"]), ("failed", "interrupted"))
        self.assertEqual(recovered["stats"], stats)
        self.assertIsNotNone(recovered["finished_at"])
        # 正在跑的 tagger 任务和别的阶段不动。
        self.assertEqual(self.db.datasets.get_stage_run(live["run_id"])["status"], "running")
        self.assertEqual(self.db.datasets.get_stage_run(clean["run_id"])["status"], "running")


class TagRunStartupRecoveryTest(unittest.TestCase):
    def test_backend_start_interrupts_tag_runs_left_running(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            settings = make_settings(Path(tmp))
            settings.tagger.model_dir = Path(tmp) / "tagger-models"
            settings.dedup.model_dir = Path(tmp) / "dedup-models"
            first = ServiceContainer(settings)
            with local_test_client(create_app(settings, container=first, start_background=False), settings):
                dataset_id = first.datasets.create(name="角色A", kind="character")["dataset_id"]
                run = first.datasets.start_stage_run(dataset_id, "tag", ref_id="job-from-last-session")
            # 后端重启：新容器带后台任务启动。
            second = ServiceContainer(settings)
            with local_test_client(create_app(settings, container=second, start_background=True), settings):
                recovered = second.db.datasets.get_stage_run(run["run_id"])
            self.assertEqual((recovered["status"], recovered["error_code"]), ("failed", "interrupted"))


def many_tags(prefix: str, count: int = 40) -> list[list]:
    return [[f"{prefix}_tag_{index}", "general", 0.9 - index * 0.02] for index in range(count)]


class CandidatesTest(DatasetTaggingTestBase):
    def url(self, models: str = MODEL) -> str:
        return f"/api/v1/datasets/{self.dataset_id}/tagger/candidates?models={models}"

    def test_sparse_scores_keyed_by_asset_with_shared_tag_table(self) -> None:
        self.configure(scores={
            "a.png": {MODEL: [["1girl", "general", 0.987654321012345], ["solo", "general", 0.004],
                              ["general", "rating", 0.001]]},
        })
        response = self.client.get(self.url())
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body["floor"], 0.01)
        [model] = body["models"]
        self.assertEqual((model["key"], model["fingerprint"]), (MODEL, f"fp-{MODEL}"))
        self.assertEqual(model["tags"], [["1girl", "general"], ["general", "rating"]])
        a = body["items"][self.ids["a"]]
        self.assertEqual(a["status"], "ok")
        # 分数保留完整精度；低于下限的普通标签不出现，rating 全部给出
        self.assertEqual(a["scores"][MODEL], [[0, 0.987654321012345], [1, 0.001]])
        self.assertEqual(body["items"][self.ids["b"]]["status"], "missing_scores")
        self.assertEqual(body["stats"]["ok"], 1)
        self.assertEqual(body["stats"]["missing_scores"], 1)

        [call] = self.calls("candidates")
        self.assertEqual(call["argv"][call["argv"].index("--floor") + 1], "0.01")
        self.assertEqual([line.rpartition("\t")[2] for line in call["stdin"]], [self.image("a"), self.image("b")])

    def test_etag_304_and_server_cache(self) -> None:
        self.configure(scores={"a.png": {MODEL: many_tags("a")}, "b.png": {MODEL: many_tags("b")}})
        first = self.client.get(self.url())
        etag = first.headers["ETag"]
        self.assertRegex(etag, r'^"[0-9a-f]{40}"$')
        self.assertEqual(first.headers["Content-Encoding"], "gzip")

        cached = self.client.get(self.url(), headers={"If-None-Match": etag})
        self.assertEqual(cached.status_code, 304)
        self.assertEqual(cached.content, b"")
        self.assertEqual(len(self.calls("candidates")), 1, "指纹没变时不该再跑 CLI")

        plain = self.client.get(self.url(), headers={"Accept-Encoding": "identity"})
        self.assertNotIn("Content-Encoding", plain.headers)
        self.assertEqual(plain.json(), first.json())

        # 打标缓存变了（又跑过一次 tag）：重新查询；分数没变就还是同一个 ETag
        self.container.tagger.cache_generation += 1
        same = self.client.get(self.url(), headers={"If-None-Match": etag})
        self.assertEqual(same.status_code, 304)
        self.assertEqual(len(self.calls("candidates")), 2)

        self.configure(scores={"a.png": {MODEL: many_tags("a", 5)}})
        self.container.tagger.cache_generation += 1
        changed = self.client.get(self.url(), headers={"If-None-Match": etag})
        self.assertEqual(changed.status_code, 200)
        self.assertNotEqual(changed.headers["ETag"], etag)

    def test_missing_files_are_unavailable_and_not_queried(self) -> None:
        (self.library / "set" / "b.png").unlink()
        body = self.client.get(self.url()).json()
        b = body["items"][self.ids["b"]]
        self.assertEqual((b["status"], b["reason"]), ("unavailable", "file_missing"))
        self.assertEqual(b["missing_models"], [MODEL])
        [call] = self.calls("candidates")
        self.assertEqual(len(call["stdin"]), 1)

    def test_errors(self) -> None:
        self.assertEqual(self.client.get(self.url() + "&floor=0.001").status_code, 422)
        bad = self.client.get(self.url(" , "))
        self.assertEqual((bad.status_code, bad.json()["error"]["code"]), (422, "invalid_tagger_models"))
        missing = self.client.get(self.url("pixai-tagger-v1"))
        self.assertEqual((missing.status_code, missing.json()["error"]["code"]), (409, "tagger_model_missing"))
        self.configure(query_exit=4)
        broken = self.client.get(self.url())
        self.assertEqual((broken.status_code, broken.json()["error"]["code"]), (409, "tagger_model_unavailable"))

    def test_accept_encoding_parsing(self) -> None:
        self.assertTrue(accepts_gzip("gzip, deflate, br"))
        self.assertTrue(accepts_gzip("br;q=1.0, gzip;q=0.5"))
        self.assertTrue(accepts_gzip("*"))
        self.assertFalse(accepts_gzip("gzip;q=0"))
        self.assertFalse(accepts_gzip("gzip;q=0.0, br"))
        self.assertFalse(accepts_gzip("identity"))
        self.assertFalse(accepts_gzip(None))


class CaptionsFromTaggerTest(DatasetTaggingTestBase):
    def from_tagger(self, **body):
        return self.client.post(
            f"/api/v1/datasets/{self.dataset_id}/captions/from-tagger",
            json={"models": [MODEL], **body},
        )

    def test_dry_run_then_overwrite_with_policy_args(self) -> None:
        self.configure(scores={
            "a.png": {MODEL: [["long_hair", "general", 0.9], ["smile", "general", 0.4], ["hatsune_miku", "character", 0.95]]},
            "b.png": {MODEL: [["long_hair", "general", 0.6]]},
        })
        events_before = self.container.events.events_after(0)[0]
        dry = self.from_tagger(mode="overwrite", dry_run=True, thresholds={MODEL: {"general": 0.5}})
        self.assertEqual(dry.status_code, 200, dry.text)
        body = dry.json()
        self.assertTrue(body["dry_run"])
        self.assertIsNone(body["batch_id"])
        self.assertEqual((body["stats"]["changed"], body["stats"]["new"]), (1, 1))
        sample = body["samples"][0]
        self.assertEqual(sample["after"], ["sks", "long hair", "hatsune miku"])
        self.assertEqual(sample["removed"], ["1girl", "solo"])
        self.assertEqual(self.text("a"), "1girl, solo")
        self.assertIsNone(self.text("b"))
        self.assertEqual(self.db.captions.list_batches(self.dataset_id), [])
        self.assertEqual(
            [e.kind for e in self.container.events.events_after(0)[0][len(events_before):] if e.kind.startswith("captions")],
            [],
        )
        argv = self.calls("compose")[0]["argv"]
        self.assertEqual(argv[argv.index("--model-threshold") + 1:argv.index("--model-threshold") + 4], [MODEL, "general", "0.5"])

        result = self.from_tagger(
            mode="overwrite", thresholds={MODEL: {"general": 0.5}},
            categories=["general"], keep_underscores=True,
        ).json()
        self.assertEqual(result["stats"]["written"], 2)
        self.assertEqual(self.text("a"), "sks, long_hair")
        self.assertEqual(self.text("b"), "sks, long_hair")
        argv = self.calls("compose")[-1]["argv"]
        self.assertEqual(argv[argv.index("--categories") + 1], "general")
        self.assertIn("--keep-underscores", argv)
        batch = self.db.captions.get_batch(result["batch_id"])
        self.assertEqual(batch["kind"], "from_tagger")
        self.assertEqual(batch["params"]["mode"], "overwrite")
        self.assertEqual(batch["params"]["effective"][MODEL]["thresholds"]["general"], 0.5)

    def test_merge_keeps_manual_edits_across_runs(self) -> None:
        self.configure(scores={
            "a.png": {MODEL: [["long_hair", "general", 0.9], ["smile", "general", 0.8]]},
            "b.png": {MODEL: [["long_hair", "general", 0.9]]},
        })
        self.from_tagger(mode="overwrite")
        self.assertEqual(self.text("a"), "sks, long hair, smile")

        version = next(
            item["version"] for item in self.client.get(f"/api/v1/datasets/{self.dataset_id}/captions").json()["items"]
            if item["asset_id"] == self.ids["a"]
        )
        edited = self.client.put(
            f"/api/v1/datasets/{self.dataset_id}/captions/{self.ids['a']}",
            json={"text": "sks, long hair, red scarf", "expected_version": version},
        )
        self.assertEqual(edited.status_code, 200, edited.text)

        self.configure(scores={
            "a.png": {MODEL: [["long_hair", "general", 0.9], ["smile", "general", 0.8], ["outdoors", "general", 0.7]]},
            "b.png": {MODEL: [["short_hair", "general", 0.9]]},
        })
        result = self.from_tagger(mode="merge").json()
        self.assertEqual(result["stats"]["written"], 2)
        # a：手加的 red scarf 保留、手删的 smile 不回来、新出的 outdoors 加上
        self.assertEqual(self.text("a"), "sks, red scarf, long hair, outdoors")
        self.assertEqual(self.text("b"), "sks, short hair")

        # 撤销这次 merge 回到手改后的样子
        undo = self.client.post(f"/api/v1/caption-batches/{result['batch_id']}/undo").json()
        self.assertEqual(undo["stats"]["restored"], 2)
        self.assertEqual(self.text("a"), "sks, long hair, red scarf")

    def test_fill_empty_and_missing_scores(self) -> None:
        self.configure(scores={"a.png": {MODEL: [["long_hair", "general", 0.9]]}})
        result = self.from_tagger(mode="fill_empty").json()
        self.assertEqual(self.text("a"), "1girl, solo")
        self.assertIsNone(self.text("b"))
        self.assertEqual(result["skipped"], [{"asset_id": self.ids["b"], "reason": "missing_scores"}])
        self.assertEqual(result["stats"]["unchanged"], 1)
        self.assertIsNone(result["batch_id"])

    def test_subset_and_validation(self) -> None:
        self.configure(scores={"b.png": {MODEL: [["long_hair", "general", 0.9]]}})
        result = self.from_tagger(mode="overwrite", asset_ids=[self.ids["b"]]).json()
        self.assertEqual(result["stats"]["total"], 1)
        self.assertEqual(self.calls("compose")[0]["stdin"][0].rpartition("\t")[2], self.image("b"))
        self.assertEqual(self.text("a"), "1girl, solo")

        for body, code in (
            ({"thresholds": {"pixai-tagger-v1": {"general": 0.3}}}, "invalid_tagger_thresholds"),
            ({"thresholds": {MODEL: {"style": 0.3}}}, "invalid_tagger_thresholds"),
            ({"asset_ids": ["outsider"]}, "caption_asset_not_in_stage"),
        ):
            with self.subTest(body=body):
                response = self.from_tagger(**body)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (422, code))
        for body in ({"thresholds": {MODEL: {"general": 1.5}}}, {"mode": "replace"}, {"models": []}):
            with self.subTest(body=body):
                self.assertEqual(self.from_tagger(**body).status_code, 422)


if __name__ == "__main__":
    import unittest

    unittest.main()
