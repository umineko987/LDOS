from __future__ import annotations

import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path


def _javascript_tokens(source: str) -> list[tuple[str, str, bool]]:
    """Tokenize enough JavaScript to identify static module declarations."""
    tokens: list[tuple[str, str, bool]] = []
    position = 0
    line_has_code = False
    length = len(source)

    while position < length:
        character = source[position]
        if character.isspace():
            if character in "\r\n":
                line_has_code = False
            position += 1
            continue
        if source.startswith("//", position):
            newline = source.find("\n", position + 2)
            position = length if newline < 0 else newline
            continue
        if source.startswith("/*", position):
            end = source.find("*/", position + 2)
            if end < 0:
                raise AssertionError("JavaScript 块注释未闭合")
            if "\n" in source[position : end + 2]:
                line_has_code = False
            position = end + 2
            continue

        at_line_start = not line_has_code
        if character in {'"', "'"}:
            quote = character
            value: list[str] = []
            position += 1
            while position < length:
                character = source[position]
                if character == "\\":
                    if position + 1 >= length:
                        raise AssertionError("JavaScript 字符串转义未闭合")
                    value.append(source[position + 1])
                    position += 2
                    continue
                if character == quote:
                    position += 1
                    break
                if character in "\r\n":
                    raise AssertionError("JavaScript 字符串未闭合")
                value.append(character)
                position += 1
            else:
                raise AssertionError("JavaScript 字符串未闭合")
            tokens.append(("string", "".join(value), at_line_start))
            line_has_code = True
            continue

        if character == "`":
            position += 1
            while position < length:
                character = source[position]
                if character == "\\":
                    position += 2
                    continue
                if character == "`":
                    position += 1
                    break
                position += 1
            else:
                raise AssertionError("JavaScript 模板字符串未闭合")
            tokens.append(("template", "", at_line_start))
            line_has_code = True
            continue

        if character.isalpha() or character in "_$":
            end = position + 1
            while end < length and (
                source[end].isalnum() or source[end] in "_$"
            ):
                end += 1
            tokens.append(("identifier", source[position:end], at_line_start))
            position = end
            line_has_code = True
            continue

        tokens.append(("punctuation", character, at_line_start))
        position += 1
        line_has_code = True

    return tokens


def _static_module_specifiers(source: str) -> tuple[str, ...]:
    """Parse specifiers from static import and re-export declarations."""
    tokens = _javascript_tokens(source)
    specifiers: list[str] = []
    for index, (kind, value, at_line_start) in enumerate(tokens):
        if kind != "identifier" or not at_line_start or value not in {"import", "export"}:
            continue
        next_index = index + 1
        if next_index >= len(tokens):
            continue
        next_kind, next_value, _ = tokens[next_index]

        if value == "import" and next_kind == "string":
            specifiers.append(next_value)
            continue
        if value == "import" and next_kind == "punctuation" and next_value in {"(", "."}:
            continue
        if value == "export" and not (
            next_kind == "punctuation" and next_value in {"*", "{"}
        ):
            continue

        cursor = next_index
        while cursor < len(tokens):
            token_kind, token_value, _ = tokens[cursor]
            if token_kind == "punctuation" and token_value == ";":
                break
            if token_kind == "identifier" and token_value == "from":
                if cursor + 1 < len(tokens) and tokens[cursor + 1][0] == "string":
                    specifiers.append(tokens[cursor + 1][1])
                break
            cursor += 1
    return tuple(specifiers)


def _javascript_import_graph(javascript_root: Path) -> dict[Path, set[Path]]:
    root = javascript_root.resolve()
    modules = {path.resolve() for path in root.rglob("*.js")}
    graph: dict[Path, set[Path]] = {path: set() for path in sorted(modules)}
    for source_path in graph:
        source = source_path.read_text(encoding="utf-8")
        for specifier in _static_module_specifiers(source):
            if not specifier.startswith("."):
                continue
            target = (source_path.parent / specifier).resolve()
            if target.suffix == "":
                target = target.with_suffix(".js")
            try:
                target.relative_to(root)
            except ValueError as error:
                raise AssertionError(
                    f"相对静态 import/export 越出 WebUI JS 根目录：{source_path} -> {specifier}"
                ) from error
            if target not in modules:
                raise AssertionError(
                    f"相对静态 import/export 目标不存在：{source_path} -> {specifier}"
                )
            graph[source_path].add(target)
    return graph


def _strongly_connected_components(graph: dict[Path, set[Path]]) -> list[tuple[Path, ...]]:
    next_index = 0
    indices: dict[Path, int] = {}
    low_links: dict[Path, int] = {}
    stack: list[Path] = []
    on_stack: set[Path] = set()
    components: list[tuple[Path, ...]] = []

    def visit(node: Path) -> None:
        nonlocal next_index
        indices[node] = next_index
        low_links[node] = next_index
        next_index += 1
        stack.append(node)
        on_stack.add(node)

        for dependency in sorted(graph[node]):
            if dependency not in indices:
                visit(dependency)
                low_links[node] = min(low_links[node], low_links[dependency])
            elif dependency in on_stack:
                low_links[node] = min(low_links[node], indices[dependency])

        if low_links[node] != indices[node]:
            return
        component: list[Path] = []
        while True:
            member = stack.pop()
            on_stack.remove(member)
            component.append(member)
            if member == node:
                break
        components.append(tuple(sorted(component)))

    for node in sorted(graph):
        if node not in indices:
            visit(node)
    return components


def _dependency_closure(graph: dict[Path, set[Path]], entrypoint: Path) -> set[Path]:
    closure: set[Path] = set()
    pending = [entrypoint.resolve()]
    while pending:
        module = pending.pop()
        if module in closure:
            continue
        closure.add(module)
        pending.extend(graph[module] - closure)
    return closure


