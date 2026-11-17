"""Development-only oracle recorder; Go tests consume oracle.json without Python.

Run from any directory with Python's standard library. It executes only pure
transform tests and synthetic inputs; no service imports, network or real data.
"""
from pathlib import Path
import ast
import copy
import importlib
import inspect
import json
import sys
import types
import unittest

root = Path(__file__).resolve().parents[4]
package = types.ModuleType("gdl_backend")
package.__path__ = [str(root / "gallery-dl-backend/gdl_backend")]
sys.modules["gdl_backend"] = package
module = importlib.import_module("gdl_backend.discovery_transforms")
records = []
names = ["canonical_gallery_address", "classify_external_profile", "discovery_addresses", "danbooru_alias_terms", "merge_alias_search_results", "exhentai_tag_facets", "parse_discovery_output", "validate_discovery_args", "_pixiv_first_media_args", "search_site_catalog"]

def record(name, fn):
    def wrapped(*args, **kwargs):
        bound = inspect.signature(fn).bind(*args, **kwargs)
        bound.apply_defaults()
        item = {"op": name, "input": copy.deepcopy(dict(bound.arguments))}
        try:
            result = fn(*args, **kwargs)
            item["output"] = copy.deepcopy(result)
            return result
        except Exception as exc:
            item["error"] = {"message": str(exc), "code": getattr(exc, "code", ""), "details": getattr(exc, "details", None)}
            raise
        finally:
            records.append(item)
    return wrapped

scope = {name: record(name, getattr(module, name)) for name in names}
scope.update(json=json, unittest=unittest, DiscoveryError=module.DiscoveryError, search_site=module.search_site)
# Extract only the tests that exercise this module, without importing services.
for filename in ["test_discovery_transforms.py", "test_discovery.py"]:
    tree = ast.parse((root / "gallery-dl-backend/tests" / filename).read_text())
    methods = []
    for cls in tree.body:
        if not isinstance(cls, ast.ClassDef):
            continue
        for method in cls.body:
            if not isinstance(method, ast.FunctionDef) or not method.name.startswith("test_"):
                continue
            text = ast.unparse(method)
            if "DiscoveryService" in text or "GalleryRunner" in text or "ProxyLease" in text or "make_settings" in text:
                continue
            if not any(name in text for name in names):
                continue
            # Local compatibility-facade imports resolve to the same pure functions.
            method.body = [node for node in method.body if not isinstance(node, (ast.Import, ast.ImportFrom))]
            methods.append(method)
    cls = ast.ClassDef(name="PureTests", bases=[ast.Attribute(value=ast.Name(id="unittest", ctx=ast.Load()), attr="TestCase", ctx=ast.Load())], keywords=[], body=methods, decorator_list=[])
    code = ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[]))
    exec(compile(code, filename, "exec"), scope)
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(scope["PureTests"])
    result = unittest.TextTestRunner().run(suite)
    if not result.wasSuccessful():
        raise SystemExit(1)

def call(name, *args, **kwargs):
    try:
        return scope[name](*args, **kwargs)
    except (ValueError, module.DiscoveryError):
        pass

call("search_site_catalog")
for args in [[], ["--filter", "x", "--filter=y"], ["--filter=x", "--filter", "y"], ["--filter"], ["--filter="], ["--filter", ""]]:
    call("_pixiv_first_media_args", args)
for arg in module._DISCOVERY_MANAGED_ARGS:
    call("validate_discovery_args", [arg + "=2"])
