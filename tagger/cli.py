"""打标 CLI。

用法（与去重模块相同的 venv 即可运行，无额外依赖）：
  python tagger/cli.py prepare --models wd-vit-v3 [--model-dir DIR]
  python tagger/cli.py tag --models wd-vit-v3 --inputs 图库目录 [--general-thr 0.35]
"""

from __future__ import annotations

import argparse
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


def command_prepare(args: argparse.Namespace) -> int:
    from bundle import install_by_key
    from specs import SPECS

    token = None
    if args.token_file:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
    for key in args.models:
        spec = SPECS[key]
        print(f"安装 {key} ({spec.repo}@{spec.revision[:12]})")
        install_by_key(key, Path(args.model_dir), token=token or None)
        print(f"{key} 就绪")
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
            )
            if value is not None
        },
        categories=tuple(args.categories.split(",")),
    )
    cache = TaggerCache(Path(args.cache))
    try:
        runner = TaggerRunner(
            Path(args.model_dir), cache, resolve_specs(args.models),
            batch_size=args.batch_size,
        )
        stats = runner.run(
            files, policy,
            write_captions=not args.no_captions,
            overwrite_captions=args.overwrite,
            on_progress=progress_printer,
        )
    finally:
        cache.close()
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

    prepare = subparsers.add_parser("prepare", help="下载并安装模型")
    prepare.add_argument("--models", required=True, help="逗号分隔的模型 key")
    prepare.add_argument("--token-file", type=Path, help="Hugging Face 访问令牌文件（gated 模型用）")
    prepare.set_defaults(handler=command_prepare)

    tag = subparsers.add_parser("tag", help="批量打标并导出 caption")
    tag.add_argument("--models", required=True, help="逗号分隔的模型 key，首个模型写同名 txt")
    tag.add_argument("--inputs", nargs="+", required=True, help="图片文件或目录")
    tag.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    tag.add_argument("--general-thr", type=float)
    tag.add_argument("--character-thr", type=float)
    tag.add_argument("--rating-thr", type=float)
    tag.add_argument("--categories", default="general,character")
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