class WebUiModuleTests(unittest.TestCase):
    def test_static_module_parser_resolves_imports_and_reexports(self):
        source = """
            import defaultExport from "./alpha";
            import { beta } from "./beta.js";
            import "./side-effect";
            export { gamma } from "../shared/gamma";
            export * from "./delta.js";
            const lazy = import("./dynamic.js");
            const text = 'import "./not-code.js"';
        """
        self.assertEqual(
            _static_module_specifiers(source),
            (
                "./alpha",
                "./beta.js",
                "./side-effect",
                "../shared/gamma",
                "./delta.js",
            ),
        )

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "main.js").write_text(
                'import value from "./dependency";\nexport { value };\n',
                encoding="utf-8",
            )
            (root / "dependency.js").write_text(
                "export default 1;\n",
                encoding="utf-8",
            )
            graph = _javascript_import_graph(root)
            self.assertEqual(
                graph[(root / "main.js").resolve()],
                {(root / "dependency.js").resolve()},
            )

    def test_webui_static_import_graph_has_no_multi_module_components(self):
        backend_root = Path(__file__).resolve().parents[1]
        javascript_root = backend_root / "gdl_backend" / "webui" / "js"
        graph = _javascript_import_graph(javascript_root)
        components = [
            component
            for component in _strongly_connected_components(graph)
            if len(component) > 1
        ]
        rendered = [
            [str(path.relative_to(javascript_root.resolve())) for path in component]
            for component in components
        ]
        self.assertEqual(rendered, [], f"WebUI 静态 import graph 存在循环：{rendered}")

    def test_webui_package_data_selects_complete_production_inventory(self):
        backend_root = Path(__file__).resolve().parents[1]
        package_root = backend_root / "gdl_backend"
        webui_root = package_root / "webui"
        pyproject = tomllib.loads(
            (backend_root / "pyproject.toml").read_text(encoding="utf-8")
        )
        patterns = pyproject["tool"]["setuptools"]["package-data"][
            "gdl_backend"
        ]

        self.assertEqual(len(patterns), len(set(patterns)))
        self.assertLessEqual(
            {
                "webui/*.html",
                "webui/assets/*.svg",
                "webui/styles/*.css",
                "webui/styles/apps/*.css",
                "webui/js/*.js",
                "webui/js/core/*.js",
                "webui/js/components/*.js",
                "webui/js/apps/*.js",
            },
            set(patterns),
        )

        selected: set[str] = set()
        for pattern in patterns:
            pattern_path = Path(pattern)
            self.assertFalse(pattern_path.is_absolute(), pattern)
            self.assertNotIn("..", pattern_path.parts, pattern)
            self.assertEqual(pattern_path.parts[0], "webui", pattern)
            matches = {
                path.relative_to(package_root).as_posix()
                for path in package_root.glob(pattern)
                if path.is_file()
            }
            self.assertTrue(matches, pattern)
            selected.update(matches)

        source_inventory = {
            path.relative_to(package_root).as_posix()
            for path in webui_root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(selected, source_inventory)
        self.assertEqual(len(selected), 99)
        self.assertEqual(
            {Path(path).suffix for path in selected},
            {".html", ".css", ".js", ".svg"},
        )
        self.assertEqual(
            len(
                {
                    path
                    for path in selected
                    if path.startswith("webui/js/apps/")
                }
            ),
            10,
        )
        self.assertEqual(
            len(
                {
                    path
                    for path in selected
                    if path.startswith("webui/styles/apps/")
                }
            ),
            10,
        )
        self.assertIn("webui/assets/noise.svg", selected)
        self.assertIn("webui/js/core/wallpaper-storage.js", selected)
        self.assertNotIn("webui/js/core/wallpaper-image-import.js", selected)
        self.assertFalse(any("fixture" in path.lower() for path in selected))

    def test_webui_fixtures_are_test_only_and_absent_from_production_sources(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui_root = backend_root / "gdl_backend" / "webui"
        fixture_root = backend_root / "tests" / "fixtures" / "webui"

        self.assertTrue(fixture_root.is_dir())
        self.assertTrue((fixture_root / "README.md").is_file())
        self.assertEqual(
            fixture_root.resolve().relative_to((backend_root / "tests").resolve()).parts[:2],
            ("fixtures", "webui"),
        )

        forbidden_references = (
            "tests/fixtures/webui",
            "tests\\fixtures\\webui",
            "webui_glass_target.test.mjs",
        )
        for path in webui_root.rglob("*"):
            if not path.is_file() or path.suffix not in {".html", ".css", ".js"}:
                continue
            source = path.read_text(encoding="utf-8")
            for reference in forbidden_references:
                self.assertNotIn(reference, source, str(path.relative_to(webui_root)))

    def test_legacy_webui_visual_baseline_has_fixed_safe_provenance(self):
        backend_root = Path(__file__).resolve().parents[1]
        baseline_root = backend_root / "tests" / "fixtures" / "webui" / "baselines"
        metadata_path = baseline_root / "legacy-desktop-1440x900.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))

        self.assertEqual(
            set(metadata),
            {
                "schema_version",
                "baseline",
                "file",
                "captured_at",
                "viewport",
                "route",
                "source",
                "capture_method",
                "browser",
                "runtime_data",
                "sha256",
            },
        )
        self.assertEqual(metadata["schema_version"], 1)
        self.assertEqual(metadata["baseline"], "pre-glass-desktop")
        self.assertEqual(metadata["file"], "legacy-desktop-1440x900.png")
        self.assertEqual(
            metadata["viewport"],
            {"width": 1440, "height": 900, "device_scale_factor": 1},
        )
        self.assertEqual(metadata["route"], "#/crawl")
        self.assertIs(metadata["runtime_data"], False)

        image = (baseline_root / metadata["file"]).read_bytes()
        self.assertEqual(image[:8], b"\x89PNG\r\n\x1a\n")
        self.assertEqual(struct.unpack(">II", image[16:24]), (1440, 900))
        self.assertEqual(hashlib.sha256(image).hexdigest(), metadata["sha256"])

        provenance = json.dumps(metadata, ensure_ascii=False)
        self.assertNotIn(str(Path.home()), provenance)
        self.assertNotIn("runtime/downloads", provenance)

    def test_store_static_dependency_closure_excludes_apps_and_views(self):
        backend_root = Path(__file__).resolve().parents[1]
        javascript_root = backend_root / "gdl_backend" / "webui" / "js"
        graph = _javascript_import_graph(javascript_root)
        closure = _dependency_closure(graph, javascript_root / "core" / "store.js")
        relative_paths = sorted(
            str(path.relative_to(javascript_root.resolve())) for path in closure
        )
        forbidden = [
            path
            for path in relative_paths
            if path.startswith("apps/")
            or (path.startswith("components/") and path.endswith("-view.js"))
        ]
        self.assertEqual(
            forbidden,
            [],
            f"store.js 依赖闭包不得加载应用控制器或视图：{forbidden}",
        )

    def test_store_imports_without_application_controllers_or_views(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("未安装 Node.js；生产运行不依赖 Node.js")

        backend_root = Path(__file__).resolve().parents[1]
        source_javascript = backend_root / "gdl_backend" / "webui" / "js"
        with tempfile.TemporaryDirectory() as temporary:
            test_root = Path(temporary)
            javascript_root = test_root / "gdl_backend" / "webui" / "js"
            shutil.copytree(source_javascript, javascript_root)
            shutil.rmtree(javascript_root / "apps")
            for view in (javascript_root / "components").glob("*-view.js"):
                view.unlink()
            (test_root / "package.json").write_text(
                '{"type":"module","private":true}\n',
                encoding="utf-8",
            )
            script = """
                import {
                  createInitialState,
                  createStore,
                } from "./gdl_backend/webui/js/core/store.js";
                const initial = createInitialState();
                const store = createStore({ initialState: initial, reportError() {} });
                if (store.getState().ui.windows.length !== 0) process.exitCode = 2;
            """
            completed = subprocess.run(
                [node, "--input-type=module", "--eval", script],
                cwd=test_root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                check=False,
            )
        self.assertEqual(
            completed.returncode,
            0,
            "store.js 无控制器/视图时必须可独立加载：\n"
            f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}",
        )

    def test_business_modules_static_security_boundaries(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"

        app_endpoints = {
            "proxy.js": {
                "/api/v1/proxy/status",
                "/api/v1/proxy/start",
                "/api/v1/proxy/reload",
                "/api/v1/proxy/probe",
                "/api/v1/proxy/stop",
                "/api/v1/proxy/sources",
                "/api/v1/proxy/sources/subscriptions",
                "/api/v1/proxy/sources/node-file",
                "/api/v1/proxy/sources/inline-nodes",
                "/api/v1/proxy/sources/override",
            },
            "vault.js": {
                "/api/v1/auth",
                "/api/v1/auth/proxy",
                "/api/v1/auth/browser-profile",
                "/api/v1/auth/pixiv/oauth/start",
                "/api/v1/auth/pixiv/oauth/session",
            },
            "policy.js": {"/api/v1/sites/policies"},
            "personalization.js": set(),
            "crawl.js": {
                "/api/v1/search",
                "/api/v1/search/autocomplete",
                "/api/v1/crawls",
            },
            "tasks.js": {"/api/v1/crawls"},
            "review.js": {"/api/v1/crawls"},
            "diagnostics.js": {
                "/healthz",
                "/readyz",
                "/api/v1/config?view=diagnostics",
                "/api/v1/scheduler/status?view=diagnostics",
            },
        }
        app_sources = {
            path.name: path.read_text(encoding="utf-8")
            for path in (webui / "js" / "apps").glob("*.js")
        }
        for name, endpoints in app_endpoints.items():
            source = app_sources[name]
            for endpoint in endpoints:
                self.assertEqual(source.count(f'"{endpoint}"'), 1, (name, endpoint))
            for hook in ("mount", "activate", "deactivate", "unmount"):
                self.assertIn(f"{hook}(", source, name)

        self.assertNotIn("placeholder.js", app_sources)

        business_paths = [
            *(webui / "js" / "apps").glob("*.js"),
            *(webui / "js" / "components").glob("*.js"),
            *(webui / "js" / "core").glob("*-model.js"),
            webui / "js" / "core" / "review-loupe.js",
        ]
        combined = "\n".join(path.read_text(encoding="utf-8") for path in business_paths)
        for forbidden in (
            "fetch(",
            "globalThis.fetch",
            "XMLHttpRequest",
            "localStorage",
            "sessionStorage",
            "console.",
        ):
            self.assertNotIn(forbidden, combined)

        loupe = (webui / "js" / "core" / "review-loupe.js").read_text(
            encoding="utf-8"
        )
        for forbidden in ("document", "window", "localStorage", "sessionStorage", "fetch"):
            self.assertNotIn(forbidden, loupe)
        self.assertIn("Object.freeze", loupe)

        proxy = app_sources["proxy.js"]
        vault = app_sources["vault.js"]
        policy = app_sources["policy.js"]
        crawl = app_sources["crawl.js"]
        tasks = app_sources["tasks.js"]
        review = app_sources["review.js"]
        diagnostics = app_sources["diagnostics.js"]
        personalization = app_sources["personalization.js"]
        self.assertIn('STATUS_POLL_KEY = "proxy.status"', proxy)
        self.assertIn('AUTHORIZATION_POLL_KEY = "vault.authorization"', vault)
        self.assertIn("alwaysFocusRate: true", vault)
        self.assertNotIn("polling.start", policy)
        self.assertIn('BATCH_POLL_KEY = "batches.active"', tasks)
        self.assertIn("queueMicrotask", tasks)
        self.assertIn('REVIEW_POLL_KEY = "review.active"', review)
        self.assertIn("?all=true", review)
        self.assertIn("splitReviewDecisionPayload", review)
        self.assertIn("queueMicrotask", review)
        self.assertIn('DIAGNOSTICS_POLL_KEY = "diagnostics.snapshot"', diagnostics)
        self.assertIn("createDiagnosticsRequestGate", diagnostics)
        self.assertIn("Promise.all(", diagnostics)
        self.assertIn("advanceLifecycle", diagnostics)
        self.assertIn("cycleController?.abort()", diagnostics)
        self.assertNotIn("/api/", personalization)
        self.assertNotIn("polling.", personalization)
        self.assertIn("idempotencyKey: true", crawl)
        self.assertIn("beforeLeave()", review)
        self.assertNotIn("force: true", proxy)

        for name in ("crawl.js", "tasks.js", "review.js", "diagnostics.js"):
            source = app_sources[name]
            self.assertNotIn("/api/v1/auth", source, name)
            self.assertNotIn("/api/v1/proxy", source, name)
            self.assertNotIn("/api/v1/sites", source, name)

        store = "\n".join(
            (webui / "js" / "core" / name).read_text(encoding="utf-8")
            for name in (
                "store-contract.js",
                "store-state.js",
                "store-business-transition.js",
            )
        )
        for action in (
            'DIAGNOSTICS_RECEIVED: "diagnostics/received"',
            'CRAWL_SEARCH_RECEIVED: "crawl/searchReceived"',
            'BATCH_SNAPSHOT_RECEIVED: "batches/snapshotReceived"',
            'REVIEW_WORKSPACE_RECEIVED: "review/workspaceReceived"',
        ):
            self.assertIn(action, store)
        for sanitizer in (
            "validateDiagnosticsSnapshot",
            "validateCrawlSnapshot",
            "sanitizeBatchDetail",
            "validateReviewState",
        ):
            self.assertIn(sanitizer, store)

        review_model = (webui / "js" / "core" / "review-model.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("buildReviewDecisionPayload", review_model)
        self.assertIn("reviewImageUrl", review_model)
        self.assertNotIn("relative_path:", review_model)
        crawl_model = (webui / "js" / "core" / "crawl-model.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("projectCrawlSearchResponse", crawl_model)
        self.assertIn("buildCrawlPayload", crawl_model)
        self.assertIn("operations.set", crawl_model)
        crawl_view = (webui / "js" / "components" / "crawl-view.js").read_text(
            encoding="utf-8"
        )
        self.assertIn("createSourceErrorWarning", crawl_view)
        self.assertNotIn("innerHTML", crawl_view)

    def test_no_global_dom_selector_calls_in_window_modules(self):
        backend_root = Path(__file__).resolve().parents[1]
        javascript_root = backend_root / "gdl_backend" / "webui" / "js"
        selector_call = re.compile(
            r"\bdocument\s*\.\s*(?:querySelector|getElementById)\s*\("
        )
        paths = sorted((javascript_root / "apps").glob("*.js")) + sorted(
            (javascript_root / "components").glob("*.js")
        )

        for path in paths:
            with self.subTest(module=path.name):
                source = path.read_text(encoding="utf-8")
                self.assertIsNone(
                    selector_call.search(source),
                    f"{path.relative_to(backend_root)} 必须只在窗口根元素内查询 DOM",
                )

    def test_review_focus_deck_static_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        review_app = (webui / "js" / "apps" / "review.js").read_text(
            encoding="utf-8"
        )
        review_view = (
            webui / "js" / "components" / "review-view.js"
        ).read_text(encoding="utf-8")
        review_model = (
            webui / "js" / "core" / "review-model.js"
        ).read_text(encoding="utf-8")
        review_loupe = (
            webui / "js" / "core" / "review-loupe.js"
        ).read_text(encoding="utf-8")
        review_css = (
            webui / "styles" / "apps" / "review.css"
        ).read_text(encoding="utf-8")

        # 全量选择器已经完全替代胶片条、服务端页按钮和跨页命令。
        for retired in (
            "filmstrip",
            "review-deck-film",
            "review-deck-page",
            "prev-page",
            "next-page",
            "上一页",
            "下一页",
        ):
            self.assertNotIn(retired, review_view + review_css)
        self.assertIn('dataset: { reviewGroupSelect: "" }', review_view)
        self.assertIn('"aria-label": "当前筛选全量组选择器"', review_view)
        self.assertIn("review.groups.map((group, index)", review_view)

        # review 元数据只通过 all=true 读取；底部只保留两枚组导航按钮与三行纯文本提示。
        self.assertIn('return `${reviewPath(batchId)}?all=true${kind}`;', review_app)
        self.assertEqual(review_app.count("api.get(reviewWorkspacePath("), 2)
        self.assertNotIn("api.get(reviewPath(", review_app)
        command_start = review_view.index("const commandHost =")
        command_end = review_view.index("const deckLiveHost =", command_start)
        command_source = review_view[command_start:command_end]
        self.assertEqual(command_source.count("button("), 2)
        self.assertEqual(command_source.count('button("prev-group"'), 1)
        self.assertEqual(command_source.count('button("next-group"'), 1)
        self.assertEqual(review_view.count('button("prev-group"'), 1)
        self.assertEqual(review_view.count('button("next-group"'), 1)
        self.assertEqual(command_source.count('createElement("span"'), 3)
        self.assertIn('className: "review-shortcut-hints"', command_source)
        for hint in (
            "方向键  移动选中",
            "Space  切换保留",
            "Enter  采纳并前进",
        ):
            self.assertEqual(command_source.count(f'text: "{hint}"'), 1, hint)
        self.assertNotIn("<kbd", command_source)
        self.assertNotIn('className: "review-deck-command"', command_source)
        self.assertNotIn("放大镜", command_source)
        self.assertNotIn('keyShortcuts: "x"', command_source)
        self.assertIn('title: "快捷键 Backspace：返回上一组"', command_source)
        self.assertIn('keyShortcuts: "Backspace"', command_source)
        self.assertIn('"aria-keyshortcuts": keyShortcuts || null', review_view)

        # 四方向键在线性图片序列内 clamp；Enter 在只读模式浏览下一组，Backspace 返回上一组。
        for fingerprint in (
            'key === "Backspace"',
            'return "previous-group"',
            '(key === "ArrowLeft" || key === "ArrowUp")',
            '(key === "ArrowRight" || key === "ArrowDown")',
            'key === " " && editable',
            'key === "Enter" && editable',
            'key === "Enter" && readOnly',
            '(key === "x" || key === "X") && loupeAvailable',
            'return "focus-previous-image"',
            'return "focus-next-image"',
            'return "toggle-active-image"',
            'return "accept-advance"',
            'return "browse-next-group"',
            'return "toggle-loupe"',
            "deckImageStepTarget",
            "Math.max(0, Math.min(activeIndex + direction, imageCount - 1))",
        ):
            self.assertIn(fingerprint, review_model)
        for fingerprint in (
            'action === "prev-group"',
            'action === "next-group"',
            'command === "previous-group"',
            'command === "focus-previous-image"',
            'command === "focus-next-image"',
            'command === "toggle-active-image"',
            'command === "accept-advance"',
            'command === "browse-next-group"',
            'command === "toggle-loupe"',
            "view.setActiveImage(nextImage.id, { focus: true })",
            "toggleImage(group.id, imageId, { focus: true })",
            "view.isLoupeAvailable()",
            "view.toggleLoupe()",
            'readOnly: review.summary.status !== "ready"',
            'command === "browse-next-group") return navigateGroup(1)',
            'event.target.closest("input, select, textarea, button, a[href], [contenteditable]")',
            "event.isComposing",
            "event.altKey",
            "event.ctrlKey",
            "event.metaKey",
            "放大镜已启动；在图片内移动鼠标即可同步检查。",
            "放大镜已关闭；倍率会保留到下次启动。",
        ):
            self.assertIn(fingerprint, review_app)
        self.assertIn(
            'loupeToggleButton.setAttribute("aria-keyshortcuts", "x")',
            review_view,
        )
        self.assertIn('title: "快捷键 X：开启或关闭同步放大镜"', review_view)
        self.assertIn('dataset: { reviewEnterHint: "" }', review_view)
        self.assertIn('? "Enter  下一组"', review_view)
        self.assertIn(': "Enter  采纳并前进"', review_view)
        self.assertNotIn("镜片 · 同步 · 锐利", review_view + review_css)
        self.assertNotIn("review-loupe-label", review_view + review_css)

        # 活动图片必须有独立于保留/移除状态的显眼标记和无障碍当前项状态。
        for fingerprint in (
            'className: "review-image-active-marker"',
            'text: "当前选中"',
            '"aria-current": String(image.id === activeImageId)',
            'card.setAttribute("aria-current", String(active))',
        ):
            self.assertIn(fingerprint, review_view)
        self.assertRegex(
            review_css,
            r'\.review-image-card\[data-active="true"\]\s*\{'
            r'[^}]*border-color:\s*var\(--imageweave-accent\);'
            r'[^}]*opacity:\s*1;[^}]*outline:\s*'
            r'var\(--imageweave-focus-width\) solid '
            r'var\(--imageweave-focus-ring\)',
        )
        self.assertRegex(
            review_css,
            r'\.review-image-card\[data-active="true"\]\s+\.review-image-active-marker\s*\{\s*display:\s*block;',
        )
        self.assertIn(".review-image-active-marker,", review_css)

        for retired in (
            "deckJumpTarget",
            "jumpGroups",
            "jump-backward",
            "jump-forward",
            "first-group",
            "last-group",
            'key === "PageUp"',
            'key === "PageDown"',
            'key === "Home"',
            'key === "End"',
        ):
            self.assertNotIn(retired, review_app + review_model + review_view)

        # 正式 view 必须实际消费全部镜片/布局纯函数，而不是只导入未接线。
        for symbol in (
            "calculateReviewLayout",
            "getContainContentRect",
            "normalizePointerCoordinates",
            "calculateSynchronizedCrop",
            "updateMagnification",
        ):
            self.assertGreaterEqual(review_view.count(symbol), 2, symbol)

        # 默认关闭、RAF/observer、DPR 与锐利 Canvas 降级契约继续保留。
        for fingerprint in (
            "enabled: false",
            'setAttribute("aria-pressed"',
            'setAttribute("aria-disabled"',
            "new globalThis.ResizeObserver",
            "requestFrame(applyLayout)",
            "MAX_CANVAS_DPR = 2",
            "Math.min(MAX_CANVAS_DPR, globalThis.devicePixelRatio || 1)",
            "context2d.imageSmoothingEnabled = false",
            'CANVAS_ERROR_TEXT = "读取受限"',
            'renderMode: "nearest"',
            "canvas.dataset.sourceLeft",
            "canvas.dataset.sourceTop",
            "canvas.dataset.sourceWidth",
            "canvas.dataset.sourceHeight",
            "canvas.dataset.edgeClamped",
        ):
            self.assertIn(fingerprint, review_view)

        # 图片窗口只能由当前组和一个相邻组组成，所有生命周期都释放媒体与异步资源。
        self.assertEqual(review_view.count("const neighborIndex ="), 1)
        self.assertIn("focusedIndex + 1 < review.groups.length", review_view)
        self.assertIn("focusedIndex - 1", review_view)
        self.assertIn("adjacentPreviews.push(preview)", review_view)
        for fingerprint in (
            'image.removeAttribute("src")',
            "releaseStageImages();",
            "releasePreloads();",
            "disconnectLayoutObserver();",
            "cancelHide();",
            "cancelDraw();",
            'root.removeEventListener("pointermove"',
            "unsubscribeRecent();",
            "unsubscribeReview();",
        ):
            self.assertIn(fingerprint, review_view)
        self.assertIn("view.deactivate();", review_app)
        self.assertIn("view.destroy();", review_app)

        # 桌面鼠标镜片、checkbox 语义与舞台级键盘操作保留，移动/触控专用逻辑必须不存在。
        for fingerprint in (
            'event.pointerType && event.pointerType !== "mouse"',
            'event.target.closest("[data-review-image]")',
            "getActiveImageId: () => activeImageId",
            "isLoupeAvailable: () => loupeAvailable",
            'role: "checkbox"',
            'tabindex: "0"',
        ):
            self.assertIn(fingerprint, review_app + review_view)
        for retired in (
            "TOUCH_DRAG_THRESHOLD",
            "touchGesture",
            "suppressedClickImageId",
            "consumeSuppressedCardClick",
            "card.click();",
            'addEventListener("pointerdown"',
            'addEventListener("pointerup"',
            'addEventListener("pointercancel"',
            'event.key.toLowerCase() === "p"',
            'event.key === "Escape"',
        ):
            self.assertNotIn(retired, review_app + review_view)

        # 指标侧栏、图片参数条和批量模式均已删除，舞台独占主体列。
        for retired in (
            "review-deck-inspector",
            "review-metrics",
            "review-metric",
            "review-image-fact",
            "toggle-inspector",
            "filter-all",
            "filter-none",
            "filter-recommended",
            "group-all",
            "group-none",
            "group-recommended",
            "属性 / 指标",
            "matchLevels",
            "jpegQuality",
        ):
            self.assertNotIn(retired, review_app + review_view + review_model + review_css)
        self.assertRegex(
            review_css,
            r"\.review-deck-body\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)",
        )

        # 不可读图不创建镜片；加载失败会销毁无效 Canvas 并重算按钮可用性。
        self.assertIn("if (image.readable) {", review_view)
        self.assertIn("failedCanvas?.remove();", review_view)
        self.assertIn("loupeAvailable = group.images.some", review_view)
        self.assertIn("if (!group.images.length)", review_view)

        # REVIEW 不再包含移动端/小视口 CSS，仅保留纯可访问性媒体查询。
        for retired in (
            "@media (max-width",
            "@media (max-height",
            "@media (pointer: coarse)",
            "touch-action",
        ):
            self.assertNotIn(retired, review_css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", review_css)
        self.assertIn("@media (forced-colors: active)", review_css)

        # review 运行时代码不得旁路 API、写存储、创建私有 URL 或使用全局 document selector。
        combined = "\n".join((review_app, review_view, review_model, review_loupe))
        for forbidden in (
            "innerHTML",
            "fetch(",
            "globalThis.fetch",
            "XMLHttpRequest",
            "localStorage",
            "sessionStorage",
            "new Blob",
            "URL.createObjectURL",
            "data:image",
            "error.message",
            ".details",
        ):
            self.assertNotIn(forbidden, combined)
        self.assertIsNone(
            re.search(r"\bdocument\s*\.\s*(?:querySelector|getElementById)\s*\(", combined)
        )
        self.assertNotRegex(review_model, r"\b(?:relative_path|analysis_log_path)\s*:")
        self.assertNotRegex(review_view, r"\b(?:relative_path|analysis_log_path|raw_url)\b")

    def test_review_t76_visual_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        css = (webui / "styles" / "apps" / "review.css").read_text(
            encoding="utf-8"
        )
        controls = (webui / "styles" / "controls.css").read_text(
            encoding="utf-8"
        )
        view = (
            webui / "js" / "components" / "review-view.js"
        ).read_text(encoding="utf-8")
        controller = (
            webui / "js" / "apps" / "review.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            marker = f"{selector} {{"
            start = css.find(marker)
            self.assertNotEqual(start, -1, selector)
            opening = css.find("{", start)
            closing = css.find("}", opening)
            self.assertNotEqual(closing, -1, selector)
            return css[opening + 1 : closing]

        # The panel/deck structure, ordinary-window scroll ownership and
        # maximized full-window geometry are presentation-only and unchanged.
        self.assertIn(".window-body:has(> .review-app)", css)
        app = css_block(".review-app")
        for expected in (
            "width: 100%",
            "height: 100%",
            "max-width: none",
            "background: transparent",
        ):
            self.assertIn(expected, app)
        panel_mode = css_block('.review-app[data-mode="panel"]')
        self.assertIn("overflow-y: auto", panel_mode)
        deck_mode = css_block('.review-app[data-mode="deck"]')
        self.assertIn(
            "grid-template-rows: auto minmax(0, 1fr) auto", deck_mode
        )
        self.assertIn("overflow: hidden", deck_mode)
        self.assertIn("display: contents", css_block(
            '.review-app[data-mode="deck"] > .review-deck'
        ))
        self.assertIn("overflow: auto", css_block(".review-deck-cards"))
        self.assertIn("overflow: hidden", css_block(".review-deck-stage"))

        # Panel, deck header, stage and statusbar are complete 15%/24px
        # top-level surfaces in the canonical 5%-8% neutral range. They use
        # directional inset edges but no nested backdrop or large outer shadow.
        panel = css_block(".review-panel")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-input)",
            "inset 0 1px 0",
            "inset 0 -1px 0",
        ):
            self.assertIn(expected, panel)
        for selector, surface in (
            (".review-deck-header", "secondary"),
            (".review-deck-stage", "input"),
            (".review-deck-statusbar", "secondary"),
        ):
            block = css_block(selector)
            for expected in (
                "border: var(--imageweave-border-width) solid "
                "var(--imageweave-border-default)",
                "border-radius: var(--imageweave-radius-card)",
                f"background: var(--imageweave-glass-surface-{surface})",
                "inset 0 1px 0",
                "inset 0 -1px 0",
            ):
                self.assertIn(expected, block, selector)
            self.assertNotIn("backdrop-filter", block)
            self.assertNotIn("var(--imageweave-shadow-", block)
            if selector == ".review-deck-header":
                self.assertIn("max-height: 230px", block)

        # A controlled error gets a centered neutral shield, complete edge and
        # readable shared ErrorView instead of colliding with live deck rows.
        error_overlay = css_block(
            '.review-app[data-mode="deck"] > '
            ".review-error-host:not(:empty)"
        )
        for expected in (
            "inset: 16px",
            "display: grid",
            "place-items: center",
            "var(--imageweave-border-default)",
            "background: rgb(6 10 19 / 0.68)",
            "box-shadow: none",
        ):
            self.assertIn(expected, error_overlay)
        self.assertNotIn("backdrop-filter", error_overlay)
        self.assertNotIn("var(--imageweave-shadow-", error_overlay)

        # Toolbar/fact/status/image rows are 4%-6%, 16px and flat. Dirty,
        # selected and active all combine readable text/symbols with full edges.
        operation = css_block(".review-operation-live")
        for expected in (
            "var(--imageweave-border-weak)",
            "border-radius: var(--imageweave-radius-control)",
            "color: var(--imageweave-text-secondary)",
            "background: var(--imageweave-glass-surface-weak)",
            "box-shadow: none",
        ):
            self.assertIn(expected, operation)
        self.assertIn('content: "◆ 状态 · "', css)
        self.assertIn('content: "△ 未保存 · "', css)
        self.assertRegex(
            css,
            r'\.review-operation-live\[data-review-dirty="true"\]'
            r"\s*\{[^}]*border:\s*var\(--imageweave-border-strong-width\)"
            r" solid var\(--imageweave-state-warning\)",
        )
        self.assertIn('content: "◆ "', css_block(".review-tab--active::before"))
        for marker in (
            'className: "review-image-active-marker"',
            'text: "当前选中"',
            'text: image.selected ? "✓ 保留" : "✗ 移除"',
            '"aria-checked": String(image.selected)',
            '"aria-current": String(image.id === activeImageId)',
            'reviewDirty: "false"',
            'attributes: { "aria-live": "polite", role: "status" }',
        ):
            self.assertIn(marker, view)

        card = css_block(".review-image-card")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-control)",
            "background: var(--imageweave-glass-surface-secondary)",
            "box-shadow: none",
            "opacity: 1",
            "transform: none",
        ):
            self.assertIn(expected, card)
        hover = css_block('.review-image-card[aria-disabled="false"]:hover')
        self.assertIn("box-shadow: none", hover)
        self.assertIn("transform: none", hover)
        self.assertIn(
            "opacity: 1", css_block(
                '.review-image-card[data-selected="false"]'
            )
        )
        self.assertRegex(
            css,
            r'\.review-image-card\[data-selected="true"\]'
            r"\s*\{[^}]*border-color:\s*"
            r"var\(--imageweave-border-focus\)",
        )
        self.assertRegex(
            css,
            r'\.review-image-card\[data-active="true"\]'
            r"\s*\{[^}]*border-color:\s*var\(--imageweave-accent\)"
            r"[^}]*outline:[^;]*var\(--imageweave-focus-ring\)",
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-input)",
            css_block('.review-image-stamp[data-state="keep"]'),
        )

        # Image and Canvas pixels stay literal: contain sizing, no dimming,
        # filter, blend or delayed animation. The lens keeps nearest-neighbor
        # sampling and a complete 15%/16px edge.
        image = css_block(".review-image-media > img")
        for expected in (
            "min-width: 0",
            "min-height: 0",
            "object-fit: contain",
            "background: transparent",
            "opacity: 1",
            "filter: none",
            "mix-blend-mode: normal",
            "transition: none",
        ):
            self.assertIn(expected, image)
        lens = css_block(".review-loupe-lens")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-control)",
            "background: var(--imageweave-glass-surface-secondary)",
            "image-rendering: pixelated",
            "opacity: 1",
            "filter: none",
            "mix-blend-mode: normal",
            "transition: none",
            "animation: none",
        ):
            self.assertIn(expected, lens)
        crosshair = css_block(".review-loupe-crosshair")
        self.assertIn("transition: none", crosshair)
        self.assertIn("animation: none", crosshair)

        # The sole *-solid reference is the canonical no-backdrop fallback.
        # No state fill, old quick duration, one-sided bar or positive internal
        # backdrop/filter survives in normal Review presentation.
        self.assertEqual(
            re.findall(r"--imageweave-[\w-]*-solid", css),
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(css, r"--imageweave-state-[\w-]*-surface")
        self.assertNotRegex(css, r"\b(?:100|120|140|150|160|180)ms\b")
        self.assertNotRegex(
            css,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        for declaration in re.findall(
            r"(?m)^\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;\n]+)",
            css,
        ):
            self.assertEqual(declaration.strip(), "none")
        for declaration in re.findall(
            r"(?m)^\s*filter\s*:\s*([^;\n]+)", css
        ):
            self.assertEqual(declaration.strip(), "none")

        # Primary styling remains the T6 neutral shared control. Capability,
        # contrast, motion and forced-color fallbacks are all canonical.
        self.assertRegex(
            controls,
            r"\.review-button\.review-button--primary"
            r"[\s\S]*?border-color:\s*var\(--imageweave-accent\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\)",
        )
        self.assertNotRegex(
            css, r"\.review-button--primary\s*\{[^}]*background"
        )
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            css,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)", css
        )
        self.assertIn("@media (prefers-contrast: more)", css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", css)
        self.assertIn('@media (forced-colors: active)', css)
        self.assertIn('data-motion="off"', css)
        for marker in (
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
            "transition: none !important",
        ):
            self.assertIn(marker, css)

        # T7.6 is CSS-only: all=true, exact partial payload, shortcut scope,
        # RAF Canvas, media release and window lifecycle seams remain present.
        self.assertEqual(controller.count("?all=true"), 1)
        for marker in (
            "buildReviewDecisionPayload(review)",
            "splitReviewDecisionPayload(payload)",
            "for (const chunk of captured)",
            "await api.put(reviewPath(batchId, \"/decisions\"), chunk",
            "event.target.closest(\"input, select, textarea, button, "
            "a[href], [contenteditable]\")",
            "operationController?.abort()",
            "view.deactivate();",
            "view.destroy();",
        ):
            self.assertIn(marker, controller)
        for marker in (
            "context2d.imageSmoothingEnabled = false",
            "context2d.drawImage(",
            "requestFrame(() => drawLoupeNow())",
            'image.removeAttribute("src")',
            "canvas.width = 1",
            "resizeObserver?.disconnect()",
            'root.removeEventListener("pointermove"',
            "stageGeneration += 1",
        ):
            self.assertIn(marker, view)

    def test_gallery_t81_visual_and_fixture_boundary_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        fixtures = backend_root / "tests" / "fixtures" / "webui"
        css = (webui / "styles" / "apps" / "gallery.css").read_text(
            encoding="utf-8"
        )
        controller = (
            webui / "js" / "apps" / "gallery.js"
        ).read_text(encoding="utf-8")
        view = (
            webui / "js" / "components" / "gallery-view.js"
        ).read_text(encoding="utf-8")
        model = (
            webui / "js" / "core" / "gallery-model.js"
        ).read_text(encoding="utf-8")
        fixture_host = (
            fixtures / "stage5-preview-host.js"
        ).read_text(encoding="utf-8")
        fixture_html = (
            fixtures / "stage5-preview-host.html"
        ).read_text(encoding="utf-8")
        fixture_states = (
            fixtures / "stage5-preview-fixtures.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            start = css.find(selector)
            self.assertNotEqual(start, -1, selector)
            opening = css.find("{", start + len(selector))
            closing = css.find("}", opening)
            self.assertNotEqual(opening, -1, selector)
            self.assertNotEqual(closing, -1, selector)
            return css[opening + 1 : closing]

        # Collection/content/facts preserve their desktop-only three-column
        # ownership. Normal 800x560 windows scroll the fixed track; maximized
        # windows fit the adaptive track and each region owns vertical scroll.
        workspace = css_block(".gallery-workspace")
        for expected in (
            "padding: 24px",
            "overflow-x: auto",
            "overflow-y: hidden",
            "background: transparent",
        ):
            self.assertIn(expected, workspace)
        track = css_block(".gallery-workspace-track")
        self.assertGreaterEqual(track.count("minmax("), 3)
        self.assertIn("gap: 24px", track)
        self.assertIn("min-width: 1100px", track)
        column_scroll = css_block(".gallery-column-scroll,")
        self.assertIn("padding: 24px", column_scroll)
        self.assertIn("overflow-y: auto", column_scroll)
        self.assertRegex(
            css,
            r"\.application-window\[data-maximized\] "
            r"\.gallery-workspace-track\s*\{[^}]*min-width:\s*100%",
        )
        self.assertRegex(
            css,
            r"\.application-window:not\(\[data-maximized\]\) "
            r"\.gallery-workspace-track\s*\{[^}]*"
            r"grid-template-columns:\s*230px 560px 330px",
        )

        # Columns are neutral 5%-6% top-level regions with complete 15%/24px
        # edges and inset directionality. Facts/toolbars/cards are flattened to
        # 4%-6%/16px rows with no outer shadow or independent backdrop.
        column = css_block(".gallery-column")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-input)",
            "inset 0 1px 0",
            "inset 0 -1px 0",
        ):
            self.assertIn(expected, column)
        self.assertNotIn("backdrop-filter", column)
        self.assertNotIn("var(--imageweave-shadow-", column)
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            css_block(".gallery-column--navigation"),
        )
        flattened = css_block(".gallery-panel,")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-weak)",
            "border-radius: var(--imageweave-radius-control)",
            "background: var(--imageweave-glass-surface-weak)",
            "box-shadow: none",
        ):
            self.assertIn(expected, flattened)
        self.assertNotIn("backdrop-filter", flattened)
        facts = css_block(".gallery-facts > div")
        for expected in (
            "var(--imageweave-border-weak)",
            "border-radius: var(--imageweave-radius-control)",
            "background: var(--imageweave-glass-surface-weak)",
            "box-shadow: none",
        ):
            self.assertIn(expected, facts)
        self.assertIn(
            "font-family: var(--imageweave-font-mono)",
            css_block(".gallery-facts dd"),
        )

        # Controls stay in the canonical 4%-15% range. Selected media retains
        # aria-selected/readable copy plus a complete 35% edge and champagne
        # text marker; item/card hover never moves or scales.
        controls = css_block(".gallery-nav-button,")
        for expected in (
            "min-height: var(--imageweave-control-height)",
            "var(--imageweave-border-button)",
            "border-radius: var(--imageweave-radius-control)",
            "background: var(--imageweave-glass-surface-button)",
            "var(--imageweave-transition-standard)",
        ):
            self.assertIn(expected, controls)
        inputs = css_block(".gallery-search,")
        self.assertIn(
            "background: var(--imageweave-glass-surface-input)", inputs
        )
        self.assertIn("var(--imageweave-border-default)", inputs)
        hover = css_block(".gallery-media-card:hover,")
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)", hover
        )
        self.assertIn("transform: none", hover)
        selected = css_block('.gallery-media-card[data-selected="true"]')
        self.assertIn("border-color: var(--imageweave-border-focus)", selected)
        self.assertIn(
            "background: var(--imageweave-glass-surface-input)", selected
        )
        selected_marker = css_block(
            '.gallery-media-card[data-selected="true"]::after'
        )
        self.assertIn('content: "◆ 已选择"', selected_marker)
        self.assertIn("var(--imageweave-accent)", selected_marker)
        for marker in (
            'role: "option"',
            '"aria-selected": String(selected)',
            'selected ? "已选择" : "未选择"',
            'className: "gallery-selection-fact"',
        ):
            self.assertIn(marker, view)

        # The image stage is neutral 5%, 15% edged and 16px rounded. Synthetic
        # fixture images are literal contain pixels with no filter, dimming,
        # blend, transition or delayed media manipulation.
        stage = css_block(".gallery-media-preview")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-control)",
            "background: var(--imageweave-glass-surface-secondary)",
        ):
            self.assertIn(expected, stage)
        image = css_block(".gallery-media-preview > img,")
        for expected in (
            "object-fit: contain",
            "background: transparent",
            "opacity: 1",
            "filter: none",
            "mix-blend-mode: normal",
            "transition: none",
            "animation: none",
        ):
            self.assertIn(expected, image)
        self.assertIn('data-gallery-media-state="loading"', css)
        self.assertIn('data-gallery-media-state="error"', css)
        quick_media_stage = css_block(".gallery-media-preview--large")
        self.assertIn("height: min(48vh, 480px)", quick_media_stage)
        self.assertIn("aspect-ratio: auto", quick_media_stage)

        # loading/empty/content/error/unavailable keep the T6 neutral status
        # plane; semantic colors appear only in complete edges, icon and text.
        self.assertRegex(
            css,
            r'\[data-gallery-workspace-state="loading"\]\s*\{[^}]*'
            r"border-color:\s*var\(--imageweave-state-running\)"
            r"[^}]*background:\s*"
            r"var\(--imageweave-glass-surface-secondary\)",
        )
        self.assertRegex(
            css,
            r'\[data-gallery-workspace-state="error"\]\s*\{[^}]*'
            r"border:\s*var\(--imageweave-border-strong-width\) solid "
            r"var\(--imageweave-state-danger\)[^}]*background:\s*"
            r"var\(--imageweave-glass-surface-default\)",
        )
        for phase in ("loading", "empty", "content", "error"):
            self.assertRegex(
                fixture_states,
                rf"\b{phase}:\s*freeze\(",
            )
        self.assertIn(
            "图片库后端能力尚未接入；当前不会读取下载目录或发送业务请求。",
            model,
        )

        # Quick Look alone receives one independent 60px/180% top-level glass
        # layer with 24px radius and the directional window shadow. Its internal
        # rows remain weak, flat and backdrop-free.
        quick_look = css_block(".gallery-quick-look__dialog")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-window)",
            "background-color: var(--imageweave-glass-surface-default)",
            "rgb(255 255 255 / 0.12)",
            "box-shadow: var(--imageweave-shadow-window)",
        ):
            self.assertIn(expected, quick_look)
        positive_backdrops = [
            value.strip()
            for value in re.findall(
                r"(?m)^\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;\n]+)",
                css,
            )
            if value.strip() != "none"
        ]
        self.assertEqual(len(positive_backdrops), 2)
        for value in positive_backdrops:
            self.assertEqual(
                value,
                "blur(var(--imageweave-glass-blur-window)) "
                "saturate(var(--imageweave-glass-saturation))",
            )
        quick_rows = css_block(".gallery-quick-look__dialog > header,")
        self.assertIn(
            "background: var(--imageweave-glass-surface-weak)", quick_rows
        )
        self.assertIn("box-shadow: none", quick_rows)
        self.assertNotIn("backdrop-filter", quick_rows)
        for marker in (
            'role: "dialog"',
            '"aria-modal": "true"',
            '"aria-labelledby": "gallery-quick-look-title"',
            '"aria-describedby": "gallery-quick-look-description"',
            'attributes: { id: "gallery-quick-look-description" }',
            "quickLookReturnFocus",
            'event.key !== "Tab"',
            'event.key === "Escape"',
            "preview.replaceChildren()",
        ):
            self.assertIn(marker, controller + view)

        # T8.1 removes all ten Gallery legacy surfaces and its tracked kicker;
        # only the canonical no-backdrop fallback retains a *-solid name.
        self.assertEqual(
            re.findall(r"--imageweave-[\w-]*-solid", css),
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(css, r"--imageweave-state-[\w-]*-surface")
        self.assertNotRegex(css, r"text-transform:\s*uppercase")
        self.assertNotRegex(css, r"letter-spacing:\s*0\.0[6-9]em")
        self.assertNotRegex(
            css,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        self.assertIn("@media (prefers-contrast: more)", css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", css)
        self.assertIn(':root[data-motion="off"]', css)
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            css,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)", css
        )
        for marker in (
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
            "transition: none !important",
        ):
            self.assertIn(marker, css)

        # The production controller/view/model remain formally unavailable,
        # zero-API and runtime-image-free. Blob/Image/listener media exists only
        # under the separately mounted tests fixture and has explicit balance
        # and stale-event facts for browser acceptance.
        production = "\n".join((controller, view, model))
        self.assertIn("createGalleryUnavailableAdapter()", controller)
        self.assertIn('projectGalleryState({ phase: "unavailable" })', controller)
        for forbidden in (
            "context.api",
            "/api/",
            "stage5-preview-fixtures",
            "testsOnly",
            "new Image()",
            "URL.createObjectURL",
            "URL.revokeObjectURL",
            "new Blob",
        ):
            self.assertNotIn(forbidden, production)
        for marker in (
            "createGalleryMediaFixture",
            "new Image()",
            "URL.createObjectURL(blob)",
            "URL.revokeObjectURL(record.objectUrl)",
            'addEventListener("load"',
            'addEventListener("error"',
            'removeEventListener("load"',
            'removeEventListener("error"',
            "MutationObserver",
            "adapterState || initialState",
            "balancedImages",
            "balancedObjectUrls",
            "balancedListeners",
            "ignoredLateEvents",
            "galleryMedia?.destroy()",
        ):
            self.assertIn(marker, fixture_host)
        self.assertIn('data-stage5-tests-only="true"', fixture_html)
        self.assertIn(
            'class="application-window stage5-fixture-window"', fixture_html
        )
        self.assertIn('data-theme-tone="dark"', fixture_html)

    def test_export_t83_visual_progress_and_fixture_boundary_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        fixtures = backend_root / "tests" / "fixtures" / "webui"
        css = (webui / "styles" / "apps" / "export.css").read_text(
            encoding="utf-8"
        )
        controls = (webui / "styles" / "controls.css").read_text(
            encoding="utf-8"
        )
        controller = (
            webui / "js" / "apps" / "export.js"
        ).read_text(encoding="utf-8")
        view = (
            webui / "js" / "components" / "export-view.js"
        ).read_text(encoding="utf-8")
        model = (
            webui / "js" / "core" / "export-model.js"
        ).read_text(encoding="utf-8")
        fixture_host = (
            fixtures / "stage5-preview-host.js"
        ).read_text(encoding="utf-8")
        fixture_html = (
            fixtures / "stage5-preview-host.html"
        ).read_text(encoding="utf-8")
        fixture_states = (
            fixtures / "stage5-preview-fixtures.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            start = css.find(selector)
            self.assertNotEqual(start, -1, selector)
            opening = css.find("{", start + len(selector))
            closing = css.find("}", opening)
            self.assertNotEqual(opening, -1, selector)
            self.assertNotEqual(closing, -1, selector)
            return css[opening + 1 : closing]

        def css_exact_block(selector: str) -> str:
            matches = re.findall(
                rf"(?m)^{re.escape(selector)}\s*\{{([^}}]*)\}}", css
            )
            self.assertTrue(matches, selector)
            return matches[-1]

        # Source/configuration/progress remains the real desktop-only layout.
        # A normal 800x560 window owns horizontal scrolling, a maximized window
        # fits all three regions, and every column keeps vertical ownership.
        workspace = css_block(".export-workspace")
        for expected in (
            "padding: 24px",
            "overflow-x: auto",
            "overflow-y: hidden",
            "background: transparent",
        ):
            self.assertIn(expected, workspace)
        track = css_block(".export-workspace-track")
        self.assertGreaterEqual(track.count("minmax("), 3)
        self.assertIn("gap: 24px", track)
        self.assertIn("min-width: 1100px", track)
        column_scroll = css_block(".export-column-scroll")
        self.assertIn("padding: 24px", column_scroll)
        self.assertIn("overflow-y: auto", column_scroll)
        self.assertRegex(
            css,
            r"\.application-window\[data-maximized\] "
            r"\.export-workspace-track\s*\{[^}]*min-width:\s*100%",
        )
        self.assertRegex(
            css,
            r"\.application-window:not\(\[data-maximized\]\) "
            r"\.export-workspace-track\s*\{[^}]*"
            r"grid-template-columns:\s*350px 410px 340px",
        )

        # Columns are the only top-level regions: neutral 5%-6%, complete
        # 15%/24px edges and directional inset light, with no app-internal
        # backdrop or outer card shadow.
        column = css_block(".export-column")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-secondary)",
            "inset 0 1px 0",
            "inset 0 -1px 0",
        ):
            self.assertIn(expected, column)
        self.assertNotIn("backdrop-filter", column)
        self.assertNotIn("var(--imageweave-shadow-", column)
        self.assertIn(
            "background: var(--imageweave-glass-surface-input)",
            css_block(".export-column--sources"),
        )

        # Source/option/fact/progress/status/action rows are 4%-6%, 10% edged,
        # 16px rounded and flat. The configuration wrapper is structural only.
        flattened = css_block(".export-workspace-state,")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-weak)",
            "border-radius: var(--imageweave-radius-control)",
            "background: var(--imageweave-glass-surface-weak)",
            "box-shadow: none",
            "transform: none",
        ):
            self.assertIn(expected, flattened)
        self.assertNotIn("backdrop-filter", flattened)
        config = css_block(".export-config-panel")
        for expected in (
            "padding: 0",
            "border: 0",
            "background: transparent",
            "box-shadow: none",
        ):
            self.assertIn(expected, config)
        source_hover = css_block(".export-source-card:hover,")
        self.assertIn("box-shadow: none", source_hover)
        self.assertIn("transform: none", source_hover)
        field_hover = css_block(".export-field:hover,")
        self.assertIn("box-shadow: none", field_hover)
        self.assertIn("transform: none", field_hover)

        # Inputs/select consume canonical T6 .app-view styling. Export's action
        # class repeats the same 10%/15%/16px/500ms facts; formal writes remain
        # disabled, readable, and explicitly promise zero file/API activity.
        self.assertIn(".app-view :is(\n  input:not([type])", controls)
        app_inputs = css_block(".export-input,")
        self.assertIn("var(--imageweave-control-height)", app_inputs)
        self.assertNotIn("background:", app_inputs)
        self.assertNotIn("box-shadow:", app_inputs)
        button = css_block(".export-button")
        for expected in (
            "min-height: var(--imageweave-control-height)",
            "var(--imageweave-border-button)",
            "border-radius: var(--imageweave-radius-control)",
            "background: var(--imageweave-glass-surface-button)",
            "box-shadow: var(--imageweave-shadow-control)",
            "var(--imageweave-transition-standard)",
        ):
            self.assertIn(expected, button)
        primary = css_block(".export-button--primary")
        self.assertIn("border-color: var(--imageweave-accent)", primary)
        self.assertIn("var(--imageweave-accent-highlight)", primary)
        self.assertIn("var(--imageweave-glass-surface-button)", primary)
        disabled = css_block(
            '.export-button:is(:disabled, [aria-disabled="true"])'
        )
        for expected in (
            "var(--imageweave-glass-surface-weak)",
            "opacity: 1",
            "text-decoration: line-through",
            "transform: none",
        ):
            self.assertIn(expected, disabled)
        for phrase in (
            "选择目标",
            "开始导出",
            "取消导出",
            "打开结果",
            "动作已禁用，不会写入文件、读取路径或发送业务请求",
        ):
            self.assertIn(phrase, view)
        self.assertGreaterEqual(view.count('"aria-describedby": "export-write-reason"'), 1)

        # Selection and all safe facts use native checked/text plus a complete
        # edge and readable marker. Counts/destination/progress stay white/85
        # monospace instead of relying on color.
        selected = css_block('.export-source-card[data-selected="true"]')
        self.assertIn("var(--imageweave-border-focus)", selected)
        self.assertIn("var(--imageweave-glass-surface-input)", selected)
        selected_marker = css_block(
            '.export-source-card[data-selected="true"]::after'
        )
        self.assertIn('content: "◆ 已选择"', selected_marker)
        self.assertIn("var(--imageweave-accent-highlight)", selected_marker)
        for selector in (
            ".export-source-card__copy small",
            ".export-selection-facts",
            ".export-destination",
            ".export-progress-count",
        ):
            fact = css_exact_block(selector)
            self.assertIn("var(--imageweave-text-fact)", fact)
            self.assertIn("var(--imageweave-font-mono)", fact)
        self.assertIn('attributes: { type: "checkbox", "aria-label":', view)
        self.assertIn('dataset: { selected: String(source.selected) }', view)

        # unavailable/loading/empty/content/error share neutral status planes.
        # running/success/error use badge icon+text, complete semantic edges,
        # a narrow progress fill and deterministic text/next-step facts.
        self.assertRegex(
            css,
            r'data-export-workspace-state="loading"\]\s*\{[^}]*'
            r"border-color:\s*var\(--imageweave-state-running\)"
            r"[^}]*background:\s*"
            r"var\(--imageweave-glass-surface-secondary\)",
        )
        self.assertRegex(
            css,
            r'data-export-workspace-state="error"\]\s*\{[^}]*'
            r"border:\s*var\(--imageweave-border-strong-width\) solid "
            r"var\(--imageweave-state-danger\)[^}]*background:\s*"
            r"var\(--imageweave-glass-surface-secondary\)",
        )
        for state_name, color_name in (
            ("running", "running"),
            ("success", "success"),
            ("error", "danger"),
        ):
            progress = css_block(f".export-progress-card--{state_name}")
            self.assertIn(f"var(--imageweave-state-{color_name})", progress)
            fill = css_block(
                f".export-progress-card--{state_name} .export-progress-fill"
            )
            self.assertIn(f"var(--imageweave-state-{color_name})", fill)
        progress_card = css_exact_block(".export-progress-card")
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            progress_card,
        )
        next_step = css_block(".export-progress-message,")
        self.assertIn("color: var(--imageweave-text-secondary)", next_step)
        progress_fill = css_block(".export-progress-fill")
        self.assertIn(
            "transition: width var(--imageweave-transition-standard)",
            progress_fill,
        )
        for marker in (
            'role: "status"',
            '"aria-live": "polite"',
            '"aria-atomic": "true"',
            'role: "progressbar"',
            '"aria-valuemin": "0"',
            '"aria-valuemax": String(maximum)',
            '"aria-valuenow": String(progress.completed)',
            '"aria-valuetext": valueText',
            "`${percent}% · ${progress.completed} / ${progress.total}`",
            "受控状态提供确定性进度",
            "错误事实：",
            "下一步：检查导出能力状态后重试",
        ):
            self.assertIn(marker, view)
        for phase in (
            "loading",
            "empty",
            "content",
            "running",
            "success",
            "resultError",
            "error",
        ):
            self.assertRegex(fixture_states, rf"\b{phase}:\s*freeze\(")
        self.assertIn(
            "数据集导出后端能力尚未接入；当前不会读取文件系统或发送业务请求。",
            model,
        )

        # All ten legacy Export surfaces and its tracked kicker are gone. Only
        # the canonical no-backdrop fallback retains a *-solid name; internal
        # positive backdrop/filter layers remain exactly zero.
        self.assertEqual(
            re.findall(r"--imageweave-[\w-]*-solid", css),
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(css, r"--imageweave-state-[\w-]*-surface")
        self.assertNotRegex(css, r"text-transform:\s*uppercase")
        self.assertNotRegex(css, r"letter-spacing:\s*0\.0[6-9]em")
        self.assertNotRegex(
            css,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        positive_backdrops = [
            value.strip()
            for value in re.findall(
                r"(?m)^\s*(?:-webkit-)?backdrop-filter\s*:\s*([^;\n]+)",
                css,
            )
            if value.strip() != "none"
        ]
        self.assertEqual(positive_backdrops, [])
        self.assertIn("@media (prefers-contrast: more)", css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", css)
        self.assertIn(':root[data-motion="off"]', css)
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            css,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)", css
        )
        for marker in (
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
            "transition: none !important",
        ):
            self.assertIn(marker, css)

        # Production keeps its unavailable adapter, owns no API/filesystem/
        # download/timer path, and cannot discover the separately mounted
        # tests-only fixture. Lifecycle generations reject late reads and
        # destroy removes both root listeners; the fixture changes state only
        # through direct deterministic setState injection.
        production = "\n".join((controller, view, model))
        self.assertIn("createExportUnavailableAdapter()", controller)
        self.assertIn(
            'projectExportState({ phase: "unavailable" })', controller
        )
        for forbidden in (
            "context.api",
            "/api/",
            "stage5-preview-fixtures",
            "stage5-preview-host",
            "testsOnly",
            "fixture",
            "夹具",
            "fetch(",
            "XMLHttpRequest",
            "showSaveFilePicker",
            "FileSystem",
            "URL.createObjectURL",
            "new Blob",
            "download =",
            "setTimeout",
            "setInterval",
            "requestAnimationFrame",
        ):
            self.assertNotIn(forbidden, production)
        for marker in (
            "let lifecycle = 0",
            "ticket !== lifecycle",
            "if (!active || destroyed",
            'root.addEventListener("change"',
            'root.addEventListener("input"',
            'root.removeEventListener("change"',
            'root.removeEventListener("input"',
            "view.destroy()",
        ):
            self.assertIn(marker, controller)
        for marker in (
            "createExportController",
            "adapterState || initialState",
            "controller.setState(state)",
            "controller?.deactivate()",
            "controller?.activate()",
            "controller?.destroy()",
        ):
            self.assertIn(marker, fixture_host)
        self.assertNotRegex(fixture_host, r"\b(?:setTimeout|setInterval)\s*\(")
        self.assertIn('data-stage5-tests-only="true"', fixture_html)
        self.assertIn('/__webui__/styles/apps/export.css', fixture_html)

    def test_polling_focus_t14_static_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        javascript_root = backend_root / "gdl_backend" / "webui" / "js"
        sources = {
            "polling": (javascript_root / "core" / "polling.js").read_text(
                encoding="utf-8"
            ),
            "focus": (
                javascript_root / "core" / "polling-focus-source.js"
            ).read_text(encoding="utf-8"),
            "main": (javascript_root / "main.js").read_text(encoding="utf-8"),
            "tasks": (javascript_root / "core" / "tasks-model.js").read_text(
                encoding="utf-8"
            ),
            "review": (javascript_root / "core" / "review-model.js").read_text(
                encoding="utf-8"
            ),
            "proxy": (javascript_root / "apps" / "proxy.js").read_text(
                encoding="utf-8"
            ),
            "vault": (javascript_root / "apps" / "vault.js").read_text(
                encoding="utf-8"
            ),
            "diagnostics": (
                javascript_root / "core" / "diagnostics-model.js"
            ).read_text(encoding="utf-8"),
            "shell": (
                javascript_root / "components" / "taskbar-summary.js"
            ).read_text(encoding="utf-8"),
        }

        self.assertIn("UNFOCUSED_POLL_MULTIPLIER = 4", sources["polling"])
        self.assertIn("getFocusedScope", sources["focus"])
        self.assertIn("getScopeState", sources["focus"])
        self.assertIn("subscribe", sources["focus"])
        self.assertIn(
            "focusSource: createStorePollingFocusSource(store)", sources["main"]
        )
        self.assertIn("alwaysFocusRate: true", sources["vault"])
        for name, fingerprint in {
            "tasks": "TASK_POLL_INTERVAL_MS = 1_500",
            "review": "REVIEW_POLL_INTERVAL_MS = 1_500",
            "proxy": "STATUS_POLL_INTERVAL_MS = 10_000",
            "vault": "AUTHORIZATION_POLL_INTERVAL_MS = 800",
            "diagnostics": "DIAGNOSTICS_POLL_INTERVAL_MS = 20_000",
            "shell": "SHELL_POLL_INTERVAL_MS = 30_000",
        }.items():
            self.assertIn(fingerprint, sources[name], name)
        self.assertIn('SHELL_POLL_SCOPE = "shell"', sources["shell"])

    def test_policy_simplified_static_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        policy_dom = (webui / "js" / "components" / "policy-dom.js").read_text(
            encoding="utf-8"
        )
        policy_view = (webui / "js" / "components" / "policy-view.js").read_text(
            encoding="utf-8"
        )
        policy_app = (webui / "js" / "apps" / "policy.js").read_text(
            encoding="utf-8"
        )
        policy_model = (webui / "js" / "core" / "policy-model.js").read_text(
            encoding="utf-8"
        )
        policy_css = (webui / "styles" / "apps" / "policy.css").read_text(
            encoding="utf-8"
        )
        definitions = (webui / "js" / "core" / "app-definitions.js").read_text(
            encoding="utf-8"
        )
        combined = "\n".join(
            (policy_dom, policy_view, policy_app, policy_model, policy_css)
        )

        self.assertIn('id: "policy"', definitions)
        self.assertIn('label: "站点设置"', definitions)
        self.assertIn('windowTitle: "站点设置"', definitions)
        self.assertIn('group: "connections"', definitions)
        self.assertIn('description: "配置各站点的并发、重试和代理策略。"', definitions)
        self.assertIn('createElement("nav", {', policy_dom)
        self.assertIn('attributes: { "aria-label": "五个站点的设置状态" }', policy_dom)
        for label in (
            "最大并发数",
            "重试次数",
            "首次重试等待",
            "连接方式",
            "保存设置",
            "恢复默认设置",
            "直连",
            "优先代理（不可用时直连）",
            "仅代理（不可用时失败）",
        ):
            self.assertIn(label, policy_dom)
        for field in (
            "max_concurrency",
            "retry_limit",
            "backoff_base_seconds",
            "proxy_mode",
        ):
            self.assertIn(f'"{field}"', policy_dom)
        for retired in (
            "probe_url",
            "probe_before_use",
            "node_tags",
            "http_timeout",
            "gallery_retries",
            "task_timeout_seconds",
            "download_stall_timeout_seconds",
            "eh_download",
            "extra_args",
            "真实契约边界",
            "SQLite 覆盖",
            "启动默认快照",
            "权威投影",
            "契约边界",
            "指数退避",
            "argv",
            "打开 VAULT.CPL",
            "手动刷新",
            "放弃未保存更改",
        ):
            self.assertNotIn(retired, combined)
        self.assertNotIn('policyButton("discard"', policy_dom)
        self.assertNotIn('policyButton("refresh"', policy_dom)
        self.assertNotIn('policyButton("vault"', policy_dom)
        self.assertIn("beforeLeave()", policy_app)
        self.assertIn("beforeWindowHide(visibility)", policy_app)
        self.assertIn('globalThis.addEventListener?.("beforeunload"', policy_app)
        self.assertIn('"aria-live": "polite"', policy_dom)
        self.assertIn('"aria-live": "assertive"', policy_dom)

    def test_personalization_runtime_css_static_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        runtime = (webui / "js" / "core" / "personalization.js").read_text(
            encoding="utf-8"
        )
        personalization_model = (
            webui / "js" / "core" / "personalization-model.js"
        ).read_text(encoding="utf-8")
        storage_preferences = (
            webui / "js" / "core" / "storage-preferences.js"
        ).read_text(encoding="utf-8")
        wallpaper_cleanup = (
            webui / "js" / "core" / "wallpaper-storage.js"
        ).read_text(encoding="utf-8")
        personalization_view = (
            webui / "js" / "components" / "personalization-view.js"
        ).read_text(encoding="utf-8")
        personalization_app = (
            webui / "js" / "apps" / "personalization.js"
        ).read_text(encoding="utf-8")
        personalization_css = (
            webui / "styles" / "apps" / "personalization.css"
        ).read_text(encoding="utf-8")
        main = (webui / "js" / "main.js").read_text(encoding="utf-8")
        index = (webui / "index.html").read_text(encoding="utf-8")
        desktop_css = (webui / "styles" / "desktop.css").read_text(
            encoding="utf-8"
        )
        tokens_css = (webui / "styles" / "tokens.css").read_text(
            encoding="utf-8"
        )

        self.assertIn(
            'export const PERSONALIZATION_PREFERENCE_KEYS = Object.freeze([\n'
            '  "animations",\n  "wallpaperColor",\n]);',
            personalization_model,
        )
        self.assertIn(
            'export const PERSONALIZATION_DEFAULTS = Object.freeze({\n'
            '  animations: "on",\n  wallpaperColor: "graphite",\n});',
            personalization_model,
        )
        for scene in (
            "graphite",
            "slate",
            "deep-ocean",
            "forest",
            "plum-gray",
            "warm-paper",
        ):
            self.assertIn(scene, personalization_model)
            self.assertIn(f".desktop-wallpaper--{scene}", desktop_css)
        self.assertIn('wallpaperKind === "custom"', personalization_model)
        self.assertIn('DANGEROUS_KEYS', personalization_model)
        self.assertIn('Object.getOwnPropertyDescriptors', personalization_model)
        self.assertNotIn("taskbarDensity", storage_preferences)
        self.assertIn("normalizePersonalizationPreferences", storage_preferences)
        self.assertIn("projectPersonalizationPreferences", storage_preferences)

        retired_runtime_patterns = (
            r"wallpaper(?:Image|Mask|Fit|Position|MaskTone|MaskStrength|Blur)",
            r"windowOpacity",
            r"themeAccent|themeSurface|themeRoot",
            r"createObjectURL|revokeObjectURL",
            r"desktop-wallpaper__(?:image|mask)",
            r"window-layer--opacity",
        )
        runtime_closure = "\n".join(
            (runtime, personalization_view, personalization_app, main, index)
        )
        for pattern in retired_runtime_patterns:
            self.assertNotRegex(runtime_closure, pattern)
        self.assertNotRegex(
            desktop_css,
            r"desktop-wallpaper__(?:image|mask)|desktop-wallpaper--"
            r"(?:custom|fit-|position-|mask-|blur-)|window-layer--opacity",
        )
        self.assertFalse(
            (webui / "js" / "core" / "wallpaper-image-import.js").exists()
        )
        self.assertNotRegex(personalization_view, r'type:\s*"(?:color|file)"')
        self.assertNotIn("innerHTML", personalization_view)
        self.assertNotIn(".style", personalization_view)
        self.assertNotIn("/api/", personalization_view + personalization_app)
        self.assertIn('datasetName: "personalizationScene"', personalization_view)
        self.assertIn('datasetName: "personalizationMotion"', personalization_view)
        self.assertEqual(personalization_view.count("PERSONALIZATION_SCENE_CHOICES"), 2)
        for title in ('"场景"', '"动效"', '"应用"'):
            self.assertIn(title, personalization_view)
        for action in ('"apply"', '"cancel"', '"reset"'):
            self.assertIn(action, personalization_view)
        self.assertIn("beforeLeave()", personalization_app)
        self.assertIn("beforeWindowHide(visibility)", personalization_app)
        self.assertIn('globalThis.addEventListener?.("beforeunload"', personalization_app)
        self.assertIn("discardRequest", personalization_app)
        self.assertNotIn('addEventListener("input"', personalization_app)

        self.assertEqual(
            len(re.findall(r"cleanupLegacyCustomWallpaper\s*\(", main)),
            1,
        )
        self.assertIn(
            "void cleanupLegacyCustomWallpaper().catch(() => {});",
            main,
        )
        self.assertNotIn("wallpaperStorage", main)
        self.assertIn(
            'const windowLayer = document.querySelector("[data-window-layer]")',
            main,
        )
        self.assertIn("measureWindowLayerViewport(windowLayer, document)", main)
        self.assertIn("windowLayerGeometryOptions()", main)

        self.assertEqual(
            wallpaper_cleanup.count(".delete("),
            1,
        )
        for forbidden in (
            ".get(",
            ".put(",
            "readonly",
            "Blob",
            "createObjectStore",
            "deleteDatabase",
            "wallpaper-image-import",
        ):
            self.assertNotIn(forbidden, wallpaper_cleanup)
        for expected in ('"imageweave-ui"', '"wallpapers"', '"custom"', '"readwrite"'):
            self.assertIn(expected, wallpaper_cleanup)
        self.assertIn("closeConnection(connection)", wallpaper_cleanup)
        self.assertIn("openRequest.onblocked", wallpaper_cleanup)
        self.assertIn("openRequest.onerror", wallpaper_cleanup)
        self.assertIn("transaction.onerror", wallpaper_cleanup)
        self.assertIn("transaction.onabort", wallpaper_cleanup)

        self.assertIn(
            '<html lang="zh-CN" data-motion="on" data-theme-tone="dark">',
            index,
        )
        self.assertIn('<meta name="color-scheme" content="dark">', index)
        self.assertNotIn('data-theme-tone="light"', index + tokens_css)
        self.assertNotIn("color-scheme: light", tokens_css)
        self.assertIn("color-scheme: dark", tokens_css)
        self.assertNotIn("data-desktop-wallpaper-image", index)
        self.assertNotIn("data-desktop-wallpaper-mask", index)
        self.assertIn("data-desktop-wallpaper", index)
        self.assertIn("data-window-layer", index)
        self.assertIn("data-application-window", index)

        self.assertRegex(
            personalization_css,
            r"\.personalization-workspace\s*\{[^}]*overflow-x:\s*auto;"
            r"[^}]*overflow-y:\s*hidden;",
        )
        self.assertIn("min-width: 1120px", personalization_css)
        self.assertIn("grid-template-columns: minmax", personalization_css)
        self.assertIn(
            "min-height: var(--imageweave-control-height)",
            personalization_css,
        )
        self.assertIn("@media (forced-colors: active)", personalization_css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", personalization_css)
        self.assertIn(':root[data-motion="off"]', personalization_css)
        self.assertIn("CanvasText", personalization_css)
        self.assertIn("ButtonFace", personalization_css)
        self.assertIn("Highlight", personalization_css)

    def test_personalization_t75_visual_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        css = (webui / "styles" / "apps" / "personalization.css").read_text(
            encoding="utf-8"
        )
        controls = (webui / "styles" / "controls.css").read_text(
            encoding="utf-8"
        )
        desktop = (webui / "styles" / "desktop.css").read_text(
            encoding="utf-8"
        )
        view = (
            webui / "js" / "components" / "personalization-view.js"
        ).read_text(encoding="utf-8")
        model = (
            webui / "js" / "core" / "personalization-model.js"
        ).read_text(encoding="utf-8")
        controller = (
            webui / "js" / "apps" / "personalization.js"
        ).read_text(encoding="utf-8")
        runtime = (webui / "js" / "core" / "personalization.js").read_text(
            encoding="utf-8"
        )
        cleanup = (
            webui / "js" / "core" / "wallpaper-storage.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            marker = f"{selector} {{"
            start = css.find(marker)
            self.assertNotEqual(start, -1, selector)
            opening = css.find("{", start)
            closing = css.find("}", opening)
            self.assertNotEqual(closing, -1, selector)
            return css[opening + 1 : closing]

        # Three columns retain the desktop-only scroll ownership: the ordinary
        # 800x560 window scrolls the track horizontally, maximized fits all
        # columns, and each column owns only its vertical scroll.
        workspace = css_block(".personalization-workspace")
        for expected in (
            "padding: 24px",
            "overflow-x: auto",
            "overflow-y: hidden",
        ):
            self.assertIn(expected, workspace)
        track = css_block(".personalization-workspace-track")
        self.assertGreaterEqual(track.count("minmax("), 3)
        self.assertIn("gap: 24px", track)
        self.assertIn("min-width: 1120px", track)
        column_scroll = css_block(".personalization-column-scroll")
        self.assertIn("padding: 24px", column_scroll)
        self.assertIn("overflow-y: auto", column_scroll)
        self.assertRegex(
            css,
            r"\.application-window\[data-maximized\] "
            r"\.personalization-workspace-track\s*\{[^}]*"
            r"min-width:\s*100%",
        )
        self.assertNotRegex(css, r"@media\s*\(max-width\s*:")

        # Top-level columns are 5%-6%, 24px cards with complete 15% edges and
        # only directional inset light. Internal panels are structural sections,
        # while choices/facts/status are shadowless 4% rows.
        column = css_block(".personalization-column")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-input)",
            "inset 0 1px 0",
            "inset 0 -1px 0",
        ):
            self.assertIn(expected, column)
        self.assertNotIn("backdrop-filter", column)
        self.assertNotIn("var(--imageweave-shadow-", column)
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            css_block(
                ".personalization-column:first-child,\n"
                ".personalization-column--apply"
            ),
        )
        rows = css_block(
            ".personalization-choice,\n"
            ".personalization-motion-limit,\n"
            ".personalization-save-status,\n"
            ".personalization-preview-state,\n"
            ".personalization-preview-fact"
        )
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-weak)",
            "border-radius: var(--imageweave-radius-control)",
            "background: var(--imageweave-glass-surface-weak)",
            "box-shadow: none",
            "transform: none",
        ):
            self.assertIn(expected, rows)
        panel = css_block(".personalization-app .personalization-panel")
        for expected in (
            "border-bottom",
            "var(--imageweave-border-weak)",
            "background: transparent",
            "background-image: none",
            "box-shadow: none",
        ):
            self.assertIn(expected, panel)

        # The only *-solid token is the canonical capability fallback. No
        # internal row creates a blur/filter layer, state tint, large shadow,
        # one-sided marker or old quick transition.
        self.assertEqual(
            re.findall(r"--imageweave-[\w-]*-solid", css),
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(css, r"--imageweave-state-[\w-]*-surface")
        self.assertNotRegex(
            css,
            r"(?m)^\s*(?:-webkit-)?backdrop-filter\s*:"
            r"(?![^\n]*\bnone\b)",
        )
        self.assertNotRegex(css, r"(?m)^\s*filter\s*:")
        self.assertNotRegex(
            css,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        self.assertNotRegex(css, r"\b(?:100|120|150|180)ms\b")
        self.assertIn("var(--imageweave-transition-standard)", css)

        # Six controls and the large read-only preview reuse desktop.css as the
        # sole visual scene source. The 1440x900 canvas scales that same radial
        # composition instead of copying six arbitrary colors into app CSS.
        labels = (
            'graphite: "夜航石墨"',
            'slate: "月岩"',
            '"deep-ocean": "深海"',
            'forest: "深林"',
            '"plum-gray": "雾褐"',
            '"warm-paper": "暖夜"',
        )
        for label in labels:
            self.assertIn(label, model)
        for label in (
            'label: "夜航石墨"',
            'label: "月岩"',
            'label: "深海"',
            'label: "深林"',
            'label: "雾褐"',
            'label: "暖夜"',
        ):
            self.assertIn(label, view)
        for marker in (
            "function sceneCanvasClass(sceneId)",
            "desktop-wallpaper--${sceneId}",
            "scenePreview: true",
            "previewSceneCanvas.className = sceneCanvasClass(preview.scene.id)",
            'root.className = "app-view personalization-app"',
        ):
            self.assertIn(marker, view)
        self.assertNotRegex(
            css,
            r"personalization-preview-desktop\["
            r"data-personalization-scene=",
        )
        self.assertNotRegex(
            css,
            r"#20242A|#384554|#20364A|#294039|#403341|#E7E1D6",
        )
        scene_canvas = css_block(".personalization-scene-canvas")
        self.assertIn("width: 1440px", scene_canvas)
        self.assertIn("height: 900px", scene_canvas)
        self.assertIn("scale(0.05)", scene_canvas)
        for scene in (
            "graphite",
            "slate",
            "deep-ocean",
            "forest",
            "plum-gray",
            "warm-paper",
        ):
            match = re.search(
                rf"\.desktop-wallpaper--{re.escape(scene)}\s*\{{([^}}]+)\}}",
                desktop,
            )
            self.assertIsNotNone(match, scene)
            self.assertGreaterEqual(match.group(1).count("radial-gradient("), 2)
        preview = css_block(".personalization-preview-desktop")
        self.assertIn(
            "border-radius: var(--imageweave-radius-control)", preview
        )
        self.assertNotIn("var(--imageweave-shadow-", preview)

        # Native radios plus readable selected/current copy, a complete 35%
        # edge and a champagne diamond carry state without color alone.
        radio = css_block('.personalization-choice input[type="radio"]')
        for expected in (
            "width: 20px",
            "height: 20px",
            "accent-color: var(--imageweave-accent)",
        ):
            self.assertIn(expected, radio)
        for marker in (
            '"aria-describedby": [descriptionId, stateId]',
            'personalizationSelected: "false"',
            'personalizationCurrent: "false"',
            'return "已选择 · 当前应用"',
            'return "已选择"',
            'return "当前应用"',
        ):
            self.assertIn(marker, view)
        self.assertRegex(
            css,
            r'data-personalization-selected="true"[\s\S]*?'
            r'data-personalization-current="true"[\s\S]*?'
            r"border-color:\s*var\(--imageweave-border-focus\)",
        )
        self.assertIn(
            'content: "◆"',
            css_block(
                ".personalization-choice__selection:not(:empty)::before"
            ),
        )
        hover = css_block(
            ".personalization-choice:hover:not(:has(input:disabled))"
        )
        for expected in (
            "background: var(--imageweave-glass-surface-secondary)",
            "box-shadow: none",
            "transform: none",
        ):
            self.assertIn(expected, hover)

        # Dirty/saving/success/error remain neutral 5% status rows. Shapes,
        # text, full semantic borders and the T6 primary action are all present.
        for state, token in (
            ("clean", "success"),
            ("dirty", "warning"),
            ("saving", "running"),
            ("success", "success"),
            ("error", "danger"),
        ):
            self.assertRegex(
                css,
                rf'data-personalization-status="{state}"'
                rf"[\s\S]*?--imageweave-state-{token}",
                state,
            )
        for marker in (
            'content: "△ 未应用 · "',
            'content: "▶ 保存中 · "',
            'content: "✓ 完成 · "',
            'content: "! 保存失败 · "',
        ):
            self.assertIn(marker, css)
        error = css_block(
            '.personalization-save-status['
            'data-personalization-status="error"]'
        )
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            error,
        )
        self.assertRegex(
            controls,
            r"\.personalization-button\.personalization-button--primary"
            r"[\s\S]*?border-color:\s*var\(--imageweave-accent\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\)",
        )
        self.assertNotRegex(
            css,
            r"\.personalization-button--primary\s*\{[^}]*background",
        )
        actions = css_block(".personalization-actions .personalization-button")
        self.assertIn(
            "min-height: var(--imageweave-control-height)", actions
        )

        # Canonical no-backdrop, contrast, forced-colors and both motion opt-outs
        # are explicit; forced colors remove gradients, shadows and backdrop.
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            css,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)", css
        )
        self.assertIn("@media (prefers-contrast: more)", css)
        self.assertIn("@media (forced-colors: active)", css)
        for expected in (
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
        ):
            self.assertIn(expected, css)
        self.assertIn(':root[data-motion="off"]', css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", css)
        self.assertGreaterEqual(css.count("transition: none !important"), 3)

        # T7.5 changes only presentation/accessible scene semantics. T3's two
        # fields, live preview, single-flight save/leave, lifecycle cleanup and
        # delete-only best-effort migration boundaries stay explicit.
        self.assertIn(
            'export const PERSONALIZATION_PREFERENCE_KEYS = Object.freeze([\n'
            '  "animations",\n  "wallpaperColor",\n]);',
            model,
        )
        for marker in (
            "personalization.preview(view.readDraft(current.draft))",
            "await personalization.commit()",
            "personalization.cancel()",
            "discardRequest",
            "beforeLeave()",
            "beforeWindowHide(visibility)",
            'globalThis.addEventListener?.("beforeunload"',
            "invalidateViewOperations()",
            "unsubscribe()",
        ):
            self.assertIn(marker, controller)
        for marker in (
            "projectPersonalizationPreferences(preferences)",
            "writePersonalizationPreferences",
            "preferencesToCommit",
            "lifecycleVersion",
            "applyScene(wallpaper, draft.wallpaperColor)",
            "previewMotion(motion, draft.animations)",
        ):
            self.assertIn(marker, runtime)
        self.assertEqual(cleanup.count(".delete("), 1)
        for forbidden in (
            ".get(",
            ".put(",
            "Blob",
            "createObjectStore",
            "deleteDatabase",
        ):
            self.assertNotIn(forbidden, cleanup)
        combined = "\n".join((view, model, controller, runtime))
        for forbidden in (
            'type: "color"',
            'type: "file"',
            "createObjectURL",
            "setProperty(",
            "windowOpacity",
            "themeAccent",
            "themeSurface",
            "/api/",
            "innerHTML",
        ):
            self.assertNotIn(forbidden, combined)

    def test_glass_phase_one_visual_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        styles = webui / "styles"
        index = (webui / "index.html").read_text(encoding="utf-8")
        tokens = (styles / "tokens.css").read_text(encoding="utf-8")
        base = (styles / "base.css").read_text(encoding="utf-8")
        desktop = (styles / "desktop.css").read_text(encoding="utf-8")
        controls = (styles / "controls.css").read_text(encoding="utf-8")
        status = (styles / "status.css").read_text(encoding="utf-8")
        dialog = (styles / "dialog.css").read_text(encoding="utf-8")
        runtime = (webui / "js" / "core" / "personalization.js").read_text(
            encoding="utf-8"
        )
        model = (
            webui / "js" / "core" / "personalization-model.js"
        ).read_text(encoding="utf-8")
        shared_dom = {
            "status-badge": webui / "js" / "components" / "status.js",
            "empty-state": webui / "js" / "components" / "empty-state.js",
            "error-view": webui / "js" / "components" / "error-view.js",
            "imageweave-dialog": webui / "js" / "components" / "dialog.js",
        }
        app_ids = (
            "crawl",
            "tasks",
            "proxy",
            "vault",
            "review",
            "policy",
            "diagnostics",
            "personalization",
        )
        app_css = {
            app_id: (styles / "apps" / f"{app_id}.css").read_text(
                encoding="utf-8"
            )
            for app_id in app_ids
        }
        production_css = "\n".join(
            [tokens, base, desktop, controls, status, dialog, *app_css.values()]
        )

        # T4 只有一个 dark 根主题；玻璃事实使用固定白色 alpha。T9 只保留
        # 仍有真实生产消费者的语义 alias，不保留零引用迁移 alias 或着色派生。
        self.assertNotIn(':root[data-theme-tone="dark"]', tokens)
        self.assertNotIn('data-theme-tone="light"', tokens)
        self.assertNotIn("color-scheme: light", tokens)
        self.assertIn("color-scheme: dark", tokens)
        self.assertIn("--imageweave-background-deepest: #060A13", tokens)
        self.assertIn("--imageweave-background-default: #0B1322", tokens)
        self.assertIn("--imageweave-accent: #E4B863", tokens)
        self.assertIn("--imageweave-accent-highlight: #F3DCA8", tokens)
        self.assertIn("--imageweave-focus-glow: rgb(228 184 99 / 0.18)", tokens)
        self.assertNotIn("color-mix", tokens)

        canonical_surfaces = {
            "weak": "0.04",
            "secondary": "0.05",
            "input": "0.06",
            "default": "0.08",
            "button": "0.10",
            "environment": "0.12",
            "hover": "0.15",
        }
        for name, alpha in canonical_surfaces.items():
            self.assertIn(
                f"--imageweave-glass-surface-{name}: "
                f"rgb(255 255 255 / {alpha});",
                tokens,
            )
        all_css = "\n".join(
            path.read_text(encoding="utf-8")
            for path in sorted(styles.rglob("*.css"))
        )
        retained_aliases = {
            "text-primary": "text-heading",
            "text-secondary": "text-body",
            "text-code": "text-fact",
            "border-strong": "border-button",
            "separator": "border-weak",
            "focus-ring": "accent",
            "focus-halo": "focus-glow",
            "shadow-menu": "shadow-window",
            "shadow-dock": "shadow-window",
        }
        for alias, canonical in retained_aliases.items():
            token = f"--imageweave-{alias}"
            self.assertIn(
                f"{token}: var(--imageweave-{canonical});",
                tokens,
            )
            self.assertGreater(
                len(re.findall(rf"var\(\s*{re.escape(token)}\s*\)", all_css)),
                0,
                f"保留 alias 必须有生产消费者：{token}",
            )
        retired_aliases = (
            "surface",
            "text-inverse",
            "surface-content-solid",
            "surface-navigation-solid",
            "surface-environment-solid",
            "surface-control-solid",
            "surface-content",
            "surface-navigation",
            "surface-environment",
            "surface-control",
            "surface-control-hover",
            "surface-control-active",
            "border-strong-solid",
            "border-subtle",
            "border-soft",
            "state-danger-surface-solid",
            "state-danger-surface",
            "state-warning-surface-solid",
            "state-warning-surface",
            "state-success-surface-solid",
            "state-success-surface",
            "state-running-surface-solid",
            "state-running-surface",
            "state-disabled-surface-solid",
            "state-disabled-surface",
            "danger",
            "warning",
            "success",
            "radius-lg",
            "radius-md",
            "radius-sm",
            "shadow-panel",
            "shadow-flyout",
            "glass-blur-navigation",
            "transition-fast",
        )
        for alias in retired_aliases:
            token = f"--imageweave-{alias}"
            self.assertNotRegex(
                all_css,
                rf"{re.escape(token)}(?=\s*[:),])",
                f"零消费者迁移 alias 必须删除：{token}",
            )
        for fallback in (
            "--imageweave-fallback-window-solid",
            "--imageweave-fallback-elevated-solid",
        ):
            self.assertIn(f"{fallback}:", tokens)
            self.assertGreater(all_css.count(f"var({fallback})"), 0)
        defined_tokens = set(re.findall(r"(--imageweave-[\w-]+)\s*:", all_css))
        consumed_tokens = set(re.findall(r"var\(\s*(--imageweave-[\w-]+)", all_css))
        self.assertEqual(consumed_tokens - defined_tokens, set())

        for expected in (
            "--imageweave-glass-blur-environment: 40px",
            "--imageweave-glass-blur-window: 60px",
            "--imageweave-glass-saturation: 180%",
            "--imageweave-radius-window: 24px",
            "--imageweave-radius-card: 24px",
            "--imageweave-radius-control: 16px",
            "--imageweave-motion-duration: 500ms",
            "--imageweave-motion-easing: cubic-bezier(0.16, 1, 0.3, 1)",
        ):
            self.assertIn(expected, tokens)
        self.assertRegex(tokens, r"inset 0 1px 0 rgb\(255 255 255 / 0\.2[25]\)")
        self.assertIn("inset 0 -1px 0 rgb(2 6 16 / 0.35)", tokens)

        scene_bases = {
            "graphite": "#080D15",
            "slate": "#0B1322",
            "deep-ocean": "#07111B",
            "forest": "#081210",
            "plum-gray": "#100C0B",
            "warm-paper": "#120D0A",
        }
        for scene, base_color in scene_bases.items():
            match = re.search(
                rf"\.desktop-wallpaper--{re.escape(scene)}\s*\{{(?P<body>.*?)\n\}}",
                desktop,
                flags=re.DOTALL,
            )
            self.assertIsNotNone(match, scene)
            body = match.group("body")
            self.assertGreaterEqual(body.count("radial-gradient("), 2, scene)
            self.assertIn(base_color, body, scene)
        self.assertEqual(desktop.count('url("../assets/noise.svg")'), 1)
        self.assertEqual(index.count('class="desktop-noise"'), 1)
        self.assertRegex(
            desktop,
            r"\.desktop-noise\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;"
            r"[^}]*opacity:\s*0\.025;[^}]*pointer-events:\s*none;",
        )
        forced_desktop = desktop.split("@media (forced-colors: active)", 1)[1]
        self.assertRegex(
            forced_desktop,
            r"\.desktop-noise\s*\{[^}]*display:\s*none;"
            r"[^}]*background-image:\s*none;",
        )

        token_groups = {
            "text": ("primary", "secondary", "code"),
            "border": ("strong",),
            "shadow": ("window", "menu", "dock", "card", "control"),
            "radius": ("window", "card", "control", "pill"),
            "state": ("danger", "warning", "success", "running", "disabled"),
        }
        for group, names in token_groups.items():
            for name in names:
                self.assertIn(f"--imageweave-{group}-{name}:", tokens)
        for token_name in (
            "--imageweave-separator:",
            "--imageweave-focus-ring:",
            "--imageweave-menubar-height:",
            "--imageweave-dock-height:",
            "--imageweave-window-title-height:",
            "--imageweave-control-height:",
            "--imageweave-desktop-min-width:",
            "--imageweave-desktop-min-height:",
        ):
            self.assertIn(token_name, tokens)
        self.assertIn("system-ui", tokens)
        self.assertIn("--imageweave-font-display", tokens)
        self.assertIn('"Songti SC", "STSong", "Noto Serif CJK SC"', tokens)
        self.assertIn("--imageweave-font-mono", tokens)
        self.assertIn("font-family: var(--imageweave-font-sans)", base)
        self.assertIn("font-family: var(--imageweave-font-display)", base)
        self.assertIn("font-family: var(--imageweave-font-mono)", controls)

        # 共享 selector 覆盖全部八个真实应用按钮；面板只要求生产 DOM 中实际存在的五类。
        for app_id in app_ids:
            self.assertIn(f".{app_id}-button", controls, app_id)
        for app_id in (
            "vault",
            "review",
            "policy",
            "diagnostics",
            "personalization",
        ):
            self.assertIn(f".{app_id}-panel", controls, app_id)
        for retired_selector in (
            ".crawl-panel",
            ".tasks-panel",
            ".taskbar-summary-action",
            ".proxy-panel-heading",
        ):
            self.assertNotIn(retired_selector, production_css)
        self.assertNotIn("--imageweave-window-action-size:", tokens)
        forced_controls = controls.split("@media (forced-colors: active)", 1)[1]
        self.assertIn(".menu-bar__summary-action", forced_controls)
        self.assertIn("transition: none !important", forced_controls)
        self.assertIn("color: ButtonText", forced_controls)
        self.assertIn("solid Highlight !important", forced_controls)
        for selector in ("input[type=\"search\"]", "select", "textarea"):
            self.assertIn(selector, controls)
        self.assertIn("[aria-invalid=\"true\"]", controls)
        self.assertIn(":disabled", controls)
        self.assertIn("--imageweave-focus-ring", base)
        self.assertIn("--imageweave-focus-ring", controls)
        for class_name, source_path in shared_dom.items():
            source = source_path.read_text(encoding="utf-8")
            self.assertIn(class_name, source)
            self.assertIn(f".{class_name}", status + dialog)
        for state_name in ("ready", "running", "warning", "error", "disabled"):
            self.assertIn(f'[data-status="{state_name}"]', status)
        self.assertIn('role: status === "error" ? "alert" : "status"', shared_dom["empty-state"].read_text(encoding="utf-8"))
        self.assertIn('attributes: { role: "alert" }', shared_dom["error-view"].read_text(encoding="utf-8"))

        # 不支持 backdrop 时使用实色；标准/WebKit、强制颜色、对比度和
        # 两种动效关闭路径都可独立生效。
        for source in (desktop, dialog):
            self.assertIn("@supports not", source)
            self.assertIn("backdrop-filter: blur(1px)", source)
            self.assertIn("-webkit-backdrop-filter: blur(1px)", source)
            self.assertIn("-solid) !important", source)
        self.assertIn("@media (prefers-contrast: more)", tokens + base + desktop)
        for source in (base, desktop, controls, status, dialog):
            self.assertIn("@media (forced-colors: active)", source)
        forced_contract = "\n".join((base, desktop, controls, status, dialog))
        for declaration in (
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "GrayText",
        ):
            self.assertIn(declaration, forced_contract)
        self.assertIn(':root[data-motion="off"]', status)
        self.assertIn("@media (prefers-reduced-motion: reduce)", status)
        self.assertGreaterEqual(status.count("transition: none !important"), 2)
        self.assertGreaterEqual(status.count("animation: none !important"), 2)

        # 个性化运行时不再写颜色属性；正式偏好只保留场景与动效。
        set_property_names = re.findall(
            r'\.setProperty\(\s*"([^"]+)"', runtime
        )
        self.assertEqual(set_property_names, [])
        preference_keys = re.search(
            r"export const PERSONALIZATION_PREFERENCE_KEYS = Object\.freeze\(\["
            r"(?P<body>.*?)\]\);",
            model,
            flags=re.DOTALL,
        ).group("body")
        self.assertEqual(preference_keys.count('"animations"'), 1)
        self.assertEqual(preference_keys.count('"wallpaperColor"'), 1)
        self.assertNotIn("themeAccent", preference_keys)
        self.assertNotIn("themeSurface", preference_keys)
        for forbidden in ("oklch(", "@import", "http://", "https://", "data:image", "data:font"):
            self.assertNotIn(forbidden, production_css)

    def test_nocturne_os_shell_visual_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        index = (webui / "index.html").read_text(encoding="utf-8")
        desktop = (webui / "styles" / "desktop.css").read_text(
            encoding="utf-8"
        )
        taskbar = (
            webui / "js" / "components" / "taskbar-windows.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str, *, body_contains: str | None = None) -> str:
            matches = list(re.finditer(
                rf"(?m)^\s*{re.escape(selector)}\s*\{{",
                desktop,
            ))
            self.assertTrue(matches, selector)
            for match in matches:
                opening = desktop.index("{", match.start())
                closing = desktop.index("}", opening)
                body = desktop[opening + 1 : closing]
                if body_contains is None or body_contains in body:
                    return body
            self.fail(f"CSS selector 缺少目标声明：{selector} -> {body_contains}")

        # T5 只改现有壳层视觉；窗口 DOM、交通灯 ARIA 和状态 marker
        # 继续由既有 manager/component 投影，不增第二套状态所有权。
        self.assertEqual(index.count("data-application-window"), 1)
        self.assertEqual(index.count("window-traffic-light--"), 3)
        self.assertEqual(index.count("data-window-close"), 1)
        self.assertEqual(index.count("data-window-minimize"), 1)
        self.assertEqual(index.count("data-window-maximize"), 1)
        self.assertIn('aria-disabled="false"', index)
        self.assertIn('aria-pressed="false"', index)
        for marker in (
            "data-menu-bar",
            "data-application-center-host",
            "data-dock",
            "data-task-window-list",
        ):
            self.assertEqual(index.count(marker), 1, marker)

        # 正常壳层直接消费 canonical 中性玻璃；旧 surface-*-solid
        # 双声明不再出现在本阶段源码，实色只保留于能力/对比度 fallback。
        self.assertNotRegex(
            desktop,
            r"--imageweave-surface-[\w-]*-solid",
        )
        self.assertNotIn("color-mix(", desktop)
        menu_bar = css_block(".menu-bar")
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)", menu_bar
        )
        self.assertIn("border-bottom", menu_bar)
        self.assertIn("var(--imageweave-border-weak)", menu_bar)
        self.assertIn("inset 0 1px 0", menu_bar)
        self.assertIn("inset 0 -1px 0", menu_bar)
        self.assertIn("0 14px 36px", menu_bar)
        menu_popover = css_block(".menu-popover")
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            menu_popover,
        )
        self.assertIn("min-width: 260px", menu_popover)
        menu_item = css_block(".menu-popover__item")
        self.assertIn("min-height: var(--imageweave-control-height)", menu_item)
        self.assertIn(
            "background: var(--imageweave-glass-surface-weak)", menu_item
        )
        self.assertNotIn("backdrop-filter", menu_item)

        application_window = css_block(".application-window")
        self.assertIn("width: 800px", application_window)
        self.assertIn("height: 560px", application_window)
        self.assertIn("border-radius: var(--imageweave-radius-window)", application_window)
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            application_window,
        )
        focused_window = css_block(
            ".application-window[data-window-focused]"
        )
        self.assertIn("var(--imageweave-border-focus)", focused_window)
        self.assertIn("var(--imageweave-focus-glow)", focused_window)
        self.assertIn("0 24px 72px", focused_window)
        interacting_window = css_block(
            ".application-window[data-window-interacting]"
        )
        self.assertIn("box-shadow: none", interacting_window)
        self.assertIn("transition: none", interacting_window)
        maximized_window = css_block(".application-window[data-maximized]")
        self.assertIn("border-radius: 0", maximized_window)
        titlebar = css_block(".window-titlebar")
        self.assertIn(
            "background: var(--imageweave-glass-surface-weak)", titlebar
        )
        self.assertNotIn("backdrop-filter", titlebar)
        self.assertNotIn("--imageweave-accent", titlebar)
        window_body = css_block(".window-body")
        self.assertIn("padding: clamp(24px, 2.25vw, 32px)", window_body)
        self.assertIn("overflow: auto", window_body)

        traffic = css_block(".window-traffic-light")
        for minimum in (
            "width: 30px",
            "min-width: 30px",
            "height: 30px",
            "min-height: 30px",
        ):
            self.assertIn(minimum, traffic)
        self.assertIn("background: transparent", traffic)
        traffic_dot = css_block(".window-traffic-light > span")
        self.assertIn("width: 13px", traffic_dot)
        self.assertIn("height: 13px", traffic_dot)
        for color in ("#FF5F57", "#FEBC2E", "#28C840"):
            self.assertEqual(desktop.count(color), 1)
        disabled_traffic = css_block(
            '.window-traffic-light:is(:disabled, [aria-disabled="true"]) > span'
        )
        self.assertIn("border-color: currentColor", disabled_traffic)
        self.assertIn("background: transparent", disabled_traffic)
        disabled_symbol = css_block(
            '.window-traffic-light:is(:disabled, [aria-disabled="true"]) > span::before'
        )
        self.assertIn('content: "×"', disabled_symbol)
        self.assertIn("opacity: 1", disabled_symbol)
        self.assertIn(".window-traffic-light:focus-visible", desktop)
        self.assertIn("var(--imageweave-focus-width)", desktop)

        center_host = css_block(".application-center-host")
        self.assertRegex(center_host, r"background:\s*rgb\([^;]+/\s*0\.58\)")
        center = css_block(".application-center")
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)", center
        )
        center_item = css_block(
            ".application-center__item", body_contains="min-height: 78px"
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-weak)", center_item
        )
        self.assertIn("box-shadow: none", center_item)
        self.assertNotIn("backdrop-filter", center_item)
        center_group = css_block(
            ".application-center__group h3", body_contains="letter-spacing: 0"
        )
        self.assertIn("letter-spacing: 0", center_group)
        self.assertIn("text-transform: none", center_group)

        dock_shell = css_block(".dock__items")
        self.assertIn(
            "background: var(--imageweave-glass-surface-button)", dock_shell
        )
        dock_item = css_block(".dock__item")
        self.assertIn("transform: none", dock_item)
        self.assertNotIn("backdrop-filter", dock_item)
        self.assertNotIn("translateY(-4px)", desktop)
        self.assertNotIn("scale(1.05)", desktop)
        self.assertNotRegex(desktop, r"\.dock__item\s*[+~]")
        self.assertEqual(
            re.findall(r"scale\(([^)]+)\)", desktop),
            ["0.97", "0.97"],
        )
        focused_dock = css_block('.dock__item[data-dock-state="focused"]')
        self.assertIn("var(--imageweave-accent)", focused_dock)
        self.assertIn("inset 0 -2px 0", focused_dock)
        minimized_dock = css_block('.dock__item[data-dock-state="minimized"]')
        self.assertIn("border-color: var(--imageweave-border-default)", minimized_dock)
        for state_copy in (
            'closed: "已关闭"',
            'focused: "当前聚焦"',
            'background: "正在后台运行"',
            'minimized: "已最小化"',
        ):
            self.assertIn(state_copy, taskbar)

        # 每个顶层表面只有一处主 backdrop；标题栏、行、网格项不重复。
        supported = desktop.split("@supports ((-webkit-backdrop-filter", 1)[1]
        supported = supported.split("@supports not", 1)[0]
        self.assertIn(
            "blur(var(--imageweave-glass-blur-environment))", supported
        )
        self.assertGreaterEqual(
            supported.count("blur(var(--imageweave-glass-blur-window))"), 4
        )
        for selector in (
            ".application-window",
            ".menu-bar",
            ".menu-popover",
            ".application-center",
            ".dock__items",
            ".dock__overflow",
        ):
            self.assertIn(selector, supported)
        for selector in (
            ".window-titlebar",
            ".menu-popover__item",
            ".application-center__item",
            ".dock__item",
        ):
            self.assertNotRegex(
                supported,
                rf"(?m)^\s*{re.escape(selector)}(?![\w-])",
            )
        self.assertIn(".application-window[hidden]", desktop)
        self.assertIn(
            ".application-center-host[hidden] .application-center", desktop
        )
        self.assertIn(".dock__overflow[hidden]", desktop)
        self.assertIn("backdrop-filter: none !important", desktop)

        # canonical spring 仅在正常路径生效；直接操控、两类 motion off、
        # forced-colors 与无 backdrop 路径都有独立禁用/实色契约。
        self.assertNotRegex(desktop, r"\b(?:120|150)ms\b")
        self.assertIn("var(--imageweave-transition-standard)", desktop)
        self.assertIn(':root[data-motion="off"]', desktop)
        self.assertIn("@media (prefers-reduced-motion: reduce)", desktop)
        self.assertIn("@media (forced-colors: active)", desktop)
        self.assertIn("@media (prefers-contrast: more)", desktop)
        self.assertIn("@supports not", desktop)
        self.assertIn(
            "background: var(--imageweave-fallback-window-solid) !important",
            desktop,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid) !important",
            desktop,
        )
        forced = desktop.split("@media (forced-colors: active)", 1)[1]
        for expected in (
            "background: Canvas !important",
            "backdrop-filter: none",
            "box-shadow: none",
            "transform: none",
            "Highlight",
            "GrayText",
        ):
            self.assertIn(expected, forced)

    def test_nocturne_shared_components_visual_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        styles = webui / "styles"
        controls = (styles / "controls.css").read_text(encoding="utf-8")
        status = (styles / "status.css").read_text(encoding="utf-8")
        dialog = (styles / "dialog.css").read_text(encoding="utf-8")
        shared = "\n".join((controls, status, dialog))
        component_sources = {
            name: (webui / "js" / "components" / f"{name}.js").read_text(
                encoding="utf-8"
            )
            for name in ("status", "empty-state", "error-view", "dialog")
        }

        # T6 consumes the T4 canonical facts directly. Normal shared surfaces
        # contain neither retired *-solid aliases nor semantic-colored fills;
        # the only solid name is the canonical no-backdrop capability fallback.
        self.assertNotRegex(
            shared,
            r"--imageweave-(?!fallback)[\w-]*-solid",
        )
        self.assertNotRegex(shared, r"--imageweave-state-[\w-]*-surface")
        self.assertNotRegex(
            shared,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        self.assertNotRegex(shared, r"\b(?:100|120|150|180)ms\b")
        self.assertNotRegex(
            shared,
            r"text-transform:\s*uppercase[\s\S]{0,120}"
            r"letter-spacing:\s*0\.0[6-9]em",
        )
        self.assertNotIn("color-mix(", shared)

        # Ordinary actions use 10% neutral glass, 20% complete edge, 16px,
        # directional depth and canonical spring. Hover/active/focus are
        # distinct, while disabled controls remain fully opaque and use a
        # complete inner edge plus struck/italic non-color marker. Navigation
        # rows never move.
        for expected in (
            "background: var(--imageweave-glass-surface-button)",
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-button)",
            "border-radius: var(--imageweave-radius-control)",
            "box-shadow: var(--imageweave-shadow-control)",
            "var(--imageweave-transition-standard)",
            "background: var(--imageweave-glass-surface-hover)",
            "border-color: var(--imageweave-border-focus)",
            "transform: translateY(-2px)",
            "transform: scale(0.97)",
        ):
            self.assertIn(expected, controls)
        self.assertIn("0 10px 32px rgb(3 7 18 / 0.55)", controls)
        self.assertRegex(
            controls,
            r"\.crawl-button\.crawl-button--primary,[\s\S]*?\{"
            r"[\s\S]*?border-color:\s*var\(--imageweave-accent\);"
            r"[\s\S]*?color:\s*var\(--imageweave-accent-highlight\);"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\);",
        )
        self.assertRegex(
            controls,
            r"\.crawl-button\.crawl-button--dangerous,[\s\S]*?\{"
            r"[\s\S]*?border:\s*var\(--imageweave-border-strong-width\)"
            r" solid var\(--imageweave-state-danger\);"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\);",
        )
        self.assertIn(
            "inset 0 0 0 1px var(--imageweave-border-weak)", controls
        )
        self.assertIn("text-decoration: line-through", controls)
        self.assertIn("font-style: italic", controls)
        self.assertNotRegex(controls, r"\b(?:double|dotted|dashed)\b")
        self.assertGreaterEqual(controls.count("opacity: 1"), 5)
        self.assertNotRegex(controls, r"opacity:\s*0\.[0-9]+")
        self.assertRegex(
            controls,
            r"\.vault-button\.vault-site-nav-button:active"
            r"[\s\S]*?\{[^}]*transform:\s*none;",
        )

        # Text/search/password/number/select/textarea share 6% neutral glass,
        # 15% complete edge, directional inset, 35% focus edge and an 18%
        # champagne 3px ring. Invalid and disabled states retain neutral fills,
        # full borders, readable text and semantic/native state.
        for selector in (
            'input[type="text"]',
            'input[type="search"]',
            'input[type="password"]',
            'input[type="number"]',
            "select",
            "textarea",
        ):
            self.assertIn(selector, controls)
        for expected in (
            "background: var(--imageweave-glass-surface-input)",
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "inset 0 1px 0 rgb(255 255 255 / 0.15)",
            "inset 0 -1px 0 rgb(2 6 16 / 0.30)",
            "color: rgb(255 255 255 / 0.35)",
            "0 0 0 var(--imageweave-focus-width) "
            "var(--imageweave-focus-glow)",
            '[aria-invalid="true"]',
            "var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            "-webkit-text-fill-color: var(--imageweave-text-secondary)",
        ):
            self.assertIn(expected, controls)
        self.assertIn('input[type="checkbox"]', controls)
        self.assertIn('input[type="radio"]', controls)
        self.assertIn('input[type="range"]', controls)
        self.assertIn("progress:focus-visible", controls)
        controls_declarations = re.sub(
            r"/\*[\s\S]*?\*/", "", controls
        )
        self.assertNotIn("backdrop-filter", controls_declarations)
        self.assertIn("aria-describedby", component_sources["dialog"])
        crawl_view = (
            webui / "js" / "components" / "crawl-view.js"
        ).read_text(encoding="utf-8")
        vault_dom = (
            webui / "js" / "components" / "vault-dom.js"
        ).read_text(encoding="utf-8")
        self.assertIn('setAttribute("aria-invalid"', crawl_view)
        self.assertIn("crawl-search-validation", crawl_view)
        self.assertIn('"aria-errormessage": "vault-proxy-validation"', vault_dom)
        self.assertIn('role: "alert"', vault_dom)

        # Every status has the existing icon + text presentation and a complete
        # semantic edge over the same 5% neutral fill. Empty/error components
        # retain icon, title and readable reason without an outer nested card.
        for state_name in ("ready", "running", "warning", "error", "disabled"):
            self.assertIn(f'[data-status="{state_name}"]', status)
            self.assertIn(f"{state_name}: Object.freeze({{ icon:", component_sources["status"])
        self.assertGreaterEqual(
            status.count(
                "background: var(--imageweave-glass-surface-secondary)"
            ),
            6,
        )
        self.assertIn(".status-badge > span:first-child", status)
        self.assertIn("border: var(--imageweave-border-width) solid currentColor", status)
        for panel_marker in (
            "data-crawl-search-state",
            "data-tasks-workspace-state",
            "data-proxy-workspace-state",
            "data-vault-workspace-state",
            "data-policy-workspace-state",
            "data-diagnostics-workspace-state",
            "data-personalization-preview-state",
            "data-gallery-workspace-state",
            "data-export-workspace-state",
        ):
            self.assertIn(f"[{panel_marker}]", status)
        self.assertIn("section.empty-state", status)
        self.assertIn("section.error-view", status)
        self.assertIn("background: var(--imageweave-glass-surface-default)", status)
        self.assertNotIn("var(--imageweave-shadow-card)", status)
        status_declarations = re.sub(r"/\*[\s\S]*?\*/", "", status)
        self.assertNotIn("backdrop-filter", status_declarations)
        self.assertIn('role: status === "error" ? "alert" : "status"', component_sources["empty-state"])
        self.assertIn('attributes: { role: "alert" }', component_sources["error-view"])

        # Dialog alone owns the independent 60px/180% top-level backdrop.
        # Its panel/actions are weak inherited rows; backdrop is translucent,
        # and dangerous confirmation remains neutral with full red edges/copy.
        for expected in (
            "background-color: var(--imageweave-glass-surface-default)",
            "rgb(255 255 255 / 0.12)",
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-window)",
            "box-shadow: var(--imageweave-shadow-window)",
            "background: rgb(3 7 18 / 0.68)",
            "blur(var(--imageweave-glass-blur-window))",
            "saturate(var(--imageweave-glass-saturation))",
            "background: var(--imageweave-glass-surface-secondary)",
            'content: "警告："',
        ):
            self.assertIn(expected, dialog)
        supported = dialog.split(
            "@supports ((-webkit-backdrop-filter", 1
        )[1].split("@supports not", 1)[0]
        self.assertIn(".imageweave-dialog", supported)
        self.assertIn(".imageweave-dialog::backdrop", supported)
        self.assertNotIn(".imageweave-dialog__panel", supported)
        self.assertNotIn(".imageweave-dialog__actions", supported)
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid) !important",
            dialog,
        )
        self.assertNotIn("background: #000", dialog)

        # Existing public exports and behavior ownership remain unchanged.
        expected_exports = {
            "status": {
                "STATUS_PRESENTATION",
                "normalizeStatus",
                "resolveStatusPresentation",
                "updateStatusBadge",
                "createStatusBadge",
            },
            "empty-state": {"createEmptyState"},
            "error-view": {"toSafeErrorViewModel", "createErrorView"},
            "dialog": {"createDialogController"},
        }
        for name, source in component_sources.items():
            exports = set(re.findall(
                r"export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)",
                source,
            ))
            self.assertEqual(exports, expected_exports[name], name)
        for expected in (
            "focusableElements(dialog)",
            'event.key === "Escape"',
            'event.key !== "Tab"',
            'finish("cancel")',
            'finish("confirm")',
            "previousFocus.focus({ preventScroll: true })",
            "if (active) throw new Error",
        ):
            self.assertIn(expected, component_sources["dialog"])

        # High contrast, forced colors, motion-off and capability fallback all
        # reuse the canonical T4 system paths; normal internal rows add no blur.
        for source in (controls, status, dialog):
            self.assertIn("@media (forced-colors: active)", source)
        self.assertIn("@media (prefers-contrast: more)", controls)
        self.assertIn("@media (prefers-contrast: more)", status)
        self.assertIn("@media (prefers-contrast: more)", dialog)
        self.assertIn(':root[data-motion="off"]', status)
        self.assertIn("@media (prefers-reduced-motion: reduce)", status)
        self.assertGreaterEqual(status.count("transition: none !important"), 2)
        self.assertGreaterEqual(status.count("animation: none !important"), 2)
        self.assertIn("@supports not", dialog)
        forced = "\n".join(
            source.split("@media (forced-colors: active)", 1)[1]
            for source in (controls, status, dialog)
        )
        for expected in (
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "GrayText",
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
        ):
            self.assertIn(expected, forced)

    def test_nocturne_crawl_t71_visual_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        crawl = (
            webui / "styles" / "apps" / "crawl.css"
        ).read_text(encoding="utf-8")
        controls = (webui / "styles" / "controls.css").read_text(
            encoding="utf-8"
        )
        view = (
            webui / "js" / "components" / "crawl-view.js"
        ).read_text(encoding="utf-8")
        controller = (
            webui / "js" / "apps" / "crawl.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            match = re.search(
                rf"(?m)^\s*{re.escape(selector)}\s*\{{(?P<body>.*?)^\s*\}}",
                crawl,
                flags=re.DOTALL,
            )
            self.assertIsNotNone(match, selector)
            return match.group("body")

        # The three existing columns remain the real scroll workspace. Each is
        # one neutral 6% top-level region with a complete 15% edge and 24px
        # radius; only the parent application window owns backdrop blur.
        workspace = css_block(".crawl-workspace")
        self.assertIn("padding: 24px", workspace)
        self.assertIn("overflow-x: auto", workspace)
        self.assertIn("overflow-y: hidden", workspace)
        track = css_block(".crawl-workspace-track")
        self.assertIn("min-width: 1020px", track)
        self.assertIn("gap: 24px", track)
        self.assertIn("grid-template-columns", track)
        column = css_block(".crawl-column")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-input)",
        ):
            self.assertIn(expected, column)
        self.assertNotIn("backdrop-filter", column)
        column_scroll = css_block(".crawl-column-scroll")
        self.assertIn("padding: 24px", column_scroll)
        self.assertIn("overflow-y: auto", column_scroll)

        # Source/candidate/result/summary/fact content is flattened into 4–6%
        # inherited rows with 10% separators, 16px radii, no outer card shadow,
        # no independent backdrop and no legacy opaque alias.
        solid_refs = re.findall(r"--imageweave-[\w-]*-solid", crawl)
        self.assertEqual(
            solid_refs,
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(crawl, r"--imageweave-state-[\w-]*-surface")
        self.assertNotRegex(
            crawl,
            r"(?m)^\s*(?:-webkit-)?backdrop-filter\s*:"
            r"(?![^\n]*\bnone\b)",
        )
        self.assertNotRegex(crawl, r"(?m)^\s*filter\s*:")
        self.assertIn("background: var(--imageweave-glass-surface-weak)", crawl)
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            crawl,
        )
        self.assertIn(
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-weak)",
            crawl,
        )
        self.assertIn("border-radius: var(--imageweave-radius-control)", crawl)
        self.assertIn("box-shadow: none", crawl)
        address = css_block(".crawl-address-row")
        self.assertIn(
            "background: var(--imageweave-glass-surface-weak)", address
        )
        self.assertIn("box-shadow: none", address)
        self.assertIn("var(--imageweave-transition-standard)", address)
        selected = css_block(".crawl-address-row--selected")
        self.assertIn("border-color: var(--imageweave-border-focus)", selected)
        self.assertIn(
            "background: var(--imageweave-glass-surface-input)", selected
        )
        self.assertIn("box-shadow: none", selected)
        self.assertNotRegex(
            crawl,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        self.assertIn(
            '.crawl-source-nav-select[aria-current="page"]::before', crawl
        )
        self.assertIn('content: "◆"', crawl)

        # Running/partial/error, source warning and validation retain readable
        # text/icon markers plus complete semantic borders over neutral fills.
        search_error = css_block(
            '.crawl-search-state[data-crawl-search-state="error"]'
        )
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            search_error,
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            search_error,
        )
        validation = css_block(".crawl-validation-message")
        self.assertIn("color: var(--imageweave-text-primary)", validation)
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            validation,
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            validation,
        )
        self.assertIn(".crawl-source-warning::before", crawl)
        self.assertIn('content: "⚠"', crawl)

        # Crawl delegates all ordinary and primary actions to T6. The local
        # stylesheet cannot repaint the champagne-outline primary as a solid
        # accent button, and rows/cards never lift or scale on hover.
        self.assertNotIn(".crawl-button--primary", crawl)
        self.assertRegex(
            controls,
            r"\.crawl-button\.crawl-button--primary,[\s\S]*?\{"
            r"[\s\S]*?border-color:\s*var\(--imageweave-accent\);"
            r"[\s\S]*?color:\s*var\(--imageweave-accent-highlight\);"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\);",
        )
        address_hover = css_block(".crawl-address-row:hover")
        self.assertIn("transform: none", address_hover)
        self.assertIn(
            "background: var(--imageweave-glass-surface-input)",
            address_hover,
        )
        self.assertNotIn("text-transform: uppercase", crawl)
        self.assertNotRegex(crawl, r"letter-spacing:\s*0\.0[6-9]em")
        self.assertNotRegex(crawl, r"\b(?:100|120|150|180)ms\b")

        # Canonical capability and accessibility paths stay explicit. The sole
        # solid token is legal only in no-backdrop fallback; forced colors use
        # system colors and both motion-off paths disable row transitions.
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            crawl,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)", crawl
        )
        self.assertIn("@media (prefers-contrast: more)", crawl)
        self.assertIn("@media (forced-colors: active)", crawl)
        self.assertIn("CanvasText", crawl)
        self.assertIn("ButtonFace", crawl)
        self.assertIn(":root[data-motion=\"off\"]", crawl)
        self.assertIn("@media (prefers-reduced-motion: reduce)", crawl)
        self.assertGreaterEqual(crawl.count("transition: none !important"), 2)

        # Visual-only migration: Stage 3 API, payload, DOM semantics, labels,
        # delegated events, lifecycle and screen-reader naming remain present.
        for marker in (
            '"aria-label": "图片采集三段工作区，可横向滚动查看全部三栏"',
            'role: "combobox"',
            '"aria-current": source.key === activeSourceKey ? "page" : null',
            'setAttribute("aria-invalid"',
            '"aria-describedby": "crawl-submit-reason"',
        ):
            self.assertIn(marker, view)
        for endpoint in (
            'search: "/api/v1/search"',
            'autocomplete: "/api/v1/search/autocomplete"',
            'crawls: "/api/v1/crawls"',
        ):
            self.assertIn(endpoint, controller)
        self.assertIn("idempotencyKey: true", controller)
        self.assertIn('actions.navigateToApp("tasks")', controller)

    def test_nocturne_tasks_t72_visual_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        tasks = (
            webui / "styles" / "apps" / "tasks.css"
        ).read_text(encoding="utf-8")
        controls = (webui / "styles" / "controls.css").read_text(
            encoding="utf-8"
        )
        view = (
            webui / "js" / "components" / "tasks-view.js"
        ).read_text(encoding="utf-8")
        controller = (
            webui / "js" / "apps" / "tasks.js"
        ).read_text(encoding="utf-8")
        model = (
            webui / "js" / "core" / "tasks-model.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            marker = f"{selector} {{"
            start = tasks.find(marker)
            self.assertNotEqual(start, -1, selector)
            opening = tasks.find("{", start)
            closing = tasks.find("}", opening)
            return tasks[opening + 1 : closing]

        # The existing recent/facts/recovery workspace remains the only layout
        # owner: normal windows scroll horizontally, maximized windows fit all
        # three columns, and each column retains its own vertical scroll.
        workspace = css_block(".tasks-workspace")
        self.assertIn("padding: 24px", workspace)
        self.assertIn("overflow-x: auto", workspace)
        self.assertIn("overflow-y: hidden", workspace)
        track = css_block(".tasks-workspace-track")
        self.assertIn("min-width: 1120px", track)
        self.assertIn("gap: 24px", track)
        self.assertGreaterEqual(track.count("minmax("), 3)
        self.assertIn(
            ".application-window[data-maximized] .tasks-workspace-track",
            tasks,
        )
        self.assertIn("min-width: 100%", tasks)
        column = css_block(".tasks-column")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-input)",
            "inset 0 1px 0",
            "inset 0 -1px 0",
        ):
            self.assertIn(expected, column)
        self.assertNotIn("backdrop-filter", column)
        self.assertNotIn("var(--imageweave-shadow-", column)
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            css_block(".tasks-column--recent"),
        )
        column_scroll = css_block(".tasks-column-scroll")
        self.assertIn("padding: 24px", column_scroll)
        self.assertIn("overflow-y: auto", column_scroll)

        # Batch/source/address/table/metric structures are weak 4–6% fact rows
        # with 10% separators, 16px radii, no outer card shadow and no internal
        # compositing layer. The one legal solid token is capability fallback.
        solid_refs = re.findall(r"--imageweave-[\w-]*-solid", tasks)
        self.assertEqual(
            solid_refs,
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(tasks, r"--imageweave-state-[\w-]*-surface")
        self.assertNotRegex(
            tasks,
            r"(?m)^\s*(?:-webkit-)?backdrop-filter\s*:"
            r"(?![^\n]*\bnone\b)",
        )
        self.assertNotRegex(tasks, r"(?m)^\s*filter\s*:")
        for selector in (
            ".tasks-metric",
            ".tasks-source-card",
            ".tasks-address",
            ".tasks-table-wrap",
        ):
            body = css_block(selector)
            self.assertIn(
                "border-radius: var(--imageweave-radius-control)",
                body,
                selector,
            )
            self.assertRegex(
                body,
                r"background:\s*var\(--imageweave-glass-surface-"
                r"(?:weak|secondary)\)",
                selector,
            )
            self.assertIn("box-shadow: none", body, selector)
        self.assertIn("color: var(--imageweave-text-code)", tasks)
        self.assertIn("font-family: var(--imageweave-font-mono)", tasks)
        self.assertIn("border-bottom", tasks)
        self.assertIn("var(--imageweave-border-weak)", tasks)

        # Current/selected facts combine existing readable DOM and status icon
        # with a full 35% edge plus a shaped champagne marker; no side stripe is
        # used. Native list selection remains keyboard/AX-visible.
        current = css_block(".tasks-address--current")
        self.assertIn(
            "border-color: var(--imageweave-border-focus)", current
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-input)", current
        )
        self.assertIn("box-shadow: none", current)
        self.assertIn(".tasks-address--current::before", tasks)
        self.assertIn('content: "◆ 当前地址"', tasks)
        selected = css_block(".tasks-recent-list option:checked")
        self.assertIn("color: var(--imageweave-accent-highlight)", selected)
        self.assertIn("font-weight: 700", selected)
        self.assertNotRegex(
            tasks,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )

        # Loading/running/ready/warning/error/writing states use neutral T6
        # fills plus icon/text and complete semantic borders. Critical reasons
        # remain primary/body text rather than the 50% muted token.
        state_expectations = {
            "loading": "--imageweave-state-running",
            "writing": "--imageweave-state-running",
            "content": "--imageweave-state-success",
            "partial": "--imageweave-state-warning",
            "terminal": "--imageweave-state-warning",
            "error": "--imageweave-state-danger",
        }
        for state, token in state_expectations.items():
            selector = (
                ".tasks-workspace-state"
                f'[data-tasks-workspace-state="{state}"]'
            )
            self.assertIn(token, css_block(selector), state)
        error_state = css_block(
            '.tasks-workspace-state[data-tasks-workspace-state="error"]'
        )
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            error_state,
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            error_state,
        )
        self.assertNotIn("--imageweave-text-muted", tasks)

        # Table shell/header/rows stay horizontally scrollable and flat; normal
        # row hover never translates or scales. Tasks delegates all action
        # surfaces (including primary/danger) to the T6 shared control system.
        self.assertIn("min-width: 0", css_block(".tasks-list"))
        table_wrap = css_block(".tasks-table-wrap")
        self.assertIn("min-width: 0", table_wrap)
        self.assertIn("max-width: 100%", table_wrap)
        self.assertIn("overflow-x: auto", table_wrap)
        self.assertIn("min-width: 790px", css_block(".tasks-table"))
        table_header = css_block(".tasks-table th")
        self.assertIn("color: var(--imageweave-text-primary)", table_header)
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            table_header,
        )
        table_hover = css_block(".tasks-table tbody tr:hover")
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            table_hover,
        )
        self.assertIn("transform: none", table_hover)
        self.assertNotIn(".tasks-button--primary", tasks)
        self.assertRegex(
            controls,
            r"\.tasks-button\.tasks-button--primary,[\s\S]*?\{"
            r"[\s\S]*?border-color:\s*var\(--imageweave-accent\);"
            r"[\s\S]*?color:\s*var\(--imageweave-accent-highlight\);"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\);",
        )
        kicker = css_block(".tasks-column-kicker")
        self.assertIn("letter-spacing: normal", kicker)
        self.assertIn("text-transform: none", kicker)
        self.assertNotRegex(tasks, r"\b(?:100|120|150|180)ms\b")

        # Canonical fallback, contrast, forced-colors and both motion opt-outs
        # remain explicit; forced colors remove optical decoration.
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            tasks,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)", tasks
        )
        self.assertIn("@media (prefers-contrast: more)", tasks)
        self.assertIn("@media (forced-colors: active)", tasks)
        self.assertIn("CanvasText", tasks)
        self.assertIn("ButtonFace", tasks)
        self.assertIn("Highlight", tasks)
        self.assertIn(':root[data-motion="off"]', tasks)
        self.assertIn("@media (prefers-reduced-motion: reduce)", tasks)
        self.assertGreaterEqual(tasks.count("transition: none !important"), 2)
        self.assertNotIn("@media (max-width: 767px)", tasks)

        # This is a visual-only migration: the existing DOM semantics, endpoint,
        # model whitelist, poll cadence, exact writes, authority reads, stale gate
        # and lifecycle cancellation remain the sole production implementation.
        for marker in (
            '"aria-label": "最近批次"',
            '"aria-label": "批次管理三段工作区，可横向滚动查看最近批次、任务事实和恢复动作"',
            'tabindex: "0"',
            "当前活动地址",
            'attributes: { role: "status", "aria-live": "polite" }',
        ):
            self.assertIn(marker, view)
        for marker in (
            'crawls: "/api/v1/crawls"',
            'BATCH_POLL_KEY = "batches.active"',
            'taskBatchPath(batchId, "/cancel")',
            'taskBatchPath(batchId, "/retry")',
            'taskBatchPath(batchId, "/rerun")',
            "{ additional_attempts: 2 }",
            "Promise.all([",
            "Promise.allSettled([",
            "requestGate.beginWrite()",
            "requestGate.advanceLifecycle()",
            "operationController?.abort()",
        ):
            self.assertIn(marker, controller)
        self.assertIn("TASK_POLL_INTERVAL_MS = 1_500", model)

    def test_nocturne_proxy_t73a_visual_and_security_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        proxy = (
            webui / "styles" / "apps" / "proxy.css"
        ).read_text(encoding="utf-8")
        controls = (webui / "styles" / "controls.css").read_text(
            encoding="utf-8"
        )
        controller = (
            webui / "js" / "apps" / "proxy.js"
        ).read_text(encoding="utf-8")
        view = (
            webui / "js" / "components" / "proxy-view.js"
        ).read_text(encoding="utf-8")
        dom = (
            webui / "js" / "components" / "proxy-dom.js"
        ).read_text(encoding="utf-8")
        model = (
            webui / "js" / "core" / "proxy-model.js"
        ).read_text(encoding="utf-8")
        store_transition = (
            webui / "js" / "core" / "store-business-transition.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            marker = f"{selector} {{"
            start = proxy.find(marker)
            self.assertNotEqual(start, -1, selector)
            opening = proxy.find("{", start)
            closing = proxy.find("}", opening)
            return proxy[opening + 1 : closing]

        # The existing status/runtime/source structure remains the sole layout
        # owner: normal windows scroll horizontally, maximized windows fit the
        # three columns, and each column retains its vertical scroll ownership.
        workspace = css_block(".proxy-workspace")
        self.assertIn("padding: 24px", workspace)
        self.assertIn("overflow-x: auto", workspace)
        self.assertIn("overflow-y: hidden", workspace)
        track = css_block(".proxy-workspace-track")
        self.assertIn("min-width: 1120px", track)
        self.assertIn("gap: 24px", track)
        self.assertGreaterEqual(track.count("minmax("), 3)
        self.assertIn(
            ".application-window[data-maximized] .proxy-workspace-track",
            proxy,
        )
        self.assertIn("min-width: 100%", proxy)
        column = css_block(".proxy-column")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-input)",
            "inset 0 1px 0",
            "inset 0 -1px 0",
        ):
            self.assertIn(expected, column)
        self.assertNotIn("backdrop-filter", column)
        self.assertNotIn("var(--imageweave-shadow-", column)
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            css_block(".proxy-column--status"),
        )
        column_scroll = css_block(".proxy-column-scroll")
        self.assertIn("padding: 24px", column_scroll)
        self.assertIn("overflow-y: auto", column_scroll)

        # All normal Proxy surfaces use canonical 4%-8% neutral glass. The
        # only solid token is capability fallback; facts/rows use 16px, weak
        # separators, no outer card shadow, and no additional compositing layer.
        solid_refs = re.findall(r"--imageweave-[\w-]*-solid", proxy)
        self.assertEqual(
            solid_refs,
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(proxy, r"--imageweave-state-[\w-]*-surface")
        self.assertNotRegex(
            proxy,
            r"(?m)^\s*(?:-webkit-)?backdrop-filter\s*:"
            r"(?![^\n]*\bnone\b)",
        )
        self.assertNotRegex(proxy, r"(?m)^\s*filter\s*:")
        self.assertRegex(
            proxy,
            r"\.proxy-node-card,[\s\S]*?\.proxy-metric\s*\{"
            r"[\s\S]*?border-radius:\s*"
            r"var\(--imageweave-radius-control\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-weak\)"
            r"[\s\S]*?box-shadow:\s*none",
        )
        self.assertRegex(
            proxy,
            r"\.proxy-definition-list > div,[\s\S]*?"
            r"\.proxy-source-summary > div\s*\{"
            r"[\s\S]*?border:\s*var\(--imageweave-border-width\)"
            r" solid var\(--imageweave-border-weak\)"
            r"[\s\S]*?border-radius:\s*"
            r"var\(--imageweave-radius-control\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-weak\)"
            r"[\s\S]*?box-shadow:\s*none",
        )
        flat_section = css_block(".proxy-source-overview")
        self.assertIn("border-bottom", flat_section)
        self.assertIn("var(--imageweave-border-weak)", flat_section)
        self.assertIn("background: transparent", flat_section)
        self.assertIn("box-shadow: none", flat_section)
        self.assertRegex(
            proxy,
            r"\.proxy-metric strong[\s\S]*?color:\s*"
            r"var\(--imageweave-text-code\)"
            r"[\s\S]*?font-family:\s*"
            r"var\(--imageweave-font-mono\)",
        )

        # Running/ready/warning/error/disabled, leased nodes and source safety
        # facts combine existing icon/text with complete semantic edges over
        # neutral fills. No old one-sided stripe or tracked uppercase kicker remains.
        error_state = css_block(
            '.proxy-waiting-host[data-proxy-workspace-state="error"]'
        )
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            error_state,
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            error_state,
        )
        for state, token in (
            ("loading", "running"),
            ("writing", "running"),
            ("running", "running"),
            ("partial", "warning"),
            ("reload-required", "warning"),
            ("stopped", "warning"),
            ("disabled", "disabled"),
        ):
            self.assertRegex(
                proxy,
                rf'data-proxy-workspace-state="{state}"'
                rf"[\s\S]*?--imageweave-state-{token}",
                state,
            )
        leased = css_block('.proxy-node-card[data-leased="true"]')
        self.assertIn(
            "border-color: var(--imageweave-state-running)", leased
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)", leased
        )
        self.assertIn("box-shadow: none", leased)
        self.assertIn('content: "◆ 正在使用"', proxy)
        self.assertRegex(
            proxy,
            r"\.proxy-danger-zone\s*\{[\s\S]*?margin-top:\s*24px"
            r"[\s\S]*?border:\s*var\(--imageweave-border-strong-width\)"
            r" solid var\(--imageweave-state-danger\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-secondary\)",
        )
        validation = css_block(".proxy-field-validation")
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            validation,
        )
        self.assertIn("color: var(--imageweave-text-primary)", validation)
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            validation,
        )
        self.assertIn('content: "◆ 安全投影 · "', proxy)
        self.assertIn('content: "◆"', proxy)
        self.assertNotRegex(
            proxy,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        kicker = css_block(".proxy-column-kicker")
        self.assertIn("letter-spacing: normal", kicker)
        self.assertIn("text-transform: none", kicker)
        self.assertNotRegex(proxy, r"\b(?:100|120|150|180)ms\b")

        # Secret inputs and all actions delegate appearance to T6. Local Proxy
        # CSS adds only sizing; invalid/disabled reasons remain readable and
        # dangerous controls keep full edges and Dialog confirmation ownership.
        secret_input = css_block(".proxy-secret-input")
        for forbidden in ("background", "border", "box-shadow", "color"):
            self.assertNotIn(forbidden, secret_input)
        self.assertRegex(
            controls,
            r"\.app-view :is\([\s\S]*?input\[type=\"url\"\]"
            r"[\s\S]*?textarea[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-input\)"
            r"[\s\S]*?border:\s*var\(--imageweave-border-width\)"
            r" solid var\(--imageweave-border-default\)",
        )
        self.assertRegex(
            controls,
            r"\.proxy-button\.proxy-button--primary,[\s\S]*?"
            r"border-color:\s*var\(--imageweave-accent\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\)",
        )
        self.assertRegex(
            controls,
            r"\.proxy-button\.proxy-button--dangerous,[\s\S]*?"
            r"border:\s*var\(--imageweave-border-strong-width\)"
            r" solid var\(--imageweave-state-danger\)",
        )
        self.assertNotIn(".proxy-button--primary", proxy)
        self.assertNotIn(".proxy-button--dangerous", proxy)
        self.assertRegex(
            proxy,
            r":hover\s*\{[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-secondary\)"
            r"[\s\S]*?transform:\s*none",
        )

        # Canonical no-backdrop, contrast, forced-colors and both motion opt-outs
        # stay explicit. Forced colors remove every optical effect.
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            proxy,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)", proxy
        )
        self.assertIn("@media (prefers-contrast: more)", proxy)
        self.assertIn("@media (forced-colors: active)", proxy)
        for expected in (
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
        ):
            self.assertIn(expected, proxy)
        self.assertIn(':root[data-motion="off"]', proxy)
        self.assertIn("@media (prefers-reduced-motion: reduce)", proxy)
        self.assertGreaterEqual(proxy.count("transition: none !important"), 2)
        self.assertNotIn("@media (max-width: 767px)", proxy)

        # Visual-only production change: endpoint/payload, 10s polling,
        # status/sources concurrency, stale/write/lifecycle gates, dual authority
        # reads, immediate secret clearing, safe Store projection and fixture
        # isolation remain the existing production implementation.
        for marker in (
            'status: "/api/v1/proxy/status"',
            'start: "/api/v1/proxy/start"',
            'reload: "/api/v1/proxy/reload"',
            'probe: "/api/v1/proxy/probe"',
            'stop: "/api/v1/proxy/stop"',
            'sources: "/api/v1/proxy/sources"',
            'STATUS_POLL_KEY = "proxy.status"',
            "STATUS_POLL_INTERVAL_MS = 10_000",
            "Promise.allSettled([",
            'requestGate.beginRead("status")',
            'requestGate.beginRead("sources")',
            "requestGate.beginWrite()",
            "requestGate.advanceLifecycle()",
            "activeOperationController?.abort()",
            "abortRead(statusRead)",
            "abortRead(sourcesRead)",
            "view.clearSecretInputs()",
            "input.value = \"\"",
            "{ force_refresh: true }",
            "{ force: false }",
            "api.post(PROXY_ENDPOINTS.probe, {}, { signal })",
        ):
            self.assertIn(marker, controller)
        for marker in (
            "sanitizeProxyStatus",
            "sanitizeProxySources",
            "safeSensitiveText",
            "safeProxyErrorDetail",
            "credentials_redacted",
            "sensitive_parts_redacted",
        ):
            self.assertIn(marker, model)
        self.assertIn(
            "status: sanitizeProxyStatus(action.payload)", store_transition
        )
        self.assertIn(
            "sources: sanitizeProxySources(action.payload)", store_transition
        )
        for marker in (
            'className: "proxy-workspace"',
            'tabindex: "0"',
            'autocomplete: "off"',
            "aria-describedby",
            "proxySecret",
            'role: "status"',
            'aria-live": "polite"',
        ):
            self.assertIn(marker, dom)
        combined = "\n".join((controller, view, dom, model))
        for forbidden in (
            "fetch(",
            "globalThis.fetch",
            "XMLHttpRequest",
            "localStorage",
            "sessionStorage",
            "indexedDB",
            "console.",
            "innerHTML",
            "tests/fixtures",
            "fixtures/webui",
        ):
            self.assertNotIn(forbidden, combined)

    def test_nocturne_vault_t73b_visual_and_security_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        vault = (
            webui / "styles" / "apps" / "vault.css"
        ).read_text(encoding="utf-8")
        controls = (webui / "styles" / "controls.css").read_text(
            encoding="utf-8"
        )
        controller = (
            webui / "js" / "apps" / "vault.js"
        ).read_text(encoding="utf-8")
        view = (
            webui / "js" / "components" / "vault-view.js"
        ).read_text(encoding="utf-8")
        dom = (
            webui / "js" / "components" / "vault-dom.js"
        ).read_text(encoding="utf-8")
        model = (
            webui / "js" / "core" / "vault-model.js"
        ).read_text(encoding="utf-8")
        store_state = (
            webui / "js" / "core" / "store-state.js"
        ).read_text(encoding="utf-8")
        store_transition = (
            webui / "js" / "core" / "store-business-transition.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            marker = f"{selector} {{"
            start = vault.find(marker)
            self.assertNotEqual(start, -1, selector)
            opening = vault.find("{", start)
            closing = vault.find("}", opening)
            return vault[opening + 1 : closing]

        # Existing navigation/material/recovery structure remains the layout
        # owner: normal windows scroll horizontally, maximized windows fit the
        # three columns, and each column owns its vertical scrolling.
        workspace = css_block(".vault-workspace")
        self.assertIn("padding: 24px", workspace)
        self.assertIn("overflow-x: auto", workspace)
        self.assertIn("overflow-y: hidden", workspace)
        track = css_block(".vault-workspace-track")
        self.assertIn("min-width: 1120px", track)
        self.assertIn("gap: 24px", track)
        self.assertGreaterEqual(track.count("minmax("), 3)
        self.assertIn(
            ".application-window[data-maximized] .vault-workspace-track",
            vault,
        )
        self.assertIn("min-width: 100%", vault)
        column = css_block(".vault-column")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-input)",
            "inset 0 1px 0",
            "inset 0 -1px 0",
        ):
            self.assertIn(expected, column)
        self.assertNotIn("backdrop-filter", column)
        self.assertNotIn("var(--imageweave-shadow-", column)
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            css_block(".vault-column--navigation"),
        )
        column_scroll = css_block(".vault-column-scroll")
        self.assertIn("padding: 24px", column_scroll)
        self.assertIn("overflow-y: auto", column_scroll)

        # Normal surfaces are canonical 4%-8% neutral glass. Only the
        # no-backdrop capability path may use a solid token. Rows/forms/facts
        # use complete weak edges, 16px radii and no outer shadow/compositor.
        solid_refs = re.findall(r"--imageweave-[\w-]*-solid", vault)
        self.assertEqual(
            solid_refs,
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(vault, r"--imageweave-state-[\w-]*-surface")
        self.assertNotRegex(
            vault,
            r"(?m)^\s*(?:-webkit-)?backdrop-filter\s*:"
            r"(?![^\n]*\bnone\b)",
        )
        self.assertNotRegex(vault, r"(?m)^\s*filter\s*:")
        self.assertRegex(
            vault,
            r"\.vault-waiting-host,[\s\S]*?"
            r"\.vault-definition-list > div\s*\{"
            r"[\s\S]*?border:\s*var\(--imageweave-border-width\)"
            r" solid var\(--imageweave-border-weak\)"
            r"[\s\S]*?border-radius:\s*"
            r"var\(--imageweave-radius-control\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-weak\)"
            r"[\s\S]*?box-shadow:\s*none",
        )
        flat_panel = css_block(".vault-app .vault-panel")
        self.assertIn("border-bottom", flat_panel)
        self.assertIn("var(--imageweave-border-weak)", flat_panel)
        self.assertIn("background: transparent", flat_panel)
        self.assertIn("background-image: none", flat_panel)
        self.assertIn("box-shadow: none", flat_panel)
        self.assertRegex(
            vault,
            r"\.vault-definition-list dd[\s\S]*?color:\s*"
            r"var\(--imageweave-text-code\)"
            r"[\s\S]*?font-family:\s*"
            r"var\(--imageweave-font-mono\)",
        )
        self.assertRegex(
            vault,
            r"\.vault-profile-status \.empty-state,[\s\S]*?"
            r"background:\s*transparent[\s\S]*?box-shadow:\s*none",
        )

        # Pending/ready/error/expired/material/proxy presentations retain the
        # existing icon and readable text, complete semantic edges and neutral
        # fills. No single-sided stripe or tracked uppercase kicker remains.
        error_state = css_block(
            '.vault-waiting-host[data-vault-workspace-state="error"]'
        )
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            error_state,
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            error_state,
        )
        for state, token in (
            ("loading", "running"),
            ("authorizing", "running"),
            ("writing", "running"),
            ("ready", "success"),
            ("authorized", "success"),
            ("partial", "warning"),
            ("required", "warning"),
            ("error", "danger"),
        ):
            self.assertRegex(
                vault,
                rf'data-vault-workspace-state="{state}"'
                rf"[\s\S]*?--imageweave-state-{token}",
                state,
            )
        for state, token in (
            ("ready", "success"),
            ("running", "running"),
            ("warning", "warning"),
            ("error", "danger"),
            ("disabled", "disabled"),
        ):
            self.assertRegex(
                vault,
                rf'data-site-state="{state}"'
                rf"[\s\S]*?--imageweave-state-{token}",
                state,
            )
        for marker in (
            'content: "◆"',
            'content: "⚠ 影响 · "',
            'content: "◆ 状态说明 · "',
            'content: "⚠ 输入无效 · "',
            'content: "⚠ "',
        ):
            self.assertIn(marker, vault)
        validation = css_block(".vault-field-error:not(:empty)")
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            validation,
        )
        self.assertIn("color: var(--imageweave-text-primary)", validation)
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            validation,
        )
        self.assertRegex(
            vault,
            r"\.vault-danger-zone\s*\{[\s\S]*?"
            r"border:\s*var\(--imageweave-border-strong-width\)"
            r" solid var\(--imageweave-state-danger\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-secondary\)",
        )
        self.assertNotRegex(
            vault,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        kicker = css_block(".vault-column-kicker")
        self.assertIn("letter-spacing: normal", kicker)
        self.assertIn("text-transform: none", kicker)
        self.assertNotRegex(vault, r"\b(?:100|120|150|180)ms\b")

        # Sensitive authorization proxy input delegates its complete visual
        # state to T6. Invalid/disabled help and dangerous actions retain high
        # contrast, full edges and the existing Dialog confirmation owner.
        secret_input = css_block(".vault-secret-input")
        for forbidden in ("background", "border", "box-shadow", "color"):
            self.assertNotIn(forbidden, secret_input)
        self.assertRegex(
            controls,
            r"\.app-view :is\([\s\S]*?input\[type=\"text\"\]"
            r"[\s\S]*?textarea[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-input\)"
            r"[\s\S]*?border:\s*var\(--imageweave-border-width\)"
            r" solid var\(--imageweave-border-default\)",
        )
        self.assertRegex(
            controls,
            r"\.vault-button\.vault-button--primary,[\s\S]*?"
            r"border-color:\s*var\(--imageweave-accent\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\)",
        )
        self.assertRegex(
            controls,
            r"\.vault-button\.vault-button--dangerous,[\s\S]*?"
            r"border:\s*var\(--imageweave-border-strong-width\)"
            r" solid var\(--imageweave-state-danger\)",
        )
        self.assertNotIn(".vault-button--primary", vault)
        self.assertNotIn(".vault-button--dangerous", vault)
        self.assertRegex(
            vault,
            r"\.vault-site-nav-button:hover[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-secondary\)"
            r"[\s\S]*?transform:\s*none",
        )
        self.assertRegex(
            vault,
            r"\.vault-site-card:hover,[\s\S]*?transform:\s*none",
        )

        # Canonical no-backdrop, contrast, forced-colors and both motion
        # opt-outs remain explicit. Forced colors remove all optical effects.
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            vault,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)",
            vault,
        )
        self.assertIn("@media (prefers-contrast: more)", vault)
        self.assertIn("@media (forced-colors: active)", vault)
        for expected in (
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
        ):
            self.assertIn(expected, vault)
        self.assertIn(':root[data-motion="off"]', vault)
        self.assertIn("@media (prefers-reduced-motion: reduce)", vault)
        self.assertGreaterEqual(vault.count("transition: none !important"), 2)
        self.assertNotRegex(vault, r"@media\s*\(max-width\s*:")

        # Visual-only production change: endpoint/query/payload ownership, the
        # 800ms authorization session cadence, opaque runtime-only reference,
        # full+site authority reads, request generations, immediate secret
        # clearing, Dialog and lifecycle abort boundaries remain unchanged.
        for marker in (
            'status: "/api/v1/auth"',
            'proxy: "/api/v1/auth/proxy"',
            'browserProfile: "/api/v1/auth/browser-profile"',
            'pixivOAuthStart: "/api/v1/auth/pixiv/oauth/start"',
            'pixivOAuthSession: "/api/v1/auth/pixiv/oauth/session"',
            'AUTHORIZATION_POLL_KEY = "vault.authorization"',
            "AUTHORIZATION_POLL_INTERVAL_MS = 800",
            "alwaysFocusRate: true",
            "immediate: false",
            "resume: \"immediate\"",
            'requestGate.beginRead("status")',
            'requestGate.beginRead("site")',
            'requestGate.beginRead("session")',
            "requestGate.beginWrite()",
            "requestGate.advanceLifecycle()",
            "activeOperationController?.abort()",
            "abortRead(statusRead)",
            "abortRead(siteRead)",
            "abortRead(sessionRead)",
            "stopAuthorizationPolling()",
            "Promise.allSettled([",
            "readStatus(null, { replace: true, report: false })",
            "readSite(reference.site, null, { report: false })",
            "view.clearSensitiveInputs()",
            'input.value = ""',
            "capturedPayload = null",
            "dialogs.destroy()",
        ):
            self.assertIn(marker, controller)
        for marker in (
            "SESSION_ID_PATTERN = /^[0-9a-f]{32}$/",
            "extractVaultSessionReference",
            "sanitizeVaultStatus",
            "sanitizeVaultSiteStatus",
            "validateVaultSnapshot",
            "secrets_exposed !== false",
            "credentialsRedacted",
            "displayEndpoint",
            "SESSION_VIEW_KEYS",
            "PROXY_VIEW_KEYS",
        ):
            self.assertIn(marker, model)
        self.assertIn(
            "action(ACTION_TYPES.AUTH_STATUS_RECEIVED, sanitizeVaultStatus(status))",
            store_state,
        )
        self.assertIn(
            "action(ACTION_TYPES.AUTH_SITE_STATUS_RECEIVED, "
            "sanitizeVaultSiteStatus(status))",
            store_state,
        )
        self.assertIn(
            "const snapshot = validateVaultSnapshot(action.payload)",
            store_transition,
        )
        self.assertIn(
            "const site = validateVaultSiteViewModel(action.payload)",
            store_transition,
        )
        for marker in (
            'className: "vault-workspace"',
            'tabindex: "0"',
            'autocomplete: "off"',
            "vaultSecret",
            '"aria-errormessage": "vault-proxy-validation"',
            'role: "alert"',
            'role: "status"',
            '"aria-live": "polite"',
            '"aria-live": "assertive"',
        ):
            self.assertIn(marker, dom)
        self.assertIn("vaultFocusToken", view)
        self.assertIn("restoreVaultFocus", view)
        self.assertIn("deriveVaultWorkspacePresentation", view)
        self.assertRegex(
            view + dom,
            r"(?s)^(?!.*(?:sessionId|session_id|authorization_url)).*$",
        )
        combined = "\n".join((controller, view, dom, model))
        for forbidden in (
            "fetch(",
            "globalThis.fetch",
            "XMLHttpRequest",
            "localStorage",
            "sessionStorage",
            "indexedDB",
            "console.",
            "innerHTML",
            "tests/fixtures",
            "fixtures/webui",
        ):
            self.assertNotIn(forbidden, combined)

    def test_nocturne_policy_t74a_visual_and_security_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        policy = (
            webui / "styles" / "apps" / "policy.css"
        ).read_text(encoding="utf-8")
        controls = (webui / "styles" / "controls.css").read_text(
            encoding="utf-8"
        )
        controller = (
            webui / "js" / "apps" / "policy.js"
        ).read_text(encoding="utf-8")
        view = (
            webui / "js" / "components" / "policy-view.js"
        ).read_text(encoding="utf-8")
        dom = (
            webui / "js" / "components" / "policy-dom.js"
        ).read_text(encoding="utf-8")
        model = (
            webui / "js" / "core" / "policy-model.js"
        ).read_text(encoding="utf-8")
        store_state = (
            webui / "js" / "core" / "store-state.js"
        ).read_text(encoding="utf-8")
        store_transition = (
            webui / "js" / "core" / "store-business-transition.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            marker = f"{selector} {{"
            start = policy.find(marker)
            self.assertNotEqual(start, -1, selector)
            opening = policy.find("{", start)
            closing = policy.find("}", opening)
            return policy[opening + 1 : closing]

        # The existing long-form navigation/editor/action workspace remains the
        # sole layout owner. Normal windows scroll horizontally, maximized
        # windows fit all three columns, and each column owns vertical scroll.
        workspace = css_block(".policy-workspace")
        self.assertIn("padding: 24px", workspace)
        self.assertIn("overflow-x: auto", workspace)
        self.assertIn("overflow-y: hidden", workspace)
        track = css_block(".policy-workspace-track")
        self.assertIn("min-width: 1120px", track)
        self.assertIn("gap: 24px", track)
        self.assertGreaterEqual(track.count("minmax("), 3)
        self.assertIn(
            ".application-window[data-maximized] .policy-workspace-track",
            policy,
        )
        self.assertIn("min-width: 100%", policy)
        column = css_block(".policy-column")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-input)",
            "inset 0 1px 0",
            "inset 0 -1px 0",
        ):
            self.assertIn(expected, column)
        self.assertNotIn("backdrop-filter", column)
        self.assertNotIn("var(--imageweave-shadow-", column)
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            css_block(".policy-column--navigation"),
        )
        column_scroll = css_block(".policy-column-scroll")
        self.assertIn("padding: 24px", column_scroll)
        self.assertIn("overflow-y: auto", column_scroll)

        # Normal Policy surfaces are canonical 4%-8% neutral glass. Only the
        # capability fallback may use a solid token. Form/panel wrappers are
        # flattened while fields, facts and help rows use 16px weak surfaces.
        solid_refs = re.findall(r"--imageweave-[\w-]*-solid", policy)
        self.assertEqual(
            solid_refs,
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(policy, r"--imageweave-state-[\w-]*-surface")
        self.assertIsNone(
            re.search(
                r"^\s*(?:-webkit-)?backdrop-filter\s*:"
                r"(?![^\n]*\bnone\b)",
                policy,
                flags=re.MULTILINE,
            )
        )
        self.assertNotRegex(policy, r"(?m)^\s*filter\s*:")
        self.assertRegex(
            policy,
            r"\.policy-waiting-host,[\s\S]*?"
            r"\.policy-action-reason\s*\{[\s\S]*?"
            r"border:\s*var\(--imageweave-border-width\) solid "
            r"var\(--imageweave-border-weak\)[\s\S]*?"
            r"border-radius:\s*var\(--imageweave-radius-control\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-weak\)"
            r"[\s\S]*?box-shadow:\s*none",
        )
        form = css_block(".policy-form")
        for expected in (
            "border: 0",
            "background: transparent",
            "box-shadow: none",
        ):
            self.assertIn(expected, form)
        panel = css_block(".policy-app .policy-panel")
        self.assertIn("border-bottom", panel)
        self.assertIn("var(--imageweave-border-weak)", panel)
        self.assertIn("background: transparent", panel)
        self.assertIn("background-image: none", panel)
        self.assertIn("box-shadow: none", panel)
        source_summary = css_block(".policy-app .policy-source-summary")
        self.assertIn(
            "border-radius: var(--imageweave-radius-control)",
            source_summary,
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-weak)",
            source_summary,
        )
        self.assertRegex(
            policy,
            r"\.policy-source-title\s*\{[\s\S]*?color:\s*"
            r"var\(--imageweave-text-code\)[\s\S]*?font-family:\s*"
            r"var\(--imageweave-font-mono\)",
        )

        # Loading/saving/success/inherited/dirty/warning/invalid/readonly/error
        # retain status badge text/icons and complete semantic edges over neutral
        # fills. Current and dirty states also have shaped textual markers.
        for state, token in (
            ("loading", "running"),
            ("saving", "running"),
            ("ready", "success"),
            ("saved", "success"),
            ("dirty", "warning"),
            ("partial", "warning"),
            ("invalid", "danger"),
            ("readonly", "danger"),
            ("error", "danger"),
        ):
            self.assertRegex(
                policy,
                rf'data-policy-workspace-state="{state}"'
                rf"[\s\S]*?--imageweave-state-{token}",
                state,
            )
        invalid = css_block(
            '.policy-waiting-host[data-policy-workspace-state="invalid"],\n'
            '.policy-waiting-host[data-policy-workspace-state="readonly"],\n'
            '.policy-waiting-host[data-policy-workspace-state="error"]'
        )
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            invalid,
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-default)",
            invalid,
        )
        validation = css_block(".policy-validation")
        self.assertIn("color: var(--imageweave-text-primary)", validation)
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            validation,
        )
        for marker in (
            'content: "◆ 当前站点"',
            'content: "◆ 来源 · "',
            'content: "◆ 状态 · "',
            'content: "△ 未保存 · "',
            'content: "⚠ 输入无效 · "',
            'content: "⚠ 恢复说明 · "',
        ):
            self.assertIn(marker, policy)
        self.assertNotRegex(
            policy,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        kicker = css_block(".policy-column-kicker")
        self.assertIn("letter-spacing: normal", kicker)
        self.assertIn("text-transform: none", kicker)
        self.assertNotRegex(policy, r"\b(?:100|120|150|180)ms\b")

        # Number/select and save/reset retain only local sizing and delegate all
        # visual states to T6 shared controls. Navigation rows explicitly do not
        # lift or scale on hover/active.
        local_inputs = css_block(
            '.policy-field input[type="number"],\n.policy-field select'
        )
        for forbidden in ("background", "border", "box-shadow", "color"):
            self.assertNotRegex(local_inputs, rf"(?:^|\s){forbidden}\s*:")
        self.assertNotRegex(policy, r"\.policy-button--(?:primary|dangerous)")
        self.assertRegex(
            controls,
            r"\.policy-button\.policy-button--primary,[\s\S]*?"
            r"border-color:\s*var\(--imageweave-accent\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\)",
        )
        self.assertRegex(
            controls,
            r"\.policy-button\.policy-button--dangerous,[\s\S]*?"
            r"border:\s*var\(--imageweave-border-strong-width\) solid "
            r"var\(--imageweave-state-danger\)",
        )
        source_hover = css_block(
            '.policy-app .policy-source-option:hover:not(:disabled):not('
            '[aria-disabled="true"]):not([aria-busy="true"]),\n'
            '.policy-app .policy-source-option:active:not(:disabled):not('
            '[aria-disabled="true"]):not([aria-busy="true"])'
        )
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            source_hover,
        )
        self.assertIn("transform: none", source_hover)

        # Canonical no-backdrop, contrast, forced colors and both motion
        # opt-outs stay explicit. Forced colors remove optical decoration.
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            policy,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)",
            policy,
        )
        self.assertIn("@media (prefers-contrast: more)", policy)
        self.assertIn("@media (forced-colors: active)", policy)
        for expected in (
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
        ):
            self.assertIn(expected, policy)
        self.assertIn(':root[data-motion="off"]', policy)
        self.assertIn("@media (prefers-reduced-motion: reduce)", policy)
        self.assertGreaterEqual(policy.count("transition: none !important"), 2)
        self.assertNotRegex(policy, r"@media\s*\(max-width\s*:")

        # Visual-only production change: the exact endpoint/query, four-field
        # payload, mutation->authority GET, draft preservation, shared discard
        # promise, stale gate, safe projection and lifecycle aborts stay owned by
        # the existing controller/model/Store implementation.
        for marker in (
            'policies: "/api/v1/sites/policies"',
            'POLICY_VIEW_QUERY = "view=policy"',
            "requestGate.beginRead()",
            "requestGate.beginWrite()",
            "requestGate.advanceLifecycle()",
            "readConfig(null, { replace: true, report: false })",
            "preservedDraft",
            "view.restoreDraft(preservedDraft)",
            "capturedPayload = null",
            "discardRequest",
            "beforeLeave()",
            "beforeWindowHide(visibility)",
            'globalThis.addEventListener?.("beforeunload"',
            "activeOperationController?.abort()",
            "abortRead()",
            "dialogs.destroy()",
            "view.clearDraft()",
        ):
            self.assertIn(marker, controller)
        self.assertNotIn("polling.start", controller)
        for marker in (
            '"max_concurrency"',
            '"retry_limit"',
            '"backoff_base_seconds"',
            '"proxy_mode"',
            "buildPolicyPayload",
            "sanitizePolicyResponse",
            "validatePolicySnapshot",
            "safePolicyErrorDetail",
            "SAFE_DETAIL_FIELDS",
            "DANGEROUS_KEYS",
            "createPolicyRequestGate",
        ):
            self.assertIn(marker, model)
        self.assertIn(
            "action(ACTION_TYPES.POLICY_CONFIG_RECEIVED, "
            "sanitizePolicyResponse(config))",
            store_state,
        )
        self.assertIn(
            "policy: { config: validatePolicySnapshot(action.payload) }",
            store_transition,
        )
        for marker in (
            'attributes: { "aria-label": "五个站点的设置状态" }',
            'className: "policy-workspace"',
            'tabindex: "0"',
            'autocomplete: "off"',
            '"aria-describedby"',
            '"aria-errormessage"',
            'role: "alert"',
            'role: "status"',
            '"aria-live": "polite"',
            '"aria-live": "assertive"',
        ):
            self.assertIn(marker, dom)
        self.assertIn("policyFocusToken", view)
        self.assertIn("restorePolicyFocus", view)
        self.assertIn("setCustomValidity", view)
        combined = "\n".join((controller, view, dom, model))
        for forbidden in (
            "fetch(",
            "globalThis.fetch",
            "XMLHttpRequest",
            "localStorage",
            "sessionStorage",
            "indexedDB",
            "console.",
            "innerHTML",
            "tests/fixtures",
            "fixtures/webui",
        ):
            self.assertNotIn(forbidden, combined)

    def test_nocturne_diagnostics_t74b_visual_and_security_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        diagnostics = (
            webui / "styles" / "apps" / "diagnostics.css"
        ).read_text(encoding="utf-8")
        controls = (webui / "styles" / "controls.css").read_text(
            encoding="utf-8"
        )
        status_css = (webui / "styles" / "status.css").read_text(
            encoding="utf-8"
        )
        controller = (
            webui / "js" / "apps" / "diagnostics.js"
        ).read_text(encoding="utf-8")
        view = (
            webui / "js" / "components" / "diagnostics-view.js"
        ).read_text(encoding="utf-8")
        status_view = (
            webui / "js" / "components" / "status.js"
        ).read_text(encoding="utf-8")
        model = (
            webui / "js" / "core" / "diagnostics-model.js"
        ).read_text(encoding="utf-8")
        store_state = (
            webui / "js" / "core" / "store-state.js"
        ).read_text(encoding="utf-8")
        store_transition = (
            webui / "js" / "core" / "store-business-transition.js"
        ).read_text(encoding="utf-8")

        def css_block(selector: str) -> str:
            marker = f"{selector} {{"
            start = diagnostics.find(marker)
            self.assertNotEqual(start, -1, selector)
            opening = diagnostics.find("{", start)
            closing = diagnostics.find("}", opening)
            return diagnostics[opening + 1 : closing]

        # The existing summary/facts/recovery DOM remains the only layout
        # owner. A normal window scrolls horizontally, a maximized window fits
        # all three columns, and each column retains independent vertical scroll.
        workspace = css_block(".diagnostics-workspace")
        self.assertIn("padding: 24px", workspace)
        self.assertIn("overflow-x: auto", workspace)
        self.assertIn("overflow-y: hidden", workspace)
        track = css_block(".diagnostics-workspace-track")
        self.assertIn("min-width: 1120px", track)
        self.assertIn("gap: 24px", track)
        self.assertGreaterEqual(track.count("minmax("), 3)
        self.assertIn(
            ".application-window[data-maximized] "
            ".diagnostics-workspace-track",
            diagnostics,
        )
        self.assertIn("min-width: 100%", diagnostics)
        column = css_block(".diagnostics-column")
        for expected in (
            "border: var(--imageweave-border-width) solid "
            "var(--imageweave-border-default)",
            "border-radius: var(--imageweave-radius-card)",
            "background: var(--imageweave-glass-surface-input)",
            "inset 0 1px 0",
            "inset 0 -1px 0",
        ):
            self.assertIn(expected, column)
        self.assertNotIn("backdrop-filter", column)
        self.assertNotIn("var(--imageweave-shadow-", column)
        self.assertIn(
            "background: var(--imageweave-glass-surface-secondary)",
            css_block(".diagnostics-column--summary"),
        )
        column_scroll = css_block(".diagnostics-column-scroll")
        self.assertIn("padding: 24px", column_scroll)
        self.assertIn("overflow-y: auto", column_scroll)

        # Normal Diagnostics surfaces are canonical 4%-8% neutral glass. Only
        # the capability fallback may use a solid token. Fact/status/help rows
        # are 16px weak rows without an outer shadow or their own backdrop;
        # panel/domain wrappers are transparent separators, not nested cards.
        solid_refs = re.findall(r"--imageweave-[\w-]*-solid", diagnostics)
        self.assertEqual(
            solid_refs,
            ["--imageweave-fallback-elevated-solid"],
        )
        self.assertNotRegex(
            diagnostics,
            r"--imageweave-state-[\w-]*-surface",
        )
        self.assertIsNone(
            re.search(
                r"^\s*(?:-webkit-)?backdrop-filter\s*:"
                r"(?![^\n]*\bnone\b)",
                diagnostics,
                flags=re.MULTILINE,
            )
        )
        self.assertNotRegex(diagnostics, r"(?m)^\s*filter\s*:")
        self.assertRegex(
            diagnostics,
            r"\.diagnostics-app \.diagnostics-workspace-state,"
            r"[\s\S]*?\.diagnostics-next-step\s*\{[\s\S]*?"
            r"border:\s*var\(--imageweave-border-width\) solid "
            r"var\(--imageweave-border-weak\)[\s\S]*?"
            r"border-radius:\s*var\(--imageweave-radius-control\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-weak\)"
            r"[\s\S]*?box-shadow:\s*none"
            r"[\s\S]*?transform:\s*none",
        )
        panel = css_block(
            ".diagnostics-app .diagnostics-panel,\n.diagnostics-domain"
        )
        for expected in (
            "border-bottom",
            "var(--imageweave-border-weak)",
            "background: transparent",
            "background-image: none",
            "box-shadow: none",
        ):
            self.assertIn(expected, panel)
        workspace_state = css_block(
            ".diagnostics-app .diagnostics-workspace-state"
        )
        self.assertIn(
            "grid-template-columns: minmax(0, 1fr)",
            workspace_state,
        )
        self.assertIn("justify-items: start", workspace_state)
        fact_row = css_block(".diagnostics-definitions > div")
        self.assertGreaterEqual(fact_row.count("minmax("), 2)
        self.assertIn("padding: 12px 16px", fact_row)
        for selector in (
            ".diagnostics-metric strong",
            ".diagnostics-definitions dd",
        ):
            block = css_block(selector)
            self.assertIn("color: var(--imageweave-text-code)", block)
            self.assertIn("font-family: var(--imageweave-font-mono)", block)
        self.assertRegex(
            diagnostics,
            r"\.diagnostics-column-header > p:last-child,[\s\S]*?"
            r"\.diagnostics-app section\.empty-state p\s*\{"
            r"[\s\S]*?color:\s*var\(--imageweave-text-secondary\)",
        )
        self.assertIn(
            "color: var(--imageweave-text-primary)",
            css_block(".diagnostics-warning p"),
        )

        # Every workspace/component state keeps badge icon + text and gains a
        # complete semantic edge over a neutral fill. Stale and next-step rows
        # use shaped textual markers; no 3px/4px one-sided decoration remains.
        for state, token in (
            ("loading", "running"),
            ("refreshing", "running"),
            ("content", "success"),
            ("partial", "warning"),
            ("stale", "warning"),
            ("offline", "danger"),
            ("error", "danger"),
        ):
            self.assertRegex(
                diagnostics,
                rf'data-diagnostics-workspace-state="{state}"'
                rf"[\s\S]*?--imageweave-state-{token}",
                state,
            )
        for status, token in (
            ("ready", "success"),
            ("running", "running"),
            ("warning", "warning"),
            ("error", "danger"),
            ("disabled", "disabled"),
        ):
            self.assertRegex(
                diagnostics,
                rf"diagnostics-component:has\(\.status-badge"
                rf'\[data-status="{status}"\]\)[\s\S]*?'
                rf"--imageweave-state-{token}",
                status,
            )
        offline = css_block(
            '.diagnostics-workspace-state['
            'data-diagnostics-workspace-state="offline"],\n'
            '.diagnostics-workspace-state['
            'data-diagnostics-workspace-state="error"]'
        )
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-danger)",
            offline,
        )
        stale = css_block(".diagnostics-stale-marker")
        self.assertIn(
            "border: var(--imageweave-border-strong-width) solid "
            "var(--imageweave-state-warning)",
            stale,
        )
        for marker in (
            'content: "◆ 状态 · "',
            'content: "△ 陈旧 · "',
            'content: "→ "',
        ):
            self.assertIn(marker, diagnostics)
        self.assertNotRegex(
            diagnostics,
            r"(?:border-(?:left|right):\s*[34]px|"
            r"inset\s+[34]px\s+0(?:px)?\s+0)",
        )
        kicker = css_block(".diagnostics-column-kicker")
        self.assertIn("letter-spacing: normal", kicker)
        self.assertIn("text-transform: none", kicker)
        self.assertNotRegex(diagnostics, r"\b(?:100|120|150|180)ms\b")
        self.assertIn("var(--imageweave-transition-standard)", diagnostics)
        self.assertRegex(
            diagnostics,
            r"\.diagnostics-app :is\([\s\S]*?\):hover\s*\{"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-secondary\)"
            r"[\s\S]*?box-shadow:\s*none"
            r"[\s\S]*?transform:\s*none",
        )
        for marker in (
            'ready: Object.freeze({ icon: "✓"',
            'running: Object.freeze({ icon: "▶"',
            'warning: Object.freeze({ icon: "△"',
            'error: Object.freeze({ icon: "!"',
            'disabled: Object.freeze({ icon: "—"',
            'attributes: { "aria-hidden": "true" }',
            'element.setAttribute("aria-label", presentation.label)',
        ):
            self.assertIn(marker, status_view)
        self.assertRegex(
            status_css,
            r"\.status-badge > span:first-child\s*\{[\s\S]*?"
            r"border:\s*var\(--imageweave-border-width\) solid "
            r"currentColor",
        )
        self.assertRegex(
            controls,
            r"\.diagnostics-button\.diagnostics-button--primary,"
            r"[\s\S]*?border-color:\s*var\(--imageweave-accent\)"
            r"[\s\S]*?background:\s*"
            r"var\(--imageweave-glass-surface-button\)",
        )

        # Capability/high-contrast/forced-color and both motion opt-outs remain
        # explicit. Forced colors remove gradients, shadows and backdrop.
        self.assertIn(
            "@supports not ((-webkit-backdrop-filter: blur(1px)) or "
            "(backdrop-filter: blur(1px)))",
            diagnostics,
        )
        self.assertIn(
            "background: var(--imageweave-fallback-elevated-solid)",
            diagnostics,
        )
        self.assertIn("@media (prefers-contrast: more)", diagnostics)
        self.assertIn("@media (forced-colors: active)", diagnostics)
        for expected in (
            "CanvasText",
            "ButtonFace",
            "Highlight",
            "background-image: none",
            "box-shadow: none",
            "backdrop-filter: none",
        ):
            self.assertIn(expected, diagnostics)
        self.assertIn(':root[data-motion="off"]', diagnostics)
        self.assertIn("@media (prefers-reduced-motion: reduce)", diagnostics)
        self.assertGreaterEqual(
            diagnostics.count("transition: none !important"),
            3,
        )
        self.assertNotRegex(diagnostics, r"@media\s*\(max-width\s*:")

        # Visual-only production change: endpoints/query, 20-second active-only
        # polling, four-read authority cycle, stale/lifecycle gates, aborts and
        # the strict safe model/Store projection remain owned by existing JS.
        endpoints = (
            'health: "/healthz"',
            'readiness: "/readyz"',
            'config: "/api/v1/config?view=diagnostics"',
            'scheduler: "/api/v1/scheduler/status?view=diagnostics"',
        )
        for endpoint in endpoints:
            self.assertEqual(controller.count(endpoint), 1, endpoint)
        for marker in (
            'DIAGNOSTICS_POLL_KEY = "diagnostics.snapshot"',
            "Promise.all([",
            "readOutcome(api, DIAGNOSTICS_ENDPOINTS.health",
            "readOutcome(api, DIAGNOSTICS_ENDPOINTS.readiness",
            "readOutcome(api, DIAGNOSTICS_ENDPOINTS.config",
            "readOutcome(api, DIAGNOSTICS_ENDPOINTS.scheduler",
            "requestGate.beginCycle()",
            "requestGate.isCycleCurrent(ticket)",
            "requestGate.advanceLifecycle()",
            "intervalMs: DIAGNOSTICS_POLL_INTERVAL_MS",
            "immediate: true",
            'resume: "immediate"',
            "polling.stop(DIAGNOSTICS_POLL_KEY)",
            "cycleController?.abort()",
            "activeCyclePromise = null",
            "safeErrorResponse(error)",
        ):
            self.assertIn(marker, controller)
        self.assertIn(
            "export const DIAGNOSTICS_POLL_INTERVAL_MS = 20_000",
            model,
        )
        for marker in (
            "COMPONENTS = Object.freeze([",
            "SECTION_NAMES = Object.freeze([",
            "SAFE_ERROR_CODE",
            "sanitizeHealthDiagnostics",
            "sanitizeReadinessDiagnostics",
            "sanitizeDiagnosticsConfig",
            "sanitizeDiagnosticsScheduler",
            "buildDiagnosticsSnapshot",
            "validateDiagnosticsSnapshot",
            "createDiagnosticsRequestGate",
            "diagnosticsCopyText",
            "staleSections",
            "safeOutcomeError",
        ):
            self.assertIn(marker, model)
        self.assertIn(
            "return action(ACTION_TYPES.DIAGNOSTICS_RECEIVED, "
            "validateDiagnosticsSnapshot(snapshot))",
            store_state,
        )
        self.assertIn(
            "diagnostics: { snapshot: "
            "validateDiagnosticsSnapshot(action.payload) }",
            store_transition,
        )
        for marker in (
            'className: "diagnostics-workspace"',
            'tabindex: "0"',
            '"aria-label": "系统诊断三栏工作区；普通窗口可横向滚动"',
            'role: "status"',
            '"aria-live": "polite"',
            '"aria-atomic": "true"',
            "diagnosticsFocusToken",
            "restoreDiagnosticsFocus",
            "createStatusBadge",
            "updateStatusBadge",
            "definitionList",
        ):
            self.assertIn(marker, view)
        combined = "\n".join((controller, view, model))
        for forbidden in (
            "fetch(",
            "globalThis.fetch",
            "XMLHttpRequest",
            "localStorage",
            "sessionStorage",
            "indexedDB",
            "console.",
            "innerHTML",
            "tests/fixtures",
            "fixtures/webui",
            'createElement("pre"',
            'createElement("textarea"',
            "伪终端",
            "原始日志",
            "raw log",
        ):
            self.assertNotIn(forbidden, combined)

    def test_window_manager_t12_static_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        index = (webui / "index.html").read_text(encoding="utf-8")
        manager = (webui / "js" / "core" / "window-manager.js").read_text(
            encoding="utf-8"
        )
        window_dom = (
            webui / "js" / "core" / "window-dom-lifecycle.js"
        ).read_text(encoding="utf-8")
        window_policy = (
            webui / "js" / "core" / "window-policy.js"
        ).read_text(encoding="utf-8")
        window_interaction = (
            webui / "js" / "core" / "window-interaction.js"
        ).read_text(encoding="utf-8")
        desktop = (webui / "js" / "core" / "desktop.js").read_text(
            encoding="utf-8"
        )
        actions = (webui / "js" / "core" / "actions.js").read_text(
            encoding="utf-8"
        )
        main = (webui / "js" / "main.js").read_text(encoding="utf-8")
        desktop_css = (webui / "styles" / "desktop.css").read_text(
            encoding="utf-8"
        )

        def css_block(source: str, selector: str) -> str:
            match = re.search(
                rf"(?m)^\s*{re.escape(selector)}\s*\{{",
                source,
            )
            self.assertIsNotNone(match, selector)
            opening = source.index("{", match.start())
            closing = source.index("}", opening)
            return source[opening + 1 : closing]

        # 入场动画只由窗口基础规则声明；交互属性只切换 transition，
        # 否则从 animation:none 恢复名称会把已结束的入场动画重新启动。
        application_window = css_block(desktop_css, ".application-window")
        interacting_window = css_block(
            desktop_css,
            ".application-window[data-window-interacting]",
        )
        self.assertEqual(
            re.findall(r"(?m)^\s*animation\s*:\s*([^;]+);", application_window),
            ["imageweave-window-appear var(--imageweave-transition-standard)"],
        )
        self.assertIn("transition: none", interacting_window)
        self.assertNotRegex(
            interacting_window,
            r"(?m)^\s*animation(?:-[\w-]+)?\s*:",
        )
        self.assertEqual(
            desktop_css.count(
                "animation: imageweave-window-appear var(--imageweave-transition-standard)"
            ),
            1,
        )
        self.assertEqual(
            desktop_css.count("@keyframes imageweave-window-appear"),
            1,
        )
        motion_off = css_block(
            desktop_css,
            ':root[data-motion="off"] .application-window',
        )
        self.assertIn("animation: none", motion_off)
        self.assertIn("transition: none", motion_off)
        reduced_motion = desktop_css.split(
            "@media (prefers-reduced-motion: reduce)", 1
        )[1].split("@media (forced-colors: active)", 1)[0]
        reduced_window = css_block(reduced_motion, ".application-window")
        self.assertIn("animation: none", reduced_window)
        self.assertIn("transition: none", reduced_window)

        self.assertIn("<template data-window-template>", index)
        self.assertIn("data-window-layer", index)
        self.assertEqual(index.count('data-application-window'), 1)
        self.assertEqual(index.count('data-window-resize="'), 3)
        for direction, label in (
            ("right", "调整窗口宽度"),
            ("bottom", "调整窗口高度"),
            ("corner", "调整窗口宽度和高度"),
        ):
            self.assertIn(f'data-window-resize="{direction}"', index)
            self.assertIn(f'aria-label="{label}"', index)
        self.assertNotIn('id="window-title"', index)
        self.assertNotIn('id="app-content"', index)
        self.assertIn('role="group"', index)

        self.assertNotIn('role="dialog"', manager + window_dom)
        self.assertIn("const instances = new Map()", window_dom)
        self.assertIn("windowTemplate.content.cloneNode(true)", window_dom)
        self.assertIn("onMount?.(app, bodyEl)", window_dom)
        self.assertIn("onUnmount?.(app, instance.bodyEl)", window_dom)
        self.assertIn("instance.element.style.zIndex = String(zIndex)", window_dom)
        self.assertIn("setPointerCapture", window_interaction)
        self.assertIn("releasePointerCapture", window_interaction)
        self.assertIn('event.target.closest("button")', manager)
        self.assertIn('{ capture: true }', manager)
        self.assertNotIn('"mousemove"', manager)
        self.assertNotIn("document.onmousemove", manager)
        pointer_focus = manager[
            manager.index("const onWindowPointerDown") :
            manager.index("const onTitlebarPointerDown")
        ]
        self.assertIn("actions.focusWindow(instance.appId)", pointer_focus)
        self.assertNotIn("preventDefault", pointer_focus)
        pointer_move = window_interaction[
            window_interaction.index("const move =") :
            window_interaction.index("const resizeFromKeyboard")
        ]
        self.assertIn("applyRect(instance.element, interaction.rect)", pointer_move)
        self.assertNotIn("actions.", pointer_move)
        self.assertIn("KEYBOARD_RESIZE_STEP = 16", window_policy)

        self.assertRegex(
            actions,
            r"WINDOW_LAYOUT_DEBOUNCE_MS\s*=\s*(?:3\d\d|[4-9]\d\d|\d{4,})",
        )
        self.assertIn("beginWindowInteraction", actions)
        self.assertIn("endWindowInteraction", actions)
        self.assertIn("flushWindowLayout()", actions)
        self.assertIn("mountApplication(app, bodyElement)", desktop)
        self.assertIn("unmountApplication(app)", desktop)
        self.assertIn("windowManager.focusBody()", desktop)
        self.assertIn("`window-title-${app.id}`", window_dom)
        self.assertIn("`app-content-${app.id}`", window_dom)

        self.assertIn(
            'const windowLayer = document.querySelector("[data-window-layer]")',
            main,
        )
        self.assertIn("measureWindowLayerViewport(windowLayer, document)", main)
        self.assertIn("windowLayerGeometryOptions()", main)
        self.assertIn(".window-layer {", desktop_css)
        self.assertIn("position: absolute", desktop_css)
        self.assertIn("inset: 0", desktop_css)
        self.assertNotIn("window-layer--opacity", desktop_css)
        self.assertIn("@supports not", desktop_css)
        self.assertIn(".application-window {", desktop_css)
        self.assertIn(':root[data-motion="off"] .application-window', desktop_css)
        self.assertIn("@media (prefers-reduced-motion: reduce)", desktop_css)
        self.assertIn("@media (forced-colors: active)", desktop_css)
        forced = desktop_css.split("@media (forced-colors: active)", 1)[1]
        self.assertIn("CanvasText", forced)
        self.assertIn("Canvas", forced)
        self.assertIn(".window-resize-handle", forced)

    def test_window_manager_t13_static_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        index = (webui / "index.html").read_text(encoding="utf-8")
        manager = (webui / "js" / "core" / "window-manager.js").read_text(
            encoding="utf-8"
        )
        window_dom = (
            webui / "js" / "core" / "window-dom-lifecycle.js"
        ).read_text(encoding="utf-8")
        window_policy = (
            webui / "js" / "core" / "window-policy.js"
        ).read_text(encoding="utf-8")
        window_workspace = (
            webui / "js" / "core" / "window-workspace.js"
        ).read_text(encoding="utf-8")
        taskbar = (
            webui / "js" / "components" / "taskbar-windows.js"
        ).read_text(encoding="utf-8")
        menu_bar = (
            webui / "js" / "components" / "menu-bar.js"
        ).read_text(encoding="utf-8")
        desktop = (webui / "js" / "core" / "desktop.js").read_text(
            encoding="utf-8"
        )
        router = (webui / "js" / "core" / "router.js").read_text(
            encoding="utf-8"
        )
        definitions = (webui / "js" / "core" / "app-definitions.js").read_text(
            encoding="utf-8"
        )
        desktop_css = (webui / "styles" / "desktop.css").read_text(
            encoding="utf-8"
        )
        responsive_css = (webui / "styles" / "responsive.css").read_text(
            encoding="utf-8"
        )

        def javascript_block(source, marker):
            start = source.index(marker)
            opening = source.index("{", start + len(marker))
            depth = 0
            for position in range(opening, len(source)):
                character = source[position]
                if character == "{":
                    depth += 1
                elif character == "}":
                    depth -= 1
                    if depth == 0:
                        return source[opening + 1 : position]
            self.fail(f"JavaScript block 未闭合：{marker}")

        self.assertEqual(index.count("data-task-window-list"), 1)
        self.assertEqual(index.count("data-dock"), 1)
        self.assertEqual(index.count("data-application-center-host"), 1)
        self.assertEqual(index.count('data-window-workspace="normal"'), 1)
        self.assertEqual(
            index.count(
                '<nav class="dock" data-dock aria-label="ImageWeave Dock">'
            ),
            1,
        )
        dock_tag = re.search(r"<nav[^>]*\bdata-dock\b[^>]*>", index)
        self.assertIsNotNone(dock_tag)
        for unsafe_bootstrap_attribute in ("hidden", "inert", "aria-hidden"):
            self.assertNotRegex(
                dock_tag.group(0),
                rf"(?:^|\s){re.escape(unsafe_bootstrap_attribute)}(?:\s|=|>)",
            )
        self.assertEqual(
            index.count('href="./styles/desktop.css?v=20260815.1"'),
            1,
        )
        self.assertNotIn('href="./styles/desktop.css"', index)
        self.assertNotIn("data-start-menu", index)
        self.assertNotIn("data-desktop-icons", index)
        self.assertIn("DOCK_FIXED_APP_IDS", taskbar)
        self.assertIn('["crawl", "tasks", "gallery", "review"]', taskbar)
        self.assertIn("deriveDockModel", taskbar)
        self.assertIn("activateDockItem", taskbar)
        self.assertIn("items.slice(0, visibleLimit)", taskbar)
        self.assertIn("items.slice(visibleLimit)", taskbar)
        self.assertIn('"aria-expanded": "false"', taskbar)
        self.assertIn('"aria-controls": DOCK_OVERFLOW_LIST_ID', taskbar)
        self.assertIn('event.key !== "Escape"', taskbar)
        self.assertIn("event.stopImmediatePropagation()", taskbar)
        self.assertIn('documentObject.addEventListener("pointerdown"', taskbar)
        self.assertIn('"aria-label": item.ariaLabel', taskbar)
        self.assertIn('dataset: { dockItem: item.key, dockState: item.state }', taskbar)
        self.assertIn('dockHost.hidden || dockHost.hasAttribute("inert")', taskbar)
        self.assertIn("if (isUnavailable()) return false", taskbar)
        self.assertNotIn("innerHTML", taskbar)

        self.assertIn("deriveWindowWorkspaceMode", window_workspace)
        self.assertIn('focusedWindow?.windowState === "maximized"', window_workspace)
        self.assertIn('windowLayer.setAttribute("data-window-workspace", mode)', window_workspace)
        for contract in (
            "setElementInert(dock, true)",
            'dock.toggleAttribute("hidden", true)',
            'dock.setAttribute("aria-hidden", "true")',
            'dock.removeAttribute("aria-hidden")',
            "setElementInert(dock, false)",
            'dock.toggleAttribute("hidden", false)',
        ):
            self.assertIn(contract, window_workspace)
        self.assertNotIn("localStorage", window_workspace + manager)

        render_stack = javascript_block(manager, "const renderStack =")
        derive_position = render_stack.index("deriveWindowWorkspaceMode(stack, focusedAppId)")
        marker_position = render_stack.index(
            "syncWindowWorkspaceMode(windowLayer, dock, workspaceMode)"
        )
        geometry_position = render_stack.index("deriveWindowRenderPlan")
        self.assertLess(derive_position, marker_position)
        self.assertLess(marker_position, geometry_position)
        self.assertIn("releaseDockFocus(focusedAppId)", render_stack)
        self.assertIn("taskbarWindows?.closeOverflow()", render_stack)
        self.assertIn("if (transferFocus) focusBody(focusedAppId)", render_stack)
        self.assertIn(
            "syncWindowWorkspaceMode(windowLayer, dock, WINDOW_WORKSPACE_MODES.normal)",
            javascript_block(manager, "    destroy()"),
        )
        self.assertIn("const dock = requireElement(\"[data-dock]\", desktop)", desktop)
        self.assertIn("dock,", desktop)

        task_activation = javascript_block(manager, "const activate =")
        self.assertIn('requestHide(instance, "minimized"', task_activation)
        self.assertIn("actions.minimizeWindow(appId)", task_activation)
        self.assertIn("actions.restoreWindow(appId)", task_activation)
        self.assertIn("actions.focusWindow(appId)", task_activation)
        self.assertIn("actions.navigateToApp(appId)", task_activation)
        self.assertIn("deriveWindowViews", manager)
        self.assertIn("rect: Object.freeze({ ...record.rect })", window_policy)
        view_projection = javascript_block(
            window_policy, "export function deriveWindowViews"
        )
        self.assertNotIn("actions.", view_projection)
        self.assertNotIn("record.rect =", view_projection)
        self.assertIn("instance.element.hidden = !view.visible", window_dom)
        self.assertIn("handle.hidden = false", window_dom)
        self.assertIn("handle.tabIndex = view.maximized ? -1 : 0", window_dom)
        self.assertIn("instance.visible !== view.open", window_dom)
        self.assertIn("只有真实 minimized 才停用应用", window_dom)
        self.assertNotIn('record?.appId === "review"', manager + window_dom)
        self.assertIn("if (view.open && !view.maximized)", window_dom)
        self.assertNotIn("MOBILE_QUERY", manager)
        viewport_change = javascript_block(manager, "const onViewportChange =")
        self.assertIn("commit: false", viewport_change)
        self.assertNotIn("actions.moveWindow", viewport_change)
        self.assertNotIn("actions.toggleWindowMaximized", viewport_change)

        self.assertIn("createApplicationCenter", desktop)
        self.assertIn("createMenuBar", desktop)
        self.assertIn("onCloseFocus(app)", desktop)
        self.assertIn("windowManager.focusDockButton(null)", desktop)
        self.assertIn("onWindowCommand:", desktop)
        self.assertNotIn("actions.minimizeWindow", menu_bar)
        self.assertNotIn("actions.restoreWindow", menu_bar)
        self.assertNotIn("actions.focusWindow", menu_bar)
        self.assertIn("event.defaultPrevented", menu_bar)
        self.assertIn("event.stopImmediatePropagation()", menu_bar)
        self.assertIn('application.availability === "ready"', router)
        self.assertIn('application.availability === "preview"', router)
        for app_id in ("gallery", "export"):
            self.assertEqual(definitions.count(f'id: "{app_id}"'), 1)
        self.assertEqual(definitions.count('availability: "preview"'), 2)

        self.assertIn(".dock__items", desktop_css)
        self.assertIn('.dock__item[data-dock-state="focused"]', desktop_css)
        self.assertIn('.dock__item[data-dock-state="minimized"]', desktop_css)
        self.assertIn(".dock__overflow", desktop_css)
        self.assertRegex(
            desktop_css,
            r'\.window-layer\[data-window-workspace="maximized"\]\s*\{[^}]*bottom:\s*0;',
        )
        fallback_predicate = (
            ".window-layer:has(> .application-window[data-window-focused]"
            "[data-maximized]:not([hidden]))"
        )
        self.assertGreaterEqual(desktop_css.count(fallback_predicate), 4)
        self.assertRegex(
            desktop_css,
            rf"{re.escape(fallback_predicate)}\s*\{{[^}}]*bottom:\s*0;",
        )
        self.assertRegex(
            desktop_css,
            rf"{re.escape(fallback_predicate)}\s*>\s*"
            r"\.application-window\[data-window-focused\]"
            r"\[data-maximized\]:not\(\[hidden\]\)\s*\{"
            r"[^}]*left:\s*0\s*!important;"
            r"[^}]*top:\s*0\s*!important;"
            r"[^}]*width:\s*100%\s*!important;"
            r"[^}]*height:\s*100%\s*!important;",
        )
        self.assertRegex(
            desktop_css,
            rf"{re.escape(fallback_predicate)}\s*~\s*\.dock\s*\{{"
            r"[^}]*display:\s*none;"
            r"[^}]*-webkit-backdrop-filter:\s*none\s*!important;"
            r"[^}]*backdrop-filter:\s*none\s*!important;",
        )
        self.assertIn("~ .dock :is(.dock__items, .dock__overflow)", desktop_css)
        self.assertIn(".dock[hidden] .dock__items", desktop_css)
        self.assertIn(".dock[hidden] .dock__overflow", desktop_css)
        self.assertIn(".application-center", desktop_css)
        self.assertIn(".menu-bar", desktop_css)
        self.assertIn("@media (max-width: 1179px), (max-height: 719px)", responsive_css)
        self.assertIn(".desktop {", responsive_css)
        self.assertIn("display: none !important", responsive_css)
        self.assertIn(".desktop-size-blocker", responsive_css)
        self.assertNotIn("max-width: 767px", responsive_css)

    def test_pure_javascript_modules(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("未安装 Node.js；生产运行不依赖 Node.js")

        repository_root = Path(__file__).resolve().parents[2]
        runner = repository_root / "scripts" / "run-webui-coverage.py"
        completed = subprocess.run(
            [sys.executable, str(runner), "--node", node, "--test-only"],
            cwd=repository_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=60,
            check=False,
        )

        if completed.returncode != 0:
            self.fail(
                "WebUI 纯 JavaScript 模块测试失败：\n"
                f"STDOUT:\n{completed.stdout}\nSTDERR:\n{completed.stderr}"
            )


if __name__ == "__main__":
    unittest.main()
