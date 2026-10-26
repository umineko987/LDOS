"""打标 CLI。

用法（与去重模块相同的 venv 即可运行，无额外依赖）：
  python tagger/cli.py prepare --models wd-vit-v3 [--model-dir DIR]
  python tagger/cli.py tag --models wd-vit-v3 --inputs 图库目录 [--general-thr 0.35]

--progress-json 时输出 JSON 行事件（install_start/download/installed/
progress/done），供后端子进程消费。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

WORKSPACE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_DIR = WORKSPACE_DIR / ".models"
DEFAULT_CACHE = WORKSPACE_DIR / "tags.sqlite3"
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}


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


def make_progress_callback(json_mode: bool):
    if not json_mode:
        return progress_printer

    def callback(stage: str, done: int, total: int) -> None:
        # 逐张输出太密：仅每 5% 或完成时打点
        if total and done < total and done % max(1, total // 20) != 0:
            return
        json_progress({"type": "progress", "stage": stage, "done": done, "total": total})

    return callback


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
    from cache import TaggerCache
    from postprocess import SelectionPolicy
    from runner import TaggerRunner, resolve_specs

    files = scan_images([Path(item) for item in args.inputs])
    if not files:
        print("没有找到图片", file=sys.stderr)
        return 1
    policy = SelectionPolicy(
        thresholds={
            category: value
            for category, value in (
                ("general", args.general_thr),
                ("character", args.character_thr),
                ("rating", args.rating_thr),
                ("copyright", args.copyright_thr),
                ("quality", args.quality_thr),
                ("meta", args.meta_thr),
                ("style", args.style_thr),
            )
            if value is not None
        },
        categories=tuple(category.strip() for category in args.categories.split(",") if category.strip()),
    )
    specs = resolve_specs(args.models)
    model_thresholds: dict[str, dict[str, float]] = {}
    for model, category, raw_value in args.model_threshold:
        try:
            spec = next(spec for spec in specs if spec.key == model)
            value = float(raw_value)
            if category not in spec.default_thresholds or not 0.01 <= value <= 0.99:
                raise ValueError
        except (StopIteration, ValueError):
            print(f"无效模型阈值: {model} {category} {raw_value}", file=sys.stderr)
            return 2
        model_thresholds.setdefault(model, {})[category] = value
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
            on_progress=make_progress_callback(args.progress_json),
        )
    finally:
        cache.close()
    if args.progress_json:
        json_progress({
            "type": "done",
            "command": "tag",
            "total": stats.total,
            "per_model": {
                key: {"inferred": model_stats.inferred, "cache_hits": model_stats.score_cache_hits}
                for key, model_stats in stats.per_model.items()
            },
            "decode_errors": stats.decode_errors,
            "captions_written": stats.captions_written,
            "captions_skipped": stats.captions_skipped,
        })
        return 0
    print(f"完成：共 {stats.total} 张")
    for key, model_stats in stats.per_model.items():
        print(f"  {key}: 新推理 {model_stats.inferred}，命中 {model_stats.score_cache_hits}")
    if stats.decode_errors:
        print(f"解码失败 {len(stats.decode_errors)} 张：", file=sys.stderr)
        for item in stats.decode_errors:
            print(f"  {item}", file=sys.stderr)
    if stats.captions_written or stats.captions_skipped:
        print(f"caption：写入 {stats.captions_written}，跳过已存在 {stats.captions_skipped}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="LDOS 打标工具")
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for subparser_factory in (lambda: subparsers.add_parser("prepare", help="下载并安装模型"),
                              lambda: subparsers.add_parser("tag", help="批量打标并导出 caption")):
        pass  # 占位说明：progress-json 分别加在两个子命令上

    prepare = subparsers.add_parser("prepare", help="下载并安装模型")
    prepare.add_argument("--progress-json", action="store_true", help="输出 JSON 行进度（供后端消费）")
    prepare.add_argument("--models", required=True, help="逗号分隔的模型 key")
    prepare.add_argument("--token-file", help="Hugging Face 访问令牌文件路径，或 - 表示 stdin（gated 模型用）")
    prepare.add_argument("--accept-license", action="store_true", help="确认接受 gated 模型的自定义许可条款")
    prepare.set_defaults(handler=command_prepare)

    tag = subparsers.add_parser("tag", help="批量打标并导出 caption")
    tag.add_argument("--progress-json", action="store_true", help="输出 JSON 行进度（供后端消费）")
    tag.add_argument("--models", required=True, help="逗号分隔的模型 key，按指定顺序合并去重并写入同名 txt")
    tag.add_argument("--inputs", nargs="+", required=True, help="图片文件或目录")
    tag.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    tag.add_argument("--general-thr", type=float)
    tag.add_argument("--character-thr", type=float)
    tag.add_argument("--rating-thr", type=float)
    tag.add_argument("--copyright-thr", type=float)
    tag.add_argument("--quality-thr", type=float)
    tag.add_argument("--meta-thr", type=float)
    tag.add_argument("--style-thr", type=float)
    tag.add_argument("--model-threshold", nargs=3, action="append", default=[], metavar=("MODEL", "CATEGORY", "VALUE"),
                     help="单独覆盖模型的分类阈值，可重复指定；优先于全局阈值")
    tag.add_argument("--categories", default="", help="逗号分隔的类别；默认输出模型的全部类别")
    tag.add_argument("--batch-size", type=int, default=8)
    tag.add_argument("--no-captions", action="store_true")
    tag.add_argument("--overwrite", action="store_true")
    tag.set_defaults(handler=command_tag)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    args.models = [key.strip() for key in args.models.split(",") if key.strip()]
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
