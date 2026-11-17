from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import sitecustomize  # Test-only audit hook; also used in subprocess PYTHONPATH.


EXECUTORS = Path(__file__).resolve().parents[1]
GALLERY_ROOT = EXECUTORS.parents[1] / "gallery-dl-codeberg"
sys.path[:0] = [str(EXECUTORS), str(GALLERY_ROOT)]

from ldos_gallery import worker_entry, worker_patches
from ldos_gallery.resolve import resolve


class ExecutorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {
            "PATH": os.defpath, "HOME": str(self.root),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_CACHE_HOME": str(self.root / "cache"),
            "XDG_DATA_HOME": str(self.root / "data"),
            "PYTHONNOUSERSITE": "1", "PYTHONSAFEPATH": "1",
            "PYTHONDONTWRITEBYTECODE": "1", "PYTHONIOENCODING": "utf-8",
            "PYTHONPATH": os.pathsep.join(map(str, (EXECUTORS / "tests", EXECUTORS, GALLERY_ROOT))),
        }
        self.environment = patch.dict(os.environ, self.env, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def worker(self, *args, gallery_root=GALLERY_ROOT):
        return subprocess.run(
            [sys.executable, "-m", "ldos_gallery.worker_entry",
             "--marker", "executor-test", "--gallery-root", str(gallery_root), *args],
            capture_output=True, text=True, timeout=10, cwd=self.root, env=self.env,
        )

    def test_static_known_urls_and_fallbacks(self):
        from gallery_dl import config, extractor
        from gallery_dl.extractor.common import Extractor

        cases = [
            ("https://x.com/example/status/123456789", "twitter", "x.com", True),
            ("https://pbs.twimg.com/media/example.jpg", "twitter", "pbs.twimg.com", True),
            ("https://video.twimg.com/ext_tw_video/example.mp4", "twitter", "video.twimg.com", True),
            ("https://www.example.invalid/image.jpg", "example.invalid", "example.invalid", True),
            ("generic:https://www.example.invalid/page", "example.invalid", "example.invalid", True),
            ("https://www.example.invalid/no-extractor", "example.invalid", "example.invalid", False),
            ("not a URL", "unknown", "", False),
            ("http://[broken", "unknown", "", False),
        ]
        with patch.object(config, "load", side_effect=AssertionError("config load forbidden")), \
             patch.object(Extractor, "initialize", side_effect=AssertionError("initialization forbidden")), \
             patch.object(Extractor, "__iter__", side_effect=AssertionError("iteration forbidden")), \
             patch.object(extractor, "find", wraps=extractor.find) as find:
            for url, site, host, supported in cases:
                with self.subTest(url=url):
                    info = resolve(url, GALLERY_ROOT)
                    find.assert_called_with(url)
                    self.assertEqual(set(info), {"site", "subcategory", "extractor", "supported", "host"})
                    self.assertEqual((info["site"], info["host"], info["supported"]), (site, host, supported))
                    if supported:
                        self.assertTrue(info["extractor"])
                    else:
                        self.assertEqual((info["subcategory"], info["extractor"]), ("", ""))
            tweet = resolve(cases[0][0], GALLERY_ROOT)
            self.assertEqual((tweet["subcategory"], tweet["extractor"]), ("tweet", "TwitterTweetExtractor"))
        self.assertFalse(any(name == "gdl_backend" or name.startswith("gdl_backend.") for name in sys.modules))
        self.assertEqual(list(self.root.iterdir()), [])

    def test_resolve_subprocess_protocol(self):
        result = self.worker("--resolve", "--", "https://x.com/example/status/123456789")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), dict(
            site="twitter", subcategory="tweet", extractor="TwitterTweetExtractor",
            supported=True, host="x.com",
        ))
        self.assertEqual(result.stderr, "")
        self.assertEqual(list(self.root.iterdir()), [])

    def test_entry_rejects_invalid_controls(self):
        for args in (("--resolve",), ("--resolve", "--"), ("--resolve", "--", "a", "b")):
            result = self.worker(*args)
            self.assertNotEqual(result.returncode, 0)
        result = self.worker("--resolve", "--", "url", gallery_root=self.root)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("source not found", result.stderr)

    def test_wrong_vendor_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "gallery-dl"):
            resolve("https://example.invalid", self.root)

    def test_download_entry_keeps_credential_and_patch_glue(self):
        import gallery_dl

        argv = ["worker", "--marker", "identity-marker", "--gallery-root", str(GALLERY_ROOT),
                "--", "--config-ignore", "https://example.invalid/image.jpg"]
        original_path = sys.path[:]
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), original_path))

        def main():
            self.assertEqual(sys.argv, ["gallery-dl", "--password", "test-password",
                                       "--username", "test-user", *argv[6:]])
            self.assertNotIn("GDL_WORKER_USERNAME", os.environ)
            self.assertNotIn("GDL_WORKER_PASSWORD", os.environ)
            return 7

        with patch.object(sys, "argv", argv), \
             patch.dict(os.environ, GDL_WORKER_USERNAME="test-user", GDL_WORKER_PASSWORD="test-password"), \
             patch.object(gallery_dl, "main", side_effect=main), \
             patch.object(worker_patches, "apply_all") as apply:
            self.assertEqual(worker_entry.main(), 7)
            apply.assert_called_once_with()

    def test_part_naming_matches_vendor_and_is_idempotent(self):
        from gallery_dl.path import PathFormat

        original = PathFormat.part_enable
        self.addCleanup(setattr, PathFormat, "part_enable", original)
        self.assertTrue(worker_patches.apply_part_naming_patch())
        wrapped = PathFormat.part_enable
        self.assertTrue(worker_patches.apply_part_naming_patch())
        self.assertIs(PathFormat.part_enable, wrapped)
        for part_directory in (None, str(self.root / "parts")):
            path = object.__new__(PathFormat)
            path.extension = "jpg"
            path.realpath = str(self.root / "image.jpg")
            path.temppath = str(self.root / "stale.bin")
            path.kwdict, path.prefix = {}, ""
            path.part = False
            path.part_enable(part_directory)
            expected = str(Path(part_directory) / "image.jpg.part") if part_directory else path.realpath + ".part"
            self.assertEqual(path.temppath, expected)
            path.part_enable(part_directory)
            self.assertEqual(path.temppath, expected)

    def test_heartbeat_both_vendor_receive_methods_flush_and_throttle(self):
        from gallery_dl.downloader.http import HttpDownloader

        original_receive, original_rate = HttpDownloader.receive, HttpDownloader._receive_rate
        self.addCleanup(setattr, HttpDownloader, "receive", original_receive)
        self.addCleanup(setattr, HttpDownloader, "_receive_rate", original_rate)
        for method in ("receive", "_receive_rate"):
            HttpDownloader.receive, HttpDownloader._receive_rate = original_receive, original_rate
            activity, started = self.root / (method + ".activity"), self.root / (method + ".started")
            with patch.dict(os.environ, GDL_ACTIVITY_FILE=str(activity), GDL_ACTIVITY_STARTED_FILE=str(started)):
                self.assertTrue(worker_patches.apply_activity_heartbeat_patch())
                wrapped = getattr(HttpDownloader, method)
                self.assertTrue(worker_patches.apply_activity_heartbeat_patch())
                self.assertIs(getattr(HttpDownloader, method), wrapped)
            downloader = object.__new__(HttpDownloader)
            downloader.rate = downloader.progress = None
            target = self.root / (method + ".part")
            now = [10.0]
            original_utime = os.utime

            def chunks():
                self.assertTrue(started.is_file())
                for chunk in (b"first", b"second", b"third"):
                    yield chunk
                    now[0] += 0.6

            with target.open("wb") as stream, \
                 patch.object(worker_patches.time, "monotonic", side_effect=lambda: now[0]), \
                 patch.object(worker_patches.os, "utime", wraps=original_utime) as touch:
                wrapped(downloader, stream, chunks(), 16, 0)
                self.assertEqual(target.read_bytes(), b"firstsecondthird")  # visible before close
                self.assertEqual([call.args[0] for call in touch.call_args_list].count(str(started)), 1)
                self.assertEqual([call.args[0] for call in touch.call_args_list].count(str(activity)), 2)
                self.assertTrue(activity.is_file())

    def test_patch_missing_env_and_mismatched_seam(self):
        from gallery_dl.path import PathFormat

        self.assertFalse(worker_patches.apply_activity_heartbeat_patch())
        warning = io.StringIO()
        with patch.object(PathFormat, "part_enable", lambda self: None), contextlib.redirect_stderr(warning):
            self.assertFalse(worker_patches.apply_part_naming_patch())
        self.assertIn("[gdl-backend-patch]", warning.getvalue())

    def test_external_io_guard_is_active(self):
        with self.assertRaises(AssertionError):
            socket.getaddrinfo("example.invalid", 443)
        with self.assertRaises(AssertionError):
            sqlite3.connect(str(self.root / "forbidden.sqlite"))
        self.assertFalse((self.root / "forbidden.sqlite").exists())

    def auth(self, *args, target="https://danbooru.donmai.us/posts?tags=fixture"):
        result = self.worker("--danbooru-auth", "--", "--config-ignore", "--no-input", *args, target)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        return json.loads(result.stdout)

    def test_auth_config_formats_and_effective_precedence(self):
        import base64

        configs = {
            "json": json.dumps({"extractor": {"username": "outer", "password": "outer-key", "danbooru": {
                "username": "site", "password": "site-key", "tag": {"username": "tag", "password": "tag-key"}}}}),
            "yaml": "extractor:\n  danbooru:\n    username: tag\n    password: tag-key\n",
            "toml": '[extractor.danbooru]\nusername="tag"\npassword="tag-key"\n',
        }
        for extension, content in configs.items():
            path = self.root / ("auth." + extension)
            path.write_text(content)
            with self.subTest(extension=extension):
                result = self.auth("--config-" + extension, str(path))
                self.assertEqual(result["error"], "")
                self.assertEqual(result["headers"]["Authorization"], "Basic " + base64.b64encode(b"tag:tag-key").decode())
        self.env.update(GDL_WORKER_USERNAME="env-user", GDL_WORKER_PASSWORD="env-key")
        result = self.auth("--config-json", str(self.root / "auth.json"))
        self.assertEqual(result["headers"]["Authorization"], "Basic " + base64.b64encode(b"env-user:env-key").decode())
        self.assertFalse(any(path.suffix in {".db", ".sqlite3"} for path in self.root.rglob("*")))

    def test_auth_cookie_scope_expiration_and_cli_override(self):
        cookies = self.root / "cookies.txt"
        cookies.write_text("# Netscape HTTP Cookie File\n"
                           ".donmai.us\tTRUE\t/\tTRUE\t2147483647\tsession\tvalid-secret\n"
                           "danbooru.donmai.us\tFALSE\t/\tTRUE\t1\texpired\texpired-secret\n"
                           "other.invalid\tFALSE\t/\tTRUE\t2147483647\twrong\twrong-secret\n"
                           "danbooru.donmai.us\tFALSE\t/profile\tTRUE\t2147483647\tpath\tpath-secret\n")
        path = self.root / "cookie-auth.json"
        path.write_text(json.dumps({"extractor": {"danbooru": {"cookies": {"session": "config-secret"}}}}))
        result = self.auth("--config-json", str(path), "--cookies", str(cookies))
        self.assertEqual(result["error"], "")
        self.assertEqual(result["headers"]["Cookie"], "session=valid-secret")
        cookies.write_text("# Netscape HTTP Cookie File\ndanbooru.donmai.us\tFALSE\t/\tTRUE\t1\tsession\texpired-secret\n")
        self.assertEqual(self.auth("--cookies", str(cookies)), {"headers": {}, "error": "no_valid_cookies"})

    def test_auth_artist_cookie_uses_api_endpoint_and_subcategory(self):
        path = self.root / "artist-auth.json"
        cookies = self.root / "artist-cookies.txt"
        cookies.write_text("# Netscape HTTP Cookie File\n"
                           "danbooru.donmai.us\tFALSE\t/artists\tTRUE\t2147483647\twrong\twrong-secret\n"
                           "danbooru.donmai.us\tFALSE\t/artists.json\tTRUE\t2147483647\tartist\tartist-secret\n"
                           "danbooru.donmai.us\tFALSE\t/posts.json\tTRUE\t2147483647\tpost\tpost-secret\n")
        path.write_text(json.dumps({"extractor": {"danbooru": {"artist-search": {
            "cookies": str(cookies), "headers": {"X-Category": "artist"}}}}}))
        result = self.auth("--config-json", str(path), target="https://danbooru.donmai.us/artists?search[any_name_matches]=fixture")
        self.assertEqual(result["error"], "")
        self.assertEqual(result["headers"]["Cookie"], "artist=artist-secret")
        self.assertEqual(result["headers"]["X-Category"], "artist")
        result = self.auth("--cookies", str(cookies))
        self.assertEqual(result["headers"]["Cookie"], "post=post-secret")

    def test_auth_rejects_unpreservable_explicit_configuration_safely(self):
        path = self.root / "invalid-auth.json"
        for config in (
            {"username": "private-username"},
            {"password": "private-password"},
            {"cookies": ["firefox", "private-profile"]},
            {"cookies": "private-nonexistent-cookie-file"},
            {"headers": {"Authorization": "private-token\r\ninvalid"}},
        ):
            with self.subTest(config=config):
                path.write_text(json.dumps({"extractor": {"danbooru": config}}))
                result = self.auth("--config-json", str(path))
                self.assertTrue(result["error"])
                self.assertEqual(result["headers"], {})
                self.assertNotIn("private-", json.dumps(result))
        path.write_text('{"private-secret":invalid-json}')
        result = self.auth("--config-json", str(path))
        self.assertEqual(result, {"headers": {}, "error": "invalid_configuration"})

    def test_auth_anonymous_ignores_ambient_config_and_never_initializes(self):
        from gallery_dl import config
        from gallery_dl.extractor.common import Extractor
        from ldos_gallery.danbooru_auth import resolve_auth

        ambient = self.root / "config" / "gallery-dl" / "config.json"
        ambient.parent.mkdir(parents=True)
        ambient.write_text('{"extractor":{"danbooru":{"username":"ambient-only"}}}')
        self.assertEqual(self.auth(), {"headers": {}, "error": ""})
        config.clear()
        self.addCleanup(config.clear)
        with patch.object(Extractor, "initialize", side_effect=AssertionError("initialization forbidden")), \
             patch.object(Extractor, "__iter__", side_effect=AssertionError("iteration forbidden")):
            self.assertEqual(resolve_auth(["--config-ignore", "--no-input", "https://danbooru.donmai.us/posts?tags=fixture"]), {})


if __name__ == "__main__":
    unittest.main()