for site in ["twitter", "pixiv", "danbooru", "exhentai", "pawchive"]:
    for raw in ["[]", "null", "{}", "42", "[1, [], null, {}, [3, \"ignored\", {}]]", "not json", "[\n] trailing", "[\n", '["字",]']:
        call("parse_discovery_output", site, raw, source_url="https://fixture.invalid/", limit=3)
    for raw in ["relative/path?x=1", "https://Example.org:443//a%20b///?q=%FF#frag", "//Twitter.com/User", "https://user:pass@EXAMPLE.org:123/path/?x=1", "https://example.org/字/", "https://[::1]/a", "http://example.org/?q=x"]:
        call("canonical_gallery_address", site, raw)
        call("classify_external_profile", raw)
    for limit in [0, 1, 4]:
        messages = [[2, {}], [6, "invalid", {}], [3, "before", {"id": 1, "tweet_id": 1}]]
        for i in [1, 2, 1, 3]:
            data = {"id": i, "tweet_id": i, "gid": i, "gallery_id": i, "gallery_token": "aaaaaaaaaa", "user": {"id": 20, "name": "Name", "account": "user"}, "author": {"name": "Artist_Name" if i == 1 else "artist_name"}, "count": 2, "tags_artist": ["artist_name"], "tags_character": ["character_name"], "tags": [{"name": "字"}, "art"]}
            if site == "pawchive":
                data.update(user="20", service="fanbox")
            messages.extend([[2, data], [3, "https://file.pawchive.pw/data/a.jpg", data], [3, "https://file.pawchive.pw/data/a.jpg", data]])
        messages.append([-1, {"message": "late failure https://user:password@fixture.invalid/?token=fixture-secret"}])
        parsed = call("parse_discovery_output", site, json.dumps(messages), source_url="https://exhentai.org/?q=fixture", limit=limit)
        if parsed:
            for key in ["artist_name", "other", "Name"]:
                call("discovery_addresses", site, dict(zip(["candidates", "authors"], parsed)), keyword=key, limit=limit)

for raw in ["https://x.com/search", "https://x.com/Name/media", "https://www.pixiv.net/member.php?id=0012", "https://creator.fanbox.cc/", "https://skeb.jp/@creator", "https://pixiv.net/fanbox/creator/1", "https://pixiv.net/users/77whatever"]:
    call("classify_external_profile", raw)
for site, raw in [("twitter", "http://www.x.com/SEARCH?q=keep"), ("pixiv", "https://pixiv.net//users/001//artworks/?x=1"), ("danbooru", "https://danbooru.donmai.us/posts/?tags=&tags=a+b&tags=c"), ("danbooru", "https://danbooru.donmai.us/posts/?tags=a;b&x=1"), ("pawchive", "https://pawchive.st/artists/?q=keep"), ("exhentai", "https://exhentai.org/g/4/ABCDEF1234?p=2")]:
    call("canonical_gallery_address", site, raw)
call("parse_discovery_output", "twitter", json.dumps([[2, {"tweet_id": 18446744073709551616, "author": {"id": 42, "name": "name"}}], [3, "thumb", {"tweet_id": 18446744073709551616}]]), source_url="", limit=5)
for ever in [False, True, None, 0]:
    call("parse_discovery_output", "pawchive", json.dumps([[6, "https://pawchive.st/fanbox/user/42", {"id": "42", "service": "fanbox", "ever_imported": ever}]]), source_url="", limit=5)
for keyword in ["name", "別名", "group", "名", "@NAME", "ＮＡＭＥ"]:
    call("danbooru_alias_terms", {"authors": [{"name": "name", "other_names": ["別名", "名", "Second Alias"], "group_name": "group"}, {"name": "name_fuzzy", "other_names": ["Wrong Alias"]}]}, keyword, cap=4)
for limit in [0, 1, -1]:
    call("discovery_addresses", "danbooru", {"candidates": [{"metadata": {"artists": ["name"], "characters": ["NAME"]}}]}, keyword="name", limit=limit)
call("exhentai_tag_facets", [{"metadata": {"tags": ["cos:Name", "char:Test", "l:english", "circle:group", "loc:Japan", "f:tag", "r:manga", "series:Title", "mixed:x", "other:y", "temp:z", "artist:", "custom:v"]}}, {"metadata": {"tags": "a:Name With Spaces"}}])
for raw in [json.dumps([[-1, {"message": "x" * 1100}]]), json.dumps([[-1, {"error": "bad"}] for _ in range(8)])]:
    call("parse_discovery_output", "pixiv", raw, source_url="", limit=5)

output = Path(__file__).with_name("oracle.json")
output.write_text(json.dumps(records, ensure_ascii=False, indent=2) + "\n")
print(f"Recorded {len(records)} pure transform calls to {output}")
