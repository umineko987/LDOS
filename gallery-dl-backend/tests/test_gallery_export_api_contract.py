from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from gdl_backend.app import ServiceContainer, create_app
from tests.helpers import local_test_client, make_settings


# docs/图库(含导出).md §7 目标路由契约（red-first：G1/G3/G5 实现前应保持失败）。
EXPECTED_GALLERY_OPERATIONS: frozenset[tuple[str, str]] = frozenset(
    {
        # §7.1 图库来源与目录
        ("GET", "/api/v1/gallery/sources"),
        ("POST", "/api/v1/gallery/imports"),
        ("PATCH", "/api/v1/gallery/sources/{source_id}"),
        ("DELETE", "/api/v1/gallery/sources/{source_id}"),
        ("POST", "/api/v1/gallery/sources/{source_id}/relink"),
        ("POST", "/api/v1/gallery/sources/{source_id}/scan"),
        ("GET", "/api/v1/gallery/sources/{source_id}/scan"),
        ("GET", "/api/v1/gallery/directories/{directory_id}/entries"),
        # §7.2 资产、TXT 与缩略图
        ("GET", "/api/v1/gallery/assets/{asset_id}"),
        ("GET", "/api/v1/gallery/assets/{asset_id}/content"),
        ("GET", "/api/v1/gallery/assets/{asset_id}/thumbnail"),
        ("GET", "/api/v1/gallery/assets/{asset_id}/annotation"),
        ("PUT", "/api/v1/gallery/assets/{asset_id}/annotation"),
        ("POST", "/api/v1/gallery/assets/{asset_id}/rename"),
        # §7.3 选择、回收与恢复
        ("POST", "/api/v1/gallery/file-operations/trash"),
        ("POST", "/api/v1/gallery/file-operations/{operation_id}/undo"),
        ("GET", "/api/v1/gallery/trash"),
        ("POST", "/api/v1/gallery/trash/{operation_id}/restore"),
        ("DELETE", "/api/v1/gallery/trash/{operation_id}"),
        ("DELETE", "/api/v1/gallery/trash"),
        # §7.4 导出任务
        ("POST", "/api/v1/dataset-exports"),
        ("GET", "/api/v1/dataset-exports"),
        ("GET", "/api/v1/dataset-exports/{export_id}"),
        ("GET", "/api/v1/dataset-exports/{export_id}/blockers"),
        ("POST", "/api/v1/dataset-exports/{export_id}/start"),
        ("POST", "/api/v1/dataset-exports/{export_id}/pause"),
        ("POST", "/api/v1/dataset-exports/{export_id}/resume"),
        ("POST", "/api/v1/dataset-exports/{export_id}/discard"),
    }
)

# 高容量读路由必须显式支持 view=desktop 安全投影（§6.4；桌面响应预算合同）。
DESKTOP_VIEW_OPERATIONS: frozenset[tuple[str, str]] = frozenset(
    {
        ("GET", "/api/v1/gallery/sources"),
        ("GET", "/api/v1/gallery/sources/{source_id}/scan"),
        ("GET", "/api/v1/gallery/directories/{directory_id}/entries"),
        ("GET", "/api/v1/gallery/assets/{asset_id}"),
        ("GET", "/api/v1/gallery/assets/{asset_id}/annotation"),
        ("GET", "/api/v1/gallery/trash"),
        ("GET", "/api/v1/dataset-exports"),
        ("GET", "/api/v1/dataset-exports/{export_id}"),
        ("GET", "/api/v1/dataset-exports/{export_id}/blockers"),
    }
)

# 稳定错误码合同（§7.2/§8.2：固定分类 + 安全相对路径，不泄绝对路径）。
EXPECTED_ERROR_CODES: frozenset[str] = frozenset(
    {
        "source_not_found",
        "source_path_conflict",
        "source_offline",
        "directory_not_found",
        "asset_not_found",
        "txt_version_conflict",
        "txt_invalid_encoding",
        "rename_target_conflict",
        "operation_not_found",
        "operation_version_mismatch",
        "restore_target_conflict",
        "export_not_found",
        "export_state_invalid",
        "export_target_conflict",
        "export_disk_space_insufficient",
        "export_snapshot_stale",
    }
)


class GalleryExportApiContractTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = make_settings(Path(self.temp.name))
        self.container = ServiceContainer(self.settings)
        self.app = create_app(
            self.settings,
            container=self.container,
            start_background=False,
        )
        self.client_context = local_test_client(self.app, self.settings)
        self.client = self.client_context.__enter__()

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.temp.cleanup()

    def _openapi_operations(self) -> dict[tuple[str, str], dict]:
        operations: dict[tuple[str, str], dict] = {}
        for path, path_item in self.app.openapi()["paths"].items():
            for method, operation in path_item.items():
                if method not in {"get", "post", "put", "delete", "patch"}:
                    continue
                operations[(method.upper(), path)] = operation
        return operations

    def test_gallery_and_export_target_routes_exist(self) -> None:
        actual = set(self._openapi_operations())
        missing = sorted(EXPECTED_GALLERY_OPERATIONS - actual)
        self.assertEqual(
            missing,
            [],
            "图库/导出目标路由尚未实现（docs/图库(含导出).md §7；G1/G3/G5 落地）",
        )

    def test_high_volume_reads_declare_desktop_projection_view(self) -> None:
        operations = self._openapi_operations()
        missing_view = []
        for key in sorted(DESKTOP_VIEW_OPERATIONS):
            operation = operations.get(key)
            if operation is None:
                missing_view.append(key)
                continue
            parameters = operation.get("parameters", [])
            view_schemas = [
                parameter.get("schema", {})
                for parameter in parameters
                if parameter.get("name") == "view"
                and parameter.get("in") == "query"
            ]
            # 单值 Literal 在 OpenAPI 3.1 下生成 const（比 enum 更严格），
            # 两者都满足“只接受 desktop 投影”的合同意图。
            if not any(
                "desktop" in (schema.get("enum") or [])
                or schema.get("const") == "desktop"
                for schema in view_schemas
            ):
                missing_view.append(key)
        self.assertEqual(
            missing_view,
            [],
            "高容量读路由必须声明 view=desktop 安全投影",
        )

    def test_stable_error_codes_are_served_for_missing_entities(self) -> None:
        cases = (
            ("get", "/api/v1/gallery/sources/missing-source", 404, "source_not_found"),
            ("get", "/api/v1/gallery/assets/missing-asset", 404, "asset_not_found"),
            (
                "get",
                "/api/v1/gallery/directories/missing-directory/entries",
                404,
                "directory_not_found",
            ),
            ("get", "/api/v1/dataset-exports/missing-export", 404, "export_not_found"),
        )
        served_codes = set()
        for method, path, status, code in cases:
            with self.subTest(path=path):
                response = self.client.request(method, path)
                self.assertEqual(response.status_code, status, response.text)
                self.assertEqual(set(response.json()), {"error"})
                error = response.json()["error"]
                self.assertEqual(set(error), {"code", "message", "details", "request_id"})
                self.assertEqual(error["code"], code)
                served_codes.add(code)
        self.assertTrue(served_codes.issubset(EXPECTED_ERROR_CODES))


if __name__ == "__main__":
    unittest.main()
