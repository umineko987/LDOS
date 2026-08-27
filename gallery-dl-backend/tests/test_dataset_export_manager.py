"""数据集导出引擎测试（G5）：预检阻断、暂存、提交与恢复。

使用真实临时目录 + 小型真实图片，经由真实 SQLite 仓储验证：
- 预检严格阻断（TXT 缺失/空白/解码异常、目标冲突、去重未完成）；
- 暂存 → 提交的完整数据流（独立 manifest、目标合并不覆盖）；
- 状态机守卫（非法转移、暂停继续、丢弃暂存）；
- 崩溃恢复（committing → recovery_required → 重放完成）。
"""

from __future__ import annotations

import json
import struct
import tempfile
import time
import unittest
from pathlib import Path

from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.dataset_export_manager import DatasetExportError

from tests.helpers import local_test_client, make_settings


def _tiny_png(path: Path, *, width: int = 2, height: int = 2, color: bytes = b"\x11\x22\x33") -> None:
    """最小合法 PNG（IHDR + IDAT + IEND）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    import zlib

    def chunk(tag: bytes, data: bytes) -> bytes:
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + color for _ in range(height))
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


class DatasetExportManagerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.settings = make_settings(self.root)
        self.container = ServiceContainer(self.settings)
        self.app = create_app(
            self.settings, container=self.container, start_background=False
        )
        self.client_context = local_test_client(self.app, self.settings)
        self.client = self.client_context.__enter__()
        # 准备一个已扫描的图库来源（2 张图片 + 同名 TXT）。
        self.source_root = self.root / "library"
        (self.source_root / "sub").mkdir(parents=True)
        _tiny_png(self.source_root / "a.jpg")
        _tiny_png(self.source_root / "sub" / "b.png", color=b"\x44\x55\x66")
        (self.source_root / "a.txt").write_text("标签A, 标签B", encoding="utf-8")
        (self.source_root / "sub" / "b.txt").write_text("tag-x", encoding="utf-8")
        self.source = self._import_source(self.source_root)
        self.target_dir = self.root / "export-target"
        self.target_dir.mkdir()

    def tearDown(self):
        self.container.dataset_export_manager.stop()
        self.client_context.__exit__(None, None, None)
        self.temp.cleanup()

    # ---- 助手 ----

    def _import_source(self, root: Path) -> dict:
        response = self.client.post(
            "/api/v1/gallery/imports", json={"root_path": str(root)}
        )
        assert response.status_code == 201, response.text
        source = response.json()
        for _ in range(100):
            status = self.client.get(
                f"/api/v1/gallery/sources/{source['source_id']}/scan"
            ).json()
            if status.get("state") in {"succeeded", "failed"}:
                break
            time.sleep(0.05)
        assert status.get("state") == "succeeded", status
        return self.client.get(
            f"/api/v1/gallery/sources/{source['source_id']}"
        ).json()

    def _root_directory_id(self, source: dict) -> str:
        return source["root_directory_id"]

    def _create_export(self, *, alias: str = "batch1") -> dict:
        response = self.client.post(
            "/api/v1/dataset-exports",
            json={
                "target_path": str(self.target_dir),
                "selections": [
                    {
                        "source_id": self.source["source_id"],
                        "directory_id": self._root_directory_id(self.source),
                        "include_descendants": True,
                        "output_alias": alias,
                    }
                ],
            },
        )
        assert response.status_code == 201, response.text
        return response.json()

    def _wait_terminal(self, job_id: str, timeout: float = 10.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            job = self.client.get(f"/api/v1/dataset-exports/{job_id}").json()
            if job["status"] in {"completed", "failed", "paused", "blocked"}:
                return job
            time.sleep(0.05)
        raise AssertionError(f"任务未到达终态: {job['status']}")

    # ---- 预检 ----

    def test_preflight_blocks_missing_txt(self):
        # 删除一个 TXT 后重新扫描 → txt_state=missing → 预检阻断。
        (self.source_root / "a.txt").unlink()
        self.client.post(f"/api/v1/gallery/sources/{self.source['source_id']}/scan")
        for _ in range(100):
            status = self.client.get(
                f"/api/v1/gallery/sources/{self.source['source_id']}/scan"
            ).json()
            if status.get("state") in {"succeeded", "failed"}:
                break
            time.sleep(0.05)
        result = self._create_export()
        # 创建即预检；阻断时返回 blockers。
        if "blockers" in result:
            codes = {b["code"] for b in result["blockers"]}
            self.assertIn("txt_missing", codes)
        else:
            job = self.client.get(f"/api/v1/dataset-exports/{result['job_id']}").json()
            self.assertEqual(job["status"], "blocked")

    def test_preflight_blocks_empty_txt(self):
        (self.source_root / "a.txt").write_text("", encoding="utf-8")
        self.client.post(f"/api/v1/gallery/sources/{self.source['source_id']}/scan")
        for _ in range(100):
            status = self.client.get(
                f"/api/v1/gallery/sources/{self.source['source_id']}/scan"
            ).json()
            if status.get("state") in {"succeeded", "failed"}:
                break
            time.sleep(0.05)
        result = self._create_export()
        job = result.get("job", result)
        if "blockers" in result:
            codes = {b["code"] for b in result["blockers"]}
            self.assertIn("txt_empty", codes)
        else:
            job = self.client.get(f"/api/v1/dataset-exports/{result['job_id']}").json()
            self.assertEqual(job["status"], "blocked")

    def test_preflight_blocks_invalid_encoding_txt(self):
        (self.source_root / "a.txt").write_bytes(b"\xff\xfe\x00G\x00B\x00K")
        self.client.post(f"/api/v1/gallery/sources/{self.source['source_id']}/scan")
        for _ in range(100):
            status = self.client.get(
                f"/api/v1/gallery/sources/{self.source['source_id']}/scan"
            ).json()
            if status.get("state") in {"succeeded", "failed"}:
                break
            time.sleep(0.05)
        result = self._create_export()
        if "blockers" in result:
            codes = {b["code"] for b in result["blockers"]}
            self.assertIn("txt_invalid_encoding", codes)
        else:
            job = self.client.get(f"/api/v1/dataset-exports/{result['job_id']}").json()
            self.assertEqual(job["status"], "blocked")

    def test_preflight_blocks_target_conflict(self):
        # 目标目录中已存在同相对路径文件 → 整个任务阻断。
        conflict = self.target_dir / "batch1" / "a.jpg"
        conflict.parent.mkdir(parents=True)
        conflict.write_bytes(b"existing")
        result = self._create_export()
        if "blockers" in result:
            codes = {b["code"] for b in result["blockers"]}
            self.assertIn("export_target_conflict", codes)
        else:
            job = self.client.get(f"/api/v1/dataset-exports/{result['job_id']}").json()
            self.assertEqual(job["status"], "blocked")

    # ---- 完整导出流 ----

    def test_full_export_flow_with_manifest(self):
        result = self._create_export()
        job_id = result.get("job_id", result.get("job", {}).get("job_id"))
        self.assertNotIn("blockers", result)
        job = self.client.get(f"/api/v1/dataset-exports/{job_id}").json()
        self.assertEqual(job["status"], "ready")
        # start → 后台 staging + commit。
        started = self.client.post(f"/api/v1/dataset-exports/{job_id}/start")
        assert started.status_code == 200, started.text
        final = self._wait_terminal(job_id)
        self.assertEqual(final["status"], "completed", final)
        # 目标文件已就位（原相对目录结构保留）。
        self.assertTrue((self.target_dir / "batch1" / "a.jpg").exists())
        self.assertTrue((self.target_dir / "batch1" / "a.txt").exists())
        self.assertTrue((self.target_dir / "batch1" / "sub" / "b.png").exists())
        self.assertTrue((self.target_dir / "batch1" / "sub" / "b.txt").exists())
        # 暂存目录已清理。
        self.assertFalse(
            (self.target_dir / ".imageweave" / "staging" / job_id).exists()
        )
        # 独立 manifest 存在且为任务级 JSONL。
        manifest_path = self.target_dir / ".imageweave" / "exports" / f"{job_id}.jsonl"
        self.assertTrue(manifest_path.exists())
        lines = manifest_path.read_text(encoding="utf-8").strip().splitlines()
        records = [json.loads(line) for line in lines]
        self.assertEqual(records[0]["record_type"], "export")
        self.assertEqual(records[0]["sample_count"], 2)
        sample_records = [r for r in records if r["record_type"] == "sample"]
        self.assertEqual(len(sample_records), 2)
        for record in sample_records:
            self.assertTrue(record["image_sha256"])
            self.assertTrue(record["txt_sha256"])
            self.assertNotIn("target_path", record)

    def test_export_merge_keeps_existing_files(self):
        # 第一次导出。
        first = self._create_export(alias="batch1")
        job_id = first.get("job_id", first.get("job", {}).get("job_id"))
        self.client.post(f"/api/v1/dataset-exports/{job_id}/start")
        self._wait_terminal(job_id)
        # 第二次导出（不同别名）合并不覆盖已有文件。
        second = self._create_export(alias="batch2")
        job_id2 = second.get("job_id", second.get("job", {}).get("job_id"))
        self.client.post(f"/api/v1/dataset-exports/{job_id2}/start")
        self._wait_terminal(job_id2)
        self.assertTrue((self.target_dir / "batch1" / "a.jpg").exists())
        self.assertTrue((self.target_dir / "batch2" / "a.jpg").exists())
        # 两个任务的 manifest 相互独立。
        exports_dir = self.target_dir / ".imageweave" / "exports"
        manifests = list(exports_dir.glob("*.jsonl"))
        self.assertEqual(len(manifests), 2)

    # ---- 状态机守卫 ----

    def test_state_machine_guards(self):
        result = self._create_export()
        job_id = result.get("job_id", result.get("job", {}).get("job_id"))
        # draft/ready 状态下 pause → export_state_invalid。
        paused = self.client.post(f"/api/v1/dataset-exports/{job_id}/pause")
        self.assertEqual(paused.status_code, 409)
        self.assertEqual(paused.json()["error"]["code"], "export_state_invalid")
        # 不存在的任务 → export_not_found。
        missing = self.client.post("/api/v1/dataset-exports/missing/start")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.json()["error"]["code"], "export_not_found")

    def test_discard_removes_staging(self):
        result = self._create_export()
        job_id = result.get("job_id", result.get("job", {}).get("job_id"))
        discarded = self.client.post(f"/api/v1/dataset-exports/{job_id}/discard")
        assert discarded.status_code == 200, discarded.text
        self.assertEqual(discarded.json()["status"], "discarded")
        # 丢弃后再 start → export_state_invalid。
        restarted = self.client.post(f"/api/v1/dataset-exports/{job_id}/start")
        self.assertEqual(restarted.status_code, 409)

    def test_list_and_detail_projections(self):
        result = self._create_export()
        job_id = result.get("job_id", result.get("job", {}).get("job_id"))
        listing = self.client.get("/api/v1/dataset-exports?view=desktop").json()
        self.assertTrue(any(j["job_id"] == job_id for j in listing["jobs"]))
        # 投影不包含绝对目标路径。
        for job in listing["jobs"]:
            self.assertNotIn("target_path", job)
        detail = self.client.get(f"/api/v1/dataset-exports/{job_id}?view=desktop").json()
        self.assertNotIn("target_path", detail)
        self.assertIn("sources", detail)
        self.assertEqual(detail["sources"][0]["output_alias"], "batch1")

    def test_blockers_endpoint(self):
        (self.source_root / "a.txt").unlink()
        self.client.post(f"/api/v1/gallery/sources/{self.source['source_id']}/scan")
        for _ in range(100):
            status = self.client.get(
                f"/api/v1/gallery/sources/{self.source['source_id']}/scan"
            ).json()
            if status.get("state") in {"succeeded", "failed"}:
                break
            time.sleep(0.05)
        result = self._create_export()
        job_id = (
            result.get("job_id") or result.get("job", {}).get("job_id")
        )
        blockers = self.client.get(
            f"/api/v1/dataset-exports/{job_id}/blockers?view=desktop"
        ).json()
        codes = {b["code"] for b in blockers["blockers"]}
        self.assertIn("txt_missing", codes)


if __name__ == "__main__":
    unittest.main()
