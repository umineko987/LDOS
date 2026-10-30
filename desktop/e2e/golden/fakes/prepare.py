"""黄金路径 e2e 的素材和模型占位：python prepare.py <图片目录> <去重模型目录> <打标模型目录>

图片（8 张，内容固定）：
- a / a_copy：像素完全相同、PNG 压缩级别不同 → 去重的自动组（质量相同时文件大的胜出，所以 a 用低压缩、留 a）；
- b / b_small：b 缩小到 3/4 → 去重的相似组（真实 dedup_core，不开 SSCD/DINO 也能分出来）；
- c_mono：灰度 → 假完成度模型判成黑白；d_sketch：白底线稿 → 判成草稿；
- e、f：普通图。
每张图的底色决定假打标模型给出的 red/green/blue_theme。

模型占位只为通过“已安装”检查，不含权重：
- 去重 SSCD / DINOv2：非空文件（model_setup 只看大小）；
- 完成度过滤模型：按清单大小建稀疏文件（文件校验由假的 Python 探测代替，见 golden/setup.ts）；
- 打标 wd-vit-v3：manifest + 空的 model.onnx + 假词表 selected_tags.csv（推理由 tagger_cli.py 代替）。
"""

from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO / "gallery-dl-backend"))
sys.path.insert(0, str(REPO / "tagger"))

from gdl_backend.review_filter_models import MODEL_FILES, model_paths  # noqa: E402
from specs import SPECS  # noqa: E402

TAGGER_MODEL = "wd-vit-v3"
VOCABULARY = (
    ("general", 9), ("sensitive", 9), ("questionable", 9), ("explicit", 9),
    ("1girl", 0), ("solo", 0), ("simple_background", 0),
    ("red_theme", 0), ("green_theme", 0), ("blue_theme", 0),
    ("golden_hero_(ldos)", 4),
)
BASES = {"red": (200, 50, 40), "green": (40, 170, 60), "blue": (40, 60, 200)}


def scene(seed: int, base: str, size: tuple[int, int] = (512, 384)) -> Image.Image:
    rnd = random.Random(seed)
    image = Image.new("RGB", size, BASES[base])
    draw = ImageDraw.Draw(image)
    for _ in range(14):
        x, y = rnd.randrange(size[0]), rnd.randrange(size[1])
        w, h = rnd.randrange(30, 120), rnd.randrange(30, 100)
        shade = tuple(min(255, channel + rnd.randrange(-30, 30)) for channel in BASES[base])
        draw.ellipse([x, y, x + w, y + h], fill=tuple(max(0, value) for value in shade))
    return image


def images(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    a = scene(1, "red")
    a.save(root / "a.png", compress_level=1)
    a.save(root / "a_copy.png", compress_level=9)
    b = scene(2, "blue")
    b.save(root / "b.png")
    b.resize((384, 288), Image.LANCZOS).save(root / "b_small.png")
    scene(3, "green").convert("L").convert("RGB").save(root / "c_mono.png")
    sketch = Image.new("RGB", (512, 384), "white")
    draw = ImageDraw.Draw(sketch)
    rnd = random.Random(4)
    for _ in range(25):
        draw.line([(rnd.randrange(512), rnd.randrange(384)), (rnd.randrange(512), rnd.randrange(384))],
                  fill=(30, 30, 30), width=2)
    sketch.save(root / "d_sketch.png")
    scene(5, "green").save(root / "e.png")
    scene(6, "red").save(root / "f.png")


def dedup_models(root: Path) -> None:
    checkpoints = root / "torch" / "hub" / "checkpoints"
    hub = root / "torch" / "hub" / "facebookresearch_dinov2_7764ea0f912e53c92e82eb78a2a1631e92725fc8"
    for directory in (checkpoints, hub):
        directory.mkdir(parents=True, exist_ok=True)
    (root / "sscd_disc_mixup.torchscript.pt").write_bytes(b"0")
    (checkpoints / "dinov2_vits14_pretrain.pth").write_bytes(b"0")
    (hub / "hubconf.py").write_text("", encoding="utf-8")
    for path, entry in zip(model_paths(root, "completeness"), MODEL_FILES["completeness"]):
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("wb") as handle:
            handle.truncate(entry[1])


def tagger_models(root: Path) -> None:
    spec = SPECS[TAGGER_MODEL]
    bundle = root / spec.key
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "model.onnx").write_bytes(b"")
    rows = ["tag_id,name,category,count"]
    rows += [f"{index},{name},{category},0" for index, (name, category) in enumerate(VOCABULARY)]
    (bundle / "selected_tags.csv").write_text("\n".join(rows) + "\n", encoding="utf-8")
    manifest = {"key": spec.key, "revision": spec.revision, "files": [remote.name for remote in spec.files]}
    (bundle / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")


if __name__ == "__main__":
    images(Path(sys.argv[1]))
    dedup_models(Path(sys.argv[2]))
    tagger_models(Path(sys.argv[3]))
