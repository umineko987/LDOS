"""打标 CLI。

用法（与去重模块相同的 venv 即可运行，无额外依赖）：
  python tagger/cli.py prepare --models wd-vit-v3 [--model-dir DIR]
  python tagger/cli.py tag --models wd-vit-v3 --inputs 图库目录 [--general-thr 0.35]
  python tagger/cli.py tag --models wd-vit-v3 --inputs-file - --no-captions --emit-results
  python tagger/cli.py candidates --models wd-vit-v3 --inputs-file - [--floor 0.05] [--compute]
  python tagger/cli.py compose --models wd-vit-v3 --inputs-file - [--model-threshold M general 0.4]

--progress-json 时输出 JSON 行事件（install_start/download/installed/
progress/done），供后端子进程消费。candidates/compose 与 tag --emit-results
另输出数据行（models/candidates/result），一律 ASCII 转义，与控制台编码无关。

--inputs-file：UTF-8 文本，每行一个图片文件或目录，空行忽略；`-` 表示 stdin。
行可写成 "<64 位小写 sha256>\\t<路径>" 给出已知内容哈希：candidates（不带
--compute）与 compose 直接采用它查缓存；会推理写缓存的 tag 与 --compute
一律按内容重算。POSIX 下无法按 UTF-8 解码的字节经 surrogateescape 往返。

退出码：0 成功；1 没有图片；2 参数无效；3 需要接受许可；4 模型不可用。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

WORKSPACE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_DIR = WORKSPACE_DIR / ".models"
DEFAULT_CACHE = WORKSPACE_DIR / "tags.sqlite3"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}
THRESHOLD_CATEGORIES = ("general", "character", "rating", "copyright", "quality", "meta", "style")
_KNOWN_HASH = re.compile(r"[0-9a-f]{64}")


def scan_images(roots: list[Path]) -> list[Path]:
    images: list[Path] = []
    for root in roots:
        if root.is_file():
            images.append(root)
            continue
        for current, directories, files in root.walk():
            directories[:] = [name for name in directories if not name.startswith(".")]
            for name in files:
                path = current / name
                if path.suffix.lower() in IMAGE_EXTENSIONS and not path.is_symlink():
                    images.append(path)
    return images


def read_inputs_file(source: str):
    """解析 --inputs-file，返回 [LookupInput]（哈希未给出时为 None）。"""
    from runner import LookupInput

    if source == "-":
        stream = getattr(sys.stdin, "buffer", None)
        raw = stream.read() if stream is not None else sys.stdin.read().encode("utf-8", "surrogateescape")
    else:
        raw = Path(source).read_bytes()
    text = raw.decode("utf-8-sig", errors="surrogateescape")
    entries = []
    for line in text.split("\n"):
        line = line.removesuffix("\r")
        if not line.strip():
            continue
        digest = None
        if len(line) > 65 and line[64] == "\t" and _KNOWN_HASH.fullmatch(line[:64]):
            digest, line = line[:64], line[65:]
        entries.append(LookupInput(Path(line), digest))
    return entries


def collect_inputs(args: argparse.Namespace):
    """--inputs 按目录扫描；--inputs-file 里的目录展开，其余条目原样保留（缺失文件由下游报告）。"""
    from runner import LookupInput

    if args.inputs_file is None:
        return [LookupInput(path) for path in scan_images([Path(item) for item in args.inputs])]
    collected = []
    for entry in read_inputs_file(args.inputs_file):
        if entry.sha256 is None and entry.path.is_dir():
            collected.extend(LookupInput(path) for path in scan_images([entry.path]))
        else:
            collected.append(entry)
    return collected


def progress_printer(stage: str, done: int, total: int) -> None:
    labels = {
        "hashing": "计算哈希",
        "inferring": "推理",
        "selecting": "筛选",
    }
    print(f"\r[{labels.get(stage, stage)}] {done}/{total}", end="", flush=True)
    if done >= total:
        print()


def json_progress(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def emit_line(payload: dict) -> None:
    """数据行：ASCII 转义（路径里的任意字符与 surrogate 都能经 JSON 往返），紧凑分隔。"""
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), flush=True)


def make_progress_callback(json_mode: bool):
    if not json_mode:
        return progress_printer

    def callback(stage: str, done: int, total: int) -> None:
        # 逐张输出太密：仅每 5% 或完成时打点
        if total and done < total and done % max(1, total // 20) != 0:
            return
        json_progress({"type": "progress", "stage": stage, "done": done, "total": total})

    return callback


def build_policy(args: argparse.Namespace):
    from postprocess import SelectionPolicy

    return SelectionPolicy(
        thresholds={
            category: value
            for category in THRESHOLD_CATEGORIES
            if (value := getattr(args, f"{category}_thr")) is not None
        },
        categories=tuple(category.strip() for category in args.categories.split(",") if category.strip()),
    )


def parse_model_thresholds(args: argparse.Namespace, specs) -> dict[str, dict[str, float]] | None:
    """--model-threshold 校验：模型须已选中、类别须是该模型支持的、值在 [0.01, 0.99]。无效返回 None。"""
    model_thresholds: dict[str, dict[str, float]] = {}
    for model, category, raw_value in args.model_threshold:
        try:
            spec = next(spec for spec in specs if spec.key == model)
            value = float(raw_value)
            if category not in spec.default_thresholds or not 0.01 <= value <= 0.99:
                raise ValueError
        except (StopIteration, ValueError):
            print(f"无效模型阈值: {model} {category} {raw_value}", file=sys.stderr)
            return None
        model_thresholds.setdefault(model, {})[category] = value
    return model_thresholds


def _resolve(args: argparse.Namespace):
    from runner import resolve_specs

    try:
        return resolve_specs(args.models)
    except KeyError as error:
        print(error.args[0], file=sys.stderr)
        return None


def command_prepare(args: argparse.Namespace) -> int:
    from bundle import install_by_key
    from specs import SPECS

    emit = json_progress if args.progress_json else (lambda payload: None)
    token = None
    if args.token_file == "-":
        token = sys.stdin.read().strip()  # 从 stdin 读，token 不落盘
    elif args.token_file:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
    for key in args.models:
        spec = SPECS[key]
        if spec.gated and not args.accept_license:
            print(
                f"{key} 受自定义许可约束（{spec.license}）。"
                f"确认同意后加 --accept-license 重新执行。",
                file=sys.stderr,
            )
            return 3
        emit({"type": "install_start", "model": key, "repo": spec.repo, "revision": spec.revision})

        def download_progress(name: str, done: int, total: int) -> None:
            emit({"type": "download", "model": key, "file": name, "done": done, "total": total})

        install_by_key(
            key, Path(args.model_dir),
            token=token or None,
            progress=download_progress,
            accept_license=args.accept_license,
        )
        emit({"type": "installed", "model": key})
    emit({"type": "done", "command": "prepare", "models": args.models})
    return 0


def command_tag(args: argparse.Namespace) -> int:
    from adapters import TaggerAdapterError
    from cache import TaggerCache
    from runner import TaggerRunner

    # 会推理写缓存：忽略调用方给出的哈希，一律按内容计算
    files = [entry.path for entry in collect_inputs(args)]
    if not files:
        print("没有找到图片", file=sys.stderr)
        return 1
    policy = build_policy(args)
    specs = _resolve(args)
    if specs is None:
        return 2
    model_thresholds = parse_model_thresholds(args, specs)
    if model_thresholds is None:
        return 2
    json_mode = args.progress_json or args.emit_results
    cache = TaggerCache(Path(args.cache))
    try:
        runner = TaggerRunner(
            Path(args.model_dir), cache, specs,
            batch_size=args.batch_size,
        )
        stats = runner.run(
            files, policy,
            model_thresholds=model_thresholds,
            write_captions=not args.no_captions,
            overwrite_captions=args.overwrite,
            underscore_to_space=not args.keep_underscores,
            escape_parens=args.escape_parens,
            on_progress=make_progress_callback(json_mode),
            on_result=(lambda result: emit_line(result.to_payload())) if args.emit_results else None,
        )
    except TaggerAdapterError as error:
        print(error, file=sys.stderr)
        return 4
    finally:
        cache.close()
    if json_mode:
        json_progress({
            "type": "done",
            "command": "tag",
            "total": stats.total,
            "per_model": {
                key: {"inferred": model_stats.inferred, "cache_hits": model_stats.score_cache_hits}
                for key, model_stats in stats.per_model.items()
            },
            "decode_errors": stats.decode_errors,
            "unreadable": stats.unreadable,
            "captions_written": stats.captions_written,
            "captions_skipped": stats.captions_skipped,
        })
        return 0
    print(f"完成：共 {stats.total} 张")
    for key, model_stats in stats.per_model.items():
        print(f"  {key}: 新推理 {model_stats.inferred}，命中 {model_stats.score_cache_hits}")
    for label, items in (("解码失败", stats.decode_errors), ("无法读取", stats.unreadable)):
        if items:
            print(f"{label} {len(items)} 张：", file=sys.stderr)
            for item in items:
                print(f"  {item}", file=sys.stderr)
    if stats.captions_written or stats.captions_skipped:
        print(f"caption：写入 {stats.captions_written}，跳过已存在 {stats.captions_skipped}")
    return 0


def _stream(lines) -> int:
    from adapters import TaggerAdapterError

    try:
        for line in lines:
            emit_line(line)
    except TaggerAdapterError as error:
        print(error, file=sys.stderr)
        return 4
    return 0


def command_candidates(args: argparse.Namespace, *, adapter_factory=None) -> int:
    from cache import TaggerCache
    from runner import default_adapter_factory, run_candidates

    if not 0.0 <= args.floor <= 1.0:
        print(f"无效候选下限: {args.floor}", file=sys.stderr)
        return 2
    specs = _resolve(args)
    if specs is None:
        return 2
    inputs = collect_inputs(args)
    if not inputs:
        print("没有找到图片", file=sys.stderr)
        return 1
    cache = TaggerCache(Path(args.cache))
    try:
        return _stream(run_candidates(
            Path(args.model_dir), cache, specs, inputs,
            floor=args.floor,
            compute=args.compute,
            batch_size=args.batch_size,
            adapter_factory=adapter_factory or default_adapter_factory,
            on_progress=make_progress_callback(True) if args.progress_json else None,
        ))
    finally:
        cache.close()


def command_compose(args: argparse.Namespace, *, adapter_factory=None) -> int:
    from cache import TaggerCache
    from runner import default_adapter_factory, run_compose

    specs = _resolve(args)
    if specs is None:
        return 2
    model_thresholds = parse_model_thresholds(args, specs)
    if model_thresholds is None:
        return 2
    inputs = collect_inputs(args)
    if not inputs:
        print("没有找到图片", file=sys.stderr)
        return 1
    cache = TaggerCache(Path(args.cache))
    try:
        return _stream(run_compose(
            Path(args.model_dir), cache, specs, inputs, build_policy(args),
            model_thresholds=model_thresholds,
            underscore_to_space=not args.keep_underscores,
            escape_parens=args.escape_parens,
            adapter_factory=adapter_factory or default_adapter_factory,
            on_progress=make_progress_callback(True) if args.progress_json else None,
        ))
    finally:
        cache.close()


def _add_input_arguments(parser: argparse.ArgumentParser) -> None:
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--inputs", nargs="+", help="图片文件或目录")
    group.add_argument("--inputs-file", help="每行一个路径的 UTF-8 文件，或 - 表示 stdin；可选 \"sha256<TAB>路径\"")
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)


def _add_policy_arguments(parser: argparse.ArgumentParser) -> None:
    for category in THRESHOLD_CATEGORIES:
        parser.add_argument(f"--{category}-thr", type=float)
    parser.add_argument("--model-threshold", nargs=3, action="append", default=[], metavar=("MODEL", "CATEGORY", "VALUE"),
                        help="单独覆盖模型的分类阈值，可重复指定；优先于全局阈值")
    parser.add_argument("--categories", default="", help="逗号分隔的类别；默认输出模型的全部类别")
    parser.add_argument("--keep-underscores", action="store_true", help="不把普通标签的下划线换成空格")
    parser.add_argument("--escape-parens", action="store_true", help="把括号转义为 \\( \\)")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LDOS 打标工具")
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare", help="下载并安装模型")
    prepare.add_argument("--progress-json", action="store_true", help="输出 JSON 行进度（供后端消费）")
    prepare.add_argument("--models", required=True, help="逗号分隔的模型 key")
    prepare.add_argument("--token-file", help="Hugging Face 访问令牌文件路径，或 - 表示 stdin（gated 模型用）")
    prepare.add_argument("--accept-license", action="store_true", help="确认接受 gated 模型的自定义许可条款")
    prepare.set_defaults(handler=command_prepare)

    tag = subparsers.add_parser("tag", help="批量打标并导出 caption")
    tag.add_argument("--progress-json", action="store_true", help="输出 JSON 行进度（供后端消费）")
    tag.add_argument("--models", required=True, help="逗号分隔的模型 key，按指定顺序合并去重并写入同名 txt")
    _add_input_arguments(tag)
    _add_policy_arguments(tag)
    tag.add_argument("--batch-size", type=int, default=8)
    tag.add_argument("--no-captions", action="store_true")
    tag.add_argument("--overwrite", action="store_true")
    tag.add_argument("--emit-results", action="store_true", help="每张图输出一行 result（含 JSON 进度）")
    tag.set_defaults(handler=command_tag)

    candidates = subparsers.add_parser("candidates", help="从缓存输出稀疏候选分数（JSON 行）")
    candidates.add_argument("--progress-json", action="store_true", help="同时输出 JSON 行进度")
    candidates.add_argument("--models", required=True, help="逗号分隔的模型 key")
    _add_input_arguments(candidates)
    candidates.add_argument("--floor", type=float, default=0.05, help="只输出分数不低于它的标签（rating 类全部输出）")
    candidates.add_argument("--compute", action="store_true", help="缺分数时先推理入库")
    candidates.add_argument("--batch-size", type=int, default=8)
    candidates.set_defaults(handler=command_candidates)

    compose = subparsers.add_parser("compose", help="按策略从缓存分数组出最终标签（JSON 行，不写文件）")
    compose.add_argument("--progress-json", action="store_true", help="同时输出 JSON 行进度")
    compose.add_argument("--models", required=True, help="逗号分隔的模型 key，按顺序合并去重")
    _add_input_arguments(compose)
    _add_policy_arguments(compose)
    compose.set_defaults(handler=command_compose)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.models = [key.strip() for key in args.models.split(",") if key.strip()]
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
