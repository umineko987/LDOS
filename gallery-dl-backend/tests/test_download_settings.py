from __future__ import annotations

import json
import logging
import os
import stat
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from fastapi.testclient import TestClient

from gdl_backend.app import ServiceContainer, create_app
from gdl_backend.download_settings import (
    DownloadProxyUnavailable,
    DownloadSettingsError,
    DownloadSettingsStore,
    normalize_hf_mirror,
)
from tests.helpers import local_test_client, make_settings


TOKEN = "hf_TestToken0123456789abcd"


class FakeProxyPool:
    def __init__(self, endpoint: str | None = "http://127.0.0.1:20001", error: Exception | None = None) -> None:
        self.endpoint = endpoint
        self.error = error
        self.acquired: list[str] = []
        self.released: list[tuple[str, bool, str]] = []

    def acquire(self, owner: str):
        if self.error is not None:
            raise self.error
        self.acquired.append(owner)
        return SimpleNamespace(endpoint=self.endpoint) if self.endpoint is not None else None

    def release(self, owner: str, *, proxy_fault: bool, reason: str = "") -> None:
        self.released.append((owner, proxy_fault, reason))


class CapturingHandler(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self.format(record))


class DownloadSettingsStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.runtime = Path(self._tmp.name) / "runtime"
        self.pool = FakeProxyPool()
        self.store = DownloadSettingsStore(self.runtime, proxy=self.pool)

    def test_defaults_without_files(self) -> None:
        self.assertEqual(self.store.view(), {
            "hf_mirror": None, "proxy_mode": "none", "custom_proxy": None,
            "custom_proxy_has_credentials": False, "token_set": False,
        })
        self.assertIsNone(self.store.token())

    def test_round_trip_and_partial_updates(self) -> None:
        view = self.store.update(hf_mirror=" https://hf-mirror.example/ ", proxy_mode="custom",
                                 custom_proxy=" http://127.0.0.1:7890/ ")
        self.assertEqual(view["hf_mirror"], "https://hf-mirror.example")
        self.assertEqual(view["proxy_mode"], "custom")
        self.assertEqual(view["custom_proxy"], "http://127.0.0.1:7890")
        # 只改一项时其余保持不变
        view = self.store.update(proxy_mode="pool")
        self.assertEqual((view["hf_mirror"], view["proxy_mode"], view["custom_proxy"]),
                         ("https://hf-mirror.example", "pool", "http://127.0.0.1:7890"))
        reloaded = DownloadSettingsStore(self.runtime).load()
        self.assertEqual(reloaded.proxy_mode, "pool")
        self.assertEqual(reloaded.hf_mirror, "https://hf-mirror.example")
        view = self.store.update(hf_mirror="")
        self.assertIsNone(view["hf_mirror"])

    def test_settings_file_is_private(self) -> None:
        self.store.update(hf_mirror="https://hf-mirror.example")
        if os.name != "nt":
            mode = stat.S_IMODE((self.runtime / "download-settings.json").stat().st_mode)
            self.assertEqual(mode, 0o600)

    def test_mirror_validation(self) -> None:
        self.assertIsNone(normalize_hf_mirror("  "))
        self.assertEqual(normalize_hf_mirror("http://10.0.0.2:8080/hf/"), "http://10.0.0.2:8080/hf")
        for value in ("file:///tmp", "https://user:pass@mirror.example", "https://mirror.example?token=x",
                      "https://mirror.example#frag", "https://mirror.example:bad", "ftp://mirror.example",
                      "https://mirror .example", "https://" + "a" * 300 + ".example"):
            with self.subTest(value=value):
                with self.assertRaises(DownloadSettingsError) as caught:
                    self.store.update(hf_mirror=value)
                self.assertEqual(caught.exception.code, "invalid_hf_mirror")

    def test_proxy_mode_validation_matches_download_proxy_rules(self) -> None:
        with self.assertRaises(DownloadSettingsError) as caught:
            self.store.update(proxy_mode="socks")
        self.assertEqual(caught.exception.code, "invalid_download_proxy_mode")
        with self.assertRaises(DownloadSettingsError) as caught:
            self.store.update(proxy_mode="custom")
        self.assertEqual(caught.exception.code, "invalid_download_proxy")
        for proxy in ("socks5://127.0.0.1:7890", "file:///tmp", "127.0.0.1:7890", "http://localhost",
                      "http://localhost:bad", "http://localhost:99999", "http://localhost:7890/path",
                      "http://localhost:7890?key=value", "http://localhost:7890#fragment", "http://local host:7890"):
            with self.subTest(proxy=proxy):
                with self.assertRaises(DownloadSettingsError) as caught:
                    self.store.update(proxy_mode="custom", custom_proxy=proxy)
                self.assertEqual(caught.exception.code, "invalid_download_proxy")
        # 失败的更新不落盘
        self.assertEqual(self.store.view()["proxy_mode"], "none")
        # 清空自定义地址时，custom 模式不能保留
        self.store.update(proxy_mode="custom", custom_proxy="http://127.0.0.1:7890")
        with self.assertRaises(DownloadSettingsError):
            self.store.update(custom_proxy="")
        self.assertEqual(self.store.update(proxy_mode="none", custom_proxy="")["custom_proxy"], None)

    def test_custom_proxy_credentials_are_masked_in_view(self) -> None:
        view = self.store.update(proxy_mode="custom", custom_proxy="http://alice:s3cret@127.0.0.1:7890")
        self.assertTrue(view["custom_proxy_has_credentials"])
        self.assertNotIn("s3cret", json.dumps(view))
        self.assertNotIn("alice", json.dumps(view))
        # 实际下载仍用完整地址
        self.assertEqual(self.store.resolve("owner").proxy, "http://alice:s3cret@127.0.0.1:7890")

    def test_token_is_write_only_and_private(self) -> None:
        view = self.store.update(hf_token=f"  {TOKEN}  ")
        self.assertTrue(view["token_set"])
        # 只说有没有：连末几位也不回显
        self.assertNotIn("token_hint", view)
        self.assertNotIn(TOKEN[-4:], json.dumps(view))
        self.assertEqual(self.store.token(), TOKEN)
        token_path = self.runtime / "hf-token"
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(token_path.stat().st_mode), 0o600)
        # token 不写进设置文件
        self.assertNotIn(TOKEN, (self.runtime / "download-settings.json").read_text(encoding="utf-8"))
        # 不传 hf_token 时保持不变
        self.store.update(hf_mirror="https://hf-mirror.example")
        self.assertEqual(self.store.token(), TOKEN)
        cleared = self.store.update(hf_token=None)
        self.assertFalse(cleared["token_set"])
        self.assertFalse(token_path.exists())
        self.store.update(hf_token=None)  # 重复清除无副作用

    def test_token_repr_and_validation(self) -> None:
        self.store.update(hf_token=TOKEN)
        self.assertNotIn(TOKEN, repr(self.store.resolve("owner")))
        for value in ("", "   ", "hf_bad token", "hf_\x00", "x" * 8193):
            with self.subTest(value=value[:12]):
                with self.assertRaises(DownloadSettingsError) as caught:
                    self.store.update(hf_token=value)
                self.assertEqual(caught.exception.code, "invalid_hf_token")
        self.assertEqual(self.store.token(), TOKEN)

    @unittest.skipIf(os.name == "nt", "symlinks need privileges on Windows")
    def test_token_symlink_is_ignored(self) -> None:
        self.runtime.mkdir(parents=True)
        target = Path(self._tmp.name) / "elsewhere"
        target.write_text(TOKEN, encoding="utf-8")
        (self.runtime / "hf-token").symlink_to(target)
        self.assertIsNone(self.store.token())
        self.assertFalse(self.store.view()["token_set"])

    def test_corrupt_settings_fall_back_to_defaults(self) -> None:
        self.runtime.mkdir(parents=True)
        path = self.runtime / "download-settings.json"
        for content in ("{not json", "[]", json.dumps({"proxy_mode": "custom", "custom_proxy": "socks5://x:1"}),
                        json.dumps({"proxy_mode": "bogus", "hf_mirror": "file:///etc"})):
            with self.subTest(content=content):
                path.write_text(content, encoding="utf-8")
                settings = self.store.load()
                self.assertEqual((settings.hf_mirror, settings.proxy_mode, settings.custom_proxy), (None, "none", None))

    def test_resolve_modes_and_explicit_overrides(self) -> None:
        self.store.update(hf_mirror="https://hf-mirror.example", hf_token=TOKEN)
        environment = self.store.resolve("owner")
        self.assertEqual((environment.hf_endpoint, environment.proxy, environment.token, environment.proxy_source),
                         ("https://hf-mirror.example", None, TOKEN, "none"))
        self.store.update(proxy_mode="custom", custom_proxy="http://127.0.0.1:7890")
        self.assertEqual(self.store.resolve("owner").proxy, "http://127.0.0.1:7890")
        # 显式参数（包括 None）优先于统一设置
        environment = self.store.resolve("owner", token=None, hf_mirror=None, proxy=None)
        self.assertEqual((environment.hf_endpoint, environment.proxy, environment.token, environment.proxy_source),
                         (None, None, None, "none"))
        environment = self.store.resolve("owner", token="hf_other", hf_mirror="https://m.example",
                                         proxy="http://10.0.0.1:3128")
        self.assertEqual((environment.hf_endpoint, environment.proxy, environment.token, environment.proxy_source),
                         ("https://m.example", "http://10.0.0.1:3128", "hf_other", "custom"))
        self.assertEqual(self.pool.acquired, [])

    def test_pool_mode_leases_and_releases(self) -> None:
        self.store.update(proxy_mode="pool")
        environment = self.store.resolve("models:test")
        self.assertEqual((environment.proxy, environment.proxy_source, environment.lease_owner),
                         ("http://127.0.0.1:20001", "pool", "models:test"))
        self.assertEqual(self.pool.acquired, ["models:test"])
        self.store.release(environment)
        self.assertEqual(self.pool.released, [("models:test", False, "model_download_finished")])
        # 显式代理不租节点
        self.store.resolve("explicit", proxy="http://127.0.0.1:7890")
        self.assertEqual(self.pool.acquired, ["models:test"])

    def test_pool_mode_unavailable(self) -> None:
        for store in (
            DownloadSettingsStore(self.runtime, proxy=None),
            DownloadSettingsStore(self.runtime, proxy=FakeProxyPool(endpoint=None)),
            DownloadSettingsStore(self.runtime, proxy=FakeProxyPool(error=RuntimeError("core http://u:p@x:1 down"))),
        ):
            store.update(proxy_mode="pool")
            with self.subTest(store=store):
                with self.assertRaises(DownloadProxyUnavailable) as caught:
                    store.resolve("owner")
                self.assertNotIn("u:p@", str(caught.exception))


class DownloadSettingsApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.settings = make_settings(self.root)
        self.container = ServiceContainer(self.settings)
        self.app = create_app(self.settings, container=self.container, start_background=False)
        context = local_test_client(self.app, self.settings)
        self.client: TestClient = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        self.logs = CapturingHandler()
        self.logs.setFormatter(logging.Formatter("%(name)s %(message)s %(args)s"))
        root_logger = logging.getLogger()
        previous_level = root_logger.level
        root_logger.addHandler(self.logs)
        root_logger.setLevel(logging.DEBUG)
        self.addCleanup(root_logger.setLevel, previous_level)
        self.addCleanup(root_logger.removeHandler, self.logs)

    def test_get_defaults(self) -> None:
        response = self.client.get("/api/v1/settings/downloads")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "hf_mirror": None, "proxy_mode": "none", "custom_proxy": None,
            "custom_proxy_has_credentials": False, "token_set": False,
        })

    def test_put_round_trip(self) -> None:
        response = self.client.put("/api/v1/settings/downloads", json={
            "hf_mirror": "https://hf-mirror.example/", "proxy_mode": "custom",
            "custom_proxy": "http://127.0.0.1:7890",
        })
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual((body["hf_mirror"], body["proxy_mode"], body["custom_proxy"]),
                         ("https://hf-mirror.example", "custom", "http://127.0.0.1:7890"))
        self.assertEqual(self.client.get("/api/v1/settings/downloads").json(), body)
        # 只发一项时其他不变
        body = self.client.put("/api/v1/settings/downloads", json={"proxy_mode": "pool"}).json()
        self.assertEqual((body["hf_mirror"], body["proxy_mode"]), ("https://hf-mirror.example", "pool"))
        self.assertEqual(self.client.put("/api/v1/settings/downloads", json={"hf_mirror": None}).json()["hf_mirror"], None)

    def test_put_rejects_invalid_values(self) -> None:
        cases = (
            ({"proxy_mode": "custom"}, "invalid_download_proxy"),
            ({"proxy_mode": "custom", "custom_proxy": "socks5://127.0.0.1:1080"}, "invalid_download_proxy"),
            ({"hf_mirror": "file:///etc"}, "invalid_hf_mirror"),
            ({"hf_token": "   "}, "invalid_hf_token"),
            ({"hf_token": TOKEN, "clear_hf_token": True}, "invalid_hf_token"),
            ({"proxy_mode": "socks"}, "validation_error"),
            ({"unexpected": 1}, "validation_error"),
        )
        for payload, code in cases:
            with self.subTest(payload=payload):
                response = self.client.put("/api/v1/settings/downloads", json=payload)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json()["error"]["code"], code)
        self.assertEqual(self.client.get("/api/v1/settings/downloads").json()["proxy_mode"], "none")

    def test_token_never_leaves_the_backend(self) -> None:
        response = self.client.put("/api/v1/settings/downloads", json={"hf_token": TOKEN})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(TOKEN, response.text)
        self.assertEqual(response.json()["token_set"], True)
        self.assertNotIn(TOKEN[-4:], response.text)
        self.assertNotIn(TOKEN[-4:], self.client.get("/api/v1/settings/downloads").text)
        token_path = self.settings.runtime_dir / "hf-token"
        self.assertEqual(token_path.read_text(encoding="utf-8").strip(), TOKEN)
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(token_path.stat().st_mode), 0o600)
        # 校验失败时不回显提交的原文
        oversized = TOKEN + "x" * 8192
        response = self.client.put("/api/v1/settings/downloads", json={"hf_token": oversized, "extra": TOKEN})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(TOKEN, response.text)
        response = self.client.put("/api/v1/settings/downloads", json={"hf_token": TOKEN + " x"})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn(TOKEN, response.text)
        self.assertNotIn(TOKEN, self.client.get("/api/v1/config").text)
        response = self.client.put("/api/v1/settings/downloads", json={"clear_hf_token": True})
        self.assertFalse(response.json()["token_set"])
        self.assertFalse(token_path.exists())
        self.assertFalse(any(TOKEN in line for line in self.logs.lines), self.logs.lines)

    def test_custom_proxy_password_is_masked(self) -> None:
        response = self.client.put("/api/v1/settings/downloads", json={
            "proxy_mode": "custom", "custom_proxy": "http://alice:s3cret@127.0.0.1:7890",
        })
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("s3cret", response.text)
        self.assertTrue(response.json()["custom_proxy_has_credentials"])
        self.assertNotIn("s3cret", self.client.get("/api/v1/settings/downloads").text)


if __name__ == "__main__":
    unittest.main()
