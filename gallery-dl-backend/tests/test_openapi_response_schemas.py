from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


WORKSPACE = Path(__file__).resolve().parents[2]
SCRIPT = WORKSPACE / "scripts" / "export_openapi.py"

# 带这些键之一的 JSON schema 才算声明了形状；只有 title 的 {} 生成出来是 unknown。
_SCHEMA_SHAPE_KEYS = frozenset({"$ref", "type", "anyOf", "oneOf", "allOf", "const", "enum"})


def _load_exporter():
    spec = importlib.util.spec_from_file_location("ldos_export_openapi_schemas", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def undeclared_responses(document: dict) -> list[str]:
    """列出 /api/v1 下 2xx 响应既不是空体、也没声明非 JSON 媒体类型或 JSON 形状的操作。"""

    offenders: list[str] = []
    for path, operations in sorted(document.get("paths", {}).items()):
        if not path.startswith("/api/v1"):
            continue
        for method, operation in sorted(operations.items()):
            for status, response in sorted(operation.get("responses", {}).items()):
                if not str(status).startswith("2"):
                    continue
                content = response.get("content") or {}
                if not content:
                    continue
                if any(media_type != "application/json" for media_type in content):
                    continue
                schema = content["application/json"].get("schema") or {}
                if _SCHEMA_SHAPE_KEYS & set(schema):
                    continue
                offenders.append(f"{method.upper()} {path} {status}")
    return offenders


class OpenApiResponseSchemaTests(unittest.TestCase):
    """前端从 OpenAPI 生成类型；没声明响应的路由在前端只能拿到 unknown。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls.document = _load_exporter().build_document()

    def test_every_api_v1_success_response_declares_its_body(self) -> None:
        offenders = undeclared_responses(self.document)
        self.assertEqual(
            offenders,
            [],
            "这些 /api/v1 操作的 2xx 响应没有声明形状（JSON 用 response_model，"
            "文件用 response_class + responses 写明媒体类型）：\n" + "\n".join(offenders),
        )

    def test_checker_flags_untyped_json_and_accepts_binary_and_empty_bodies(self) -> None:
        document = {
            "paths": {
                "/api/v1/untyped": {"get": {"responses": {"200": {"content": {
                    "application/json": {"schema": {"title": "Response"}},
                }}}}},
                "/api/v1/typed": {"get": {"responses": {"200": {"content": {
                    "application/json": {"schema": {"$ref": "#/components/schemas/X"}},
                }}}}},
                "/api/v1/file": {"get": {"responses": {"200": {"content": {"image/*": {}}}}}},
                "/api/v1/empty": {"delete": {"responses": {"204": {"description": "No Content"}}}},
                "/legacy": {"get": {"responses": {"200": {"content": {"application/json": {"schema": {}}}}}}},
            },
        }
        self.assertEqual(undeclared_responses(document), ["GET /api/v1/untyped 200"])


if __name__ == "__main__":
    unittest.main()
