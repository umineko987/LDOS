from __future__ import annotations

import hashlib
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
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

        placeholder = app_sources["placeholder.js"]
        self.assertNotIn("/api/", placeholder)
        self.assertIn("createPlaceholderShell", placeholder)

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
            r'\.review-image-card\[data-active="true"\]\s*\{[^}]*opacity:\s*1;[^}]*outline:\s*6px double',
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
        self.assertIn('createElement("legend", { text: "选择站点" })', policy_dom)
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
        personalization_view = (
            webui / "js" / "components" / "personalization-view.js"
        ).read_text(encoding="utf-8")
        personalization_app = (
            webui / "js" / "apps" / "personalization.js"
        ).read_text(encoding="utf-8")
        personalization_css = (
            webui / "styles" / "apps" / "personalization.css"
        ).read_text(encoding="utf-8")
        storage_source = (webui / "js" / "core" / "storage.js").read_text(
            encoding="utf-8"
        )
        main = (webui / "js" / "main.js").read_text(encoding="utf-8")
        index = (webui / "index.html").read_text(encoding="utf-8")
        desktop_css = (webui / "styles" / "desktop.css").read_text(
            encoding="utf-8"
        )
        dialog_css = (webui / "styles" / "dialog.css").read_text(
            encoding="utf-8"
        )
        status_css = (webui / "styles" / "status.css").read_text(
            encoding="utf-8"
        )
        tokens_css = (webui / "styles" / "tokens.css").read_text(
            encoding="utf-8"
        )

        def css_block(source: str, selector: str) -> str:
            start = source.index(selector)
            opening = source.index("{", start)
            closing = source.index("}", opening)
            return source[opening + 1 : closing]

        # 运行时只接受安全模型投影与固定类；动态内联值仅限私有
        # Object URL，以及严格模型投影后的两个固定六位 HEX Token。
        self.assertIn("projectPersonalizationPreferences(preferences)", runtime)
        self.assertIn("normalizeThemeHex(projected.themeAccent)", runtime)
        self.assertIn("normalizeThemeHex(projected.themeSurface)", runtime)
        self.assertIn("deriveInterfaceThemeTone(themeSurface)", runtime)
        for symbol in (
            "WALLPAPER_FIT_CLASSES",
            "WALLPAPER_POSITION_CLASSES",
            "WALLPAPER_MASK_TONE_CLASSES",
            "WALLPAPER_MASK_STRENGTH_CLASSES",
            "WALLPAPER_BLUR_CLASSES",
            "WINDOW_OPACITY_CLASSES",
        ):
            self.assertIn(f"export const {symbol}", runtime)
        self.assertIn('"background-image"', runtime)
        self.assertIn("ownedObjectUrls.has(objectUrl)", runtime)
        self.assertIn('objectUrl.startsWith("blob:")', runtime)
        self.assertIn("JSON.stringify(objectUrl)", runtime)
        set_property_names = re.findall(
            r'\.setProperty\(\s*"([^"]+)"', runtime
        )
        self.assertEqual(len(set_property_names), runtime.count(".setProperty("))
        self.assertEqual(
            set(set_property_names),
            {
                "background-image",
                "--imageweave-accent",
                "--imageweave-surface",
            },
        )
        set_attribute_names = re.findall(
            r'\.setAttribute\(\s*"([^"]+)"', runtime
        )
        self.assertEqual(set(set_attribute_names), {"data-theme-tone"})
        self.assertEqual(
            len(set_attribute_names), runtime.count(".setAttribute(")
        )
        self.assertNotIn("cssText", runtime)
        self.assertNotIn("dataset", runtime)

        # G2 设置视图只使用两个原生颜色控件和纯文本输出；颜色不会被
        # 复制到 style/dataset。对比度只显示实际值，只有格式错误才使用
        # aria-invalid，本地预览/持久化仍经过严格六位 HEX 投影。
        self.assertNotIn("INTERFACE_THEME_CONTRAST_ADVISORY_RATIO", personalization_model)
        self.assertNotIn("INTERFACE_THEME_MIN_CONTRAST_RATIO", personalization_model)
        self.assertNotIn("界面主题对比度不足", personalization_model)
        self.assertEqual(personalization_view.count('type: "color"'), 1)
        self.assertIn('datasetName: "personalizationThemeAccent"', personalization_view)
        self.assertIn('datasetName: "personalizationThemeSurface"', personalization_view)
        self.assertIn('createElement("output"', personalization_view)
        self.assertIn('role: "status"', personalization_view)
        self.assertIn('"aria-live": "polite"', personalization_view)
        self.assertIn('"aria-invalid", "true"', personalization_view)
        self.assertIn("calculateThemeContrastRatio", personalization_view)
        self.assertIn("可正常使用", personalization_view)
        self.assertNotIn("仅供信息参考", personalization_view)
        self.assertIn("isValidInterfaceTheme", personalization_view)
        self.assertIn("deriveInterfaceThemeTone", personalization_view)
        self.assertNotIn("innerHTML", personalization_view)
        self.assertNotIn(".style", personalization_view)
        self.assertNotRegex(
            personalization_view,
            r"dataset[^\n]*(?:themeAccent|themeSurface)\.input\.value",
        )
        for source in (personalization_view, personalization_app):
            self.assertNotIn("/api/", source)
            self.assertNotIn("localStorage", source)
            self.assertNotIn("sessionStorage", source)
        self.assertEqual(
            personalization_app.count("event.target.matches(THEME_INPUT_SELECTOR)"),
            2,
        )
        self.assertIn("suppressThemePreviewPublish", personalization_app)
        self.assertIn("themeInputValuesMatchRuntimeDraft", personalization_app)
        self.assertIn("view.hasLocalThemeDraft()", personalization_app)
        self.assertIn("hasInvalidThemeDraft()", personalization_view)
        self.assertNotIn("低对比颜色尚未预览", personalization_app)
        self.assertNotIn("界面主题对比度不足", personalization_app)
        self.assertIn("已保存的主题设置不受影响", personalization_app)
        self.assertNotIn("imageweave.ui:theme", storage_source)
        self.assertIn(".personalization-theme-grid", personalization_css)
        self.assertIn("grid-template-columns: repeat(2, minmax(0, 1fr))", personalization_css)
        self.assertIn("min-height: 44px", personalization_css)
        self.assertIn(".personalization-theme-color:focus-visible", personalization_css)
        self.assertIn("@media (forced-colors: active)", personalization_css)
        self.assertIn("border-color: CanvasText", personalization_css)

        self.assertIn(
            'wallpaperMask: document.querySelector("[data-desktop-wallpaper-mask]")',
            main,
        )
        self.assertIn(
            'const windowLayer = document.querySelector("[data-window-layer]")',
            main,
        )
        self.assertIn("measureWindowLayerViewport(windowLayer, document)", main)
        self.assertIn("windowLayerGeometryOptions()", main)
        self.assertIn(
            'themeRoot: document.documentElement',
            main,
        )
        self.assertIn(
            '<html lang="zh-CN" data-motion="on" data-theme-tone="light">',
            index,
        )
        self.assertIn("data-desktop-wallpaper-mask", index)
        self.assertIn("data-window-layer", index)
        self.assertIn("data-application-window", index)

        root_tokens = css_block(tokens_css, ":root")
        self.assertEqual(root_tokens.count("--imageweave-accent:"), 1)
        self.assertEqual(root_tokens.count("--imageweave-surface:"), 1)
        self.assertIn("--imageweave-accent: #46515D", root_tokens)
        self.assertIn("--imageweave-surface: #F4F1EA", root_tokens)
        self.assertNotIn("--imageweave-hue", tokens_css)
        self.assertNotIn("oklch(", tokens_css)
        self.assertNotIn("prefers-color-scheme", tokens_css)
        self.assertIn(
            "color-scheme: light",
            css_block(tokens_css, ':root[data-theme-tone="light"]'),
        )
        self.assertIn(
            "color-scheme: dark",
            css_block(tokens_css, ':root[data-theme-tone="dark"]'),
        )
        self.assertIn("@media (forced-colors: active)", tokens_css)
        forced_theme = tokens_css.split("@media (forced-colors: active)", 1)[1]
        self.assertIn("--imageweave-accent: CanvasText !important", forced_theme)
        self.assertIn("--imageweave-surface: Canvas !important", forced_theme)
        self.assertIn("color: CanvasText", forced_theme)
        self.assertIn("background: Canvas", forced_theme)

        fit_contract = {
            "cover": "object-fit: cover",
            "contain": "object-fit: contain",
            "stretch": "object-fit: fill",
        }
        for fit, declaration in fit_contract.items():
            block = css_block(
                desktop_css,
                ".desktop-wallpaper--custom.desktop-wallpaper--fit-"
                f"{fit} .desktop-wallpaper__image",
            )
            self.assertIn(declaration, block)
        tile_block = css_block(
            desktop_css,
            ".desktop-wallpaper--custom.desktop-wallpaper--fit-tile "
            ".desktop-wallpaper__image-layer",
        )
        self.assertIn("background-repeat: repeat", tile_block)
        self.assertIn("background-size: auto", tile_block)
        self.assertIn("background-position: 0 0", tile_block)

        positions = {
            "top-left": "left top",
            "top": "center top",
            "top-right": "right top",
            "left": "left center",
            "center": "center",
            "right": "right center",
            "bottom-left": "left bottom",
            "bottom": "center bottom",
            "bottom-right": "right bottom",
        }
        for position, value in positions.items():
            block = css_block(
                desktop_css,
                f".desktop-wallpaper--position-{position} .desktop-wallpaper__image",
            )
            self.assertIn(f"object-position: {value}", block)

        self.assertIn(
            ".desktop-wallpaper--custom .desktop-wallpaper__mask",
            desktop_css,
        )
        self.assertIn("mask-tone-dark", desktop_css)
        self.assertIn("mask-tone-light", desktop_css)
        for strength in range(0, 81, 5):
            block = css_block(
                desktop_css,
                ".desktop-wallpaper--custom.desktop-wallpaper--mask-strength-"
                f"{strength} .desktop-wallpaper__mask",
            )
            self.assertRegex(block, rf"opacity:\s*{strength / 100:g}\s*;")

        soft_blur = css_block(
            desktop_css,
            ".desktop-wallpaper--custom.desktop-wallpaper--blur-soft "
            ".desktop-wallpaper__image-layer",
        )
        medium_blur = css_block(
            desktop_css,
            ".desktop-wallpaper--custom.desktop-wallpaper--blur-medium "
            ".desktop-wallpaper__image-layer",
        )
        self.assertIn("inset: -4px", soft_blur)
        self.assertIn("filter: blur(4px)", soft_blur)
        self.assertIn("inset: -10px", medium_blur)
        self.assertIn("filter: blur(10px)", medium_blur)
        blur_values = [int(value) for value in re.findall(r"blur\((\d+)px\)", desktop_css)]
        self.assertTrue(blur_values)
        self.assertLessEqual(max(blur_values), 10)
        image_layer = css_block(desktop_css, ".desktop-wallpaper__image-layer")
        self.assertIn("animation: none", image_layer)
        self.assertIn("transition: none", image_layer)

        self.assertIn(
            ".desktop-wallpaper--custom ~ .desktop-icons .desktop-icon",
            desktop_css,
        )
        self.assertIn("text-shadow:", desktop_css)
        self.assertIn(".desktop-icon:focus-visible", desktop_css)
        self.assertIn('.desktop-icon[aria-current="page"]', desktop_css)

        subtle = css_block(
            desktop_css,
            ".window-layer--opacity-subtle .application-window",
        )
        soft = css_block(
            desktop_css,
            ".window-layer--opacity-soft .application-window",
        )
        self.assertIn("96%", subtle)
        self.assertIn("92%", soft)
        self.assertNotIn("opacity:", subtle + soft)
        self.assertNotRegex(desktop_css, r"imageweave-surface\)\s+(?:[0-8]\d|9[01])%")
        self.assertIn("@media (forced-colors: active)", desktop_css)
        forced_colors = desktop_css.split(
            "@media (forced-colors: active)", 1
        )[1]
        self.assertIn(".application-window", forced_colors)
        self.assertIn(".window-titlebar", forced_colors)
        self.assertIn(".window-resize-handle", forced_colors)
        self.assertIn("border-color: CanvasText", forced_colors)
        self.assertIn("background: Canvas !important", forced_colors)

        # 透明背景不使用元素 opacity，因此这些实体表面仍保持实色。
        self.assertIn("background: var(--imageweave-surface)", css_block(desktop_css, ".start-menu"))
        self.assertIn("background: var(--imageweave-surface)", css_block(desktop_css, ".taskbar"))
        self.assertIn(
            "background: var(--imageweave-surface)",
            css_block(dialog_css, ".imageweave-dialog"),
        )
        self.assertIn(
            "background: var(--imageweave-surface)",
            css_block(status_css, ".error-view"),
        )

    def test_glass_phase_one_visual_contract(self):
        backend_root = Path(__file__).resolve().parents[1]
        webui = backend_root / "gdl_backend" / "webui"
        styles = webui / "styles"
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

        # 三档表面必须各有不透明前置值，随后才使用受控 sRGB mix。
        default_tokens = tokens.split(':root[data-theme-tone="light"]', 1)[0]
        for tier, percentage in (
            ("content", 96),
            ("navigation", 86),
            ("environment", 74),
        ):
            solid_name = f"--imageweave-surface-{tier}-solid"
            token_name = f"--imageweave-surface-{tier}"
            self.assertRegex(
                default_tokens,
                rf"{re.escape(solid_name)}:\s*#[0-9A-Fa-f]{{6}}\s*;",
            )
            declarations = re.findall(
                rf"{re.escape(token_name)}:\s*([^;]+);",
                default_tokens,
            )
            self.assertGreaterEqual(len(declarations), 2, token_name)
            self.assertNotIn("color-mix", declarations[0], token_name)
            self.assertRegex(
                declarations[1],
                rf"color-mix\(in srgb,.*\s{percentage}%,\s*transparent\)",
                token_name,
            )

        token_groups = {
            "text": ("primary", "secondary", "inverse", "code"),
            "border": ("subtle", "strong"),
            "shadow": ("window", "menu", "dock", "flyout", "card", "control"),
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
            "--imageweave-window-action-size:",
            "--imageweave-control-height:",
            "--imageweave-desktop-min-width:",
            "--imageweave-desktop-min-height:",
        ):
            self.assertIn(token_name, tokens)
        self.assertIn("system-ui", tokens)
        self.assertIn("--imageweave-font-mono", tokens)
        self.assertIn("font-family: var(--imageweave-font-sans)", base)
        self.assertIn("font-family: var(--imageweave-font-mono)", controls)

        # 共享 selector 覆盖全部八个真实应用，不要求重写其 DOM 或布局。
        for app_id in app_ids:
            self.assertIn(f".{app_id}-button", controls, app_id)
            self.assertIn(f".{app_id}-panel", controls, app_id)
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

        # 不支持 backdrop 时使用实色；强制颜色和两种动效关闭路径可独立生效。
        for source in (desktop, dialog):
            self.assertIn("@supports not", source)
            self.assertIn("backdrop-filter: blur(1px)", source)
            self.assertIn("-solid) !important", source)
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
        self.assertGreaterEqual(status.count("transition-property: none !important"), 2)
        self.assertGreaterEqual(status.count("animation-name: none !important"), 2)

        # 个性化边界仍只有两个主题属性；静态视觉代码不引入外部资源或新颜色语法。
        set_property_names = re.findall(
            r'\.setProperty\(\s*"([^"]+)"', runtime
        )
        self.assertEqual(
            set(set_property_names),
            {
                "background-image",
                "--imageweave-accent",
                "--imageweave-surface",
            },
        )
        interface_keys = model[
            model.index("export const INTERFACE_THEME_PREFERENCE_KEYS") :
            model.index("];", model.index("export const INTERFACE_THEME_PREFERENCE_KEYS"))
        ]
        self.assertEqual(interface_keys.count('"themeAccent"'), 1)
        self.assertEqual(interface_keys.count('"themeSurface"'), 1)
        for forbidden in ("oklch(", "@import", "http://", "https://", "data:image", "data:font"):
            self.assertNotIn(forbidden, production_css)

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
            ["imageweave-window-appear 120ms ease-out"],
        )
        self.assertIn("transition: none", interacting_window)
        self.assertNotRegex(
            interacting_window,
            r"(?m)^\s*animation(?:-[\w-]+)?\s*:",
        )
        self.assertEqual(
            desktop_css.count(
                "animation: imageweave-window-appear 120ms ease-out"
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
        self.assertIn(
            ".window-layer--opacity-subtle .application-window",
            desktop_css,
        )
        self.assertIn(
            ".window-layer--opacity-soft .application-window",
            desktop_css,
        )
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
        self.assertNotIn("innerHTML", taskbar)

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
        for app_id in ("gallery", "schedule", "export"):
            self.assertEqual(definitions.count(f'id: "{app_id}"'), 1)
        self.assertEqual(definitions.count('availability: "preview"'), 3)

        self.assertIn(".dock__items", desktop_css)
        self.assertIn('.dock__item[data-dock-state="focused"]', desktop_css)
        self.assertIn('.dock__item[data-dock-state="minimized"]', desktop_css)
        self.assertIn(".dock__overflow", desktop_css)
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
