"""Pinned, offline CPU ONNX inference. Heavy imports run only in the dedup Python.

Transforms follow deepghs/imgutils@46df848dc4d20ac93f4919a40e2636d5f7c19766
(generic/classify.py and metrics/ccip.py). Model cards declare MIT / OpenRAIL.
No model download occurs except through the explicit --prepare entry point.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path
from typing import Any

MONOCHROME_REVISION = "15df450f9d1c74e192bc15514e90c8a864b56b86"
COMPLETENESS_REVISION = "315b0207c474c7dd0e9f6e282a51ffe00f3f11bd"
COMPLETENESS_LABELS = ("polished", "rough", "monochrome")
CCIP_REVISION = "eb2acdd29af1703388d3d0c04221add322bc9110"
MODEL_FILES = {
    "monochrome": (
        ("monochrome_mobilenetv3_large_100_dist.onnx", 16_822_434,
         "73d0a20dc80958467956b963bf32ec5fe597d05d6d09e1d1d7c57ba4883ed070",
         f"https://huggingface.co/deepghs/monochrome_detect/resolve/{MONOCHROME_REVISION}/mobilenetv3_large_100_dist/model.onnx"),
    ),
    "completeness": (
        ("completeness_mobilenetv3_v2.2_dist.onnx", 16_827_558,
         "41908bb124475dd853707452743ce4599fb03c4adacbd4188d8e35fd8705256f",
         f"https://huggingface.co/deepghs/anime_completeness/resolve/{COMPLETENESS_REVISION}/mobilenetv3_v2.2_dist/model.onnx"),
    ),
    "ccip": (
        ("ccip_feat.onnx", 150_248_245,
         "4ea118d16496274f4f6e08d3afc768cc592389e8f7f32f8732ce2215c228ac5f",
         f"https://huggingface.co/deepghs/ccip_onnx/resolve/{CCIP_REVISION}/ccip-caformer-24-randaug-pruned/model_feat.onnx"),
        ("ccip_metric.onnx", 1_649,
         "7e4646fdfbe369ad485b227ec47ac4092c98b8deef3af44e19fdbd8ba7bc25c1",
         f"https://huggingface.co/deepghs/ccip_onnx/resolve/{CCIP_REVISION}/ccip-caformer-24-randaug-pruned/model_metrics.onnx"),
    ),
}
# Published max-F1 distance threshold; the larger rejection cutoff is an LDOS
# engineering conservative band, NOT a calibrated probability or multi-person guarantee.
CCIP_MATCH_DISTANCE = 0.17847511429108218
CCIP_REJECT_DISTANCE = 0.35


def model_paths(root: Path, name: str) -> list[Path]:
    return [Path(root) / "review_filters" / entry[0] for entry in MODEL_FILES[name]]


def verify_weights(root: Path, name: str) -> None:
    for path, (_filename, size, expected, _url) in zip(model_paths(root, name), MODEL_FILES[name]):
        for parent in (*path.parents, path):
            if parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()):
                raise RuntimeError("过滤模型路径不能包含链接")
        if not path.is_file():
            raise RuntimeError(f"缺少 {name} 模型，请先准备模型")
        if path.stat().st_size != size:
            raise RuntimeError(f"{name} 模型大小校验失败，请重新准备模型")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError(f"{name} 模型 SHA-256 校验失败，请重新准备模型")


def rgb_image(image: Any) -> Any:
    from PIL import Image, ImageOps
    image = ImageOps.exif_transpose(image)
    rgba = image.convert("RGBA")
    background = Image.new("RGBA", rgba.size, "white")
    return Image.alpha_composite(background, rgba).convert("RGB")


def encode_image(image: Any, *, ccip: bool = False) -> Any:
    import numpy as np
    from PIL import Image
    image = rgb_image(image).resize((384, 384), Image.Resampling.BILINEAR)
    data = np.asarray(image).transpose(2, 0, 1).astype(np.float32) / 255.0
    mean = (0.48145466, 0.4578275, 0.40821073) if ccip else (0.5,)
    std = (0.26862954, 0.26130258, 0.27577711) if ccip else (0.5,)
    return ((data - np.asarray(mean, dtype=np.float32)[:, None, None]) /
            np.asarray(std, dtype=np.float32)[:, None, None]).astype(np.float32)


class FilterModels:
    def __init__(self, root: Path, names: list[str]) -> None:
        import numpy as np
        import onnxruntime as ort
        self.np = np
        self.sessions: dict[str, Any] = {}
        for name in names:
            verify_weights(root, name)
            for path in model_paths(root, name):
                settings = ort.SessionOptions()
                settings.intra_op_num_threads = min(4, os.cpu_count() or 1)
                settings.inter_op_num_threads = 1
                settings.log_severity_level = 3
                self.sessions[path.stem] = ort.InferenceSession(
                    str(path), sess_options=settings, providers=["CPUExecutionProvider"],
                )
        # Check execution, shapes and numerical validity, not merely imports/files.
        from PIL import Image
        test_image = Image.new("RGB", (384, 384), "white")
        if "monochrome" in names:
            self.is_monochrome(test_image)
        if "completeness" in names:
            self.completeness(test_image)
        if "ccip" in names:
            feature = self.feature(test_image)
            self.distances(feature, [feature])

    def is_monochrome(self, image: Any) -> bool:
        output = self.sessions["monochrome_mobilenetv3_large_100_dist"].run(
            ["output"], {"input": encode_image(image)[None]},
        )[0]
        if output.shape != (1, 2) or not self.np.isfinite(output).all():
            raise RuntimeError("单色模型输出无效")
        # Pinned label order: monochrome, normal. Use the benchmarked default argmax.
        return int(self.np.argmax(output[0])) == 0

    def completeness(self, image: Any) -> str:
        output = self.sessions["completeness_mobilenetv3_v2.2_dist"].run(
            ["output"], {"input": encode_image(image)[None]},
        )[0]
        if output.shape != (1, 3) or not self.np.isfinite(output).all():
            raise RuntimeError("完成度模型输出无效")
        # Pinned meta.json order; ONNX emits scores. Official default: argmax, no softmax/threshold.
        return COMPLETENESS_LABELS[int(self.np.argmax(output[0]))]

    def feature(self, image: Any) -> Any:
        output = self.sessions["ccip_feat"].run(["output"], {"input": encode_image(image, ccip=True)[None]})[0]
        if output.shape != (1, 768) or not self.np.isfinite(output).all() or self.np.linalg.norm(output) == 0:
            raise RuntimeError("CCIP 特征输出无效")
        return output[0]

    def distances(self, feature: Any, references: list[Any]) -> Any:
        # Use the official learned metric, not a substitute cosine similarity.
        # Small chunks avoid an unbounded reference-by-reference NxN matrix.
        distances = []
        for start in range(0, len(references), 32):
            batch = self.np.stack([feature, *references[start:start + 32]]).astype(self.np.float32)
            output = self.sessions["ccip_metric"].run(["output"], {"input": batch})[0]
            if output.shape != (len(batch), len(batch)) or not self.np.isfinite(output).all():
                raise RuntimeError("CCIP 距离输出无效")
            distances.extend(output[0, 1:].tolist())
        return self.np.asarray(distances)


def check_models(root: Path, names: list[str]) -> dict[str, dict[str, Any]]:
    result = {}
    for name in names:
        try:
            FilterModels(root, [name])
        except ImportError:
            result[name] = {"available": False, "reason": "去重 Python 缺少 ONNX 运行依赖，请更新去重环境"}
        except Exception:
            # Do not leak proxy credentials, paths or native exception text to the API.
            try:
                verify_weights(root, name)
            except (OSError, RuntimeError) as error:
                reason = str(error) if isinstance(error, RuntimeError) else "过滤模型不可读取"
            else:
                reason = "过滤模型加载或 CPU 推理校验失败，请更新去重环境并重新准备模型"
            result[name] = {"available": False, "reason": reason}
        else:
            result[name] = {"available": True, "reason": ""}
    return result


HF_OFFICIAL = "https://huggingface.co"


def mirrored_url(url: str, endpoint: str | None = None) -> str:
    """HF 直链换成镜像地址；文件仍按登记的 sha256 校验，镜像不可信也无妨。"""

    endpoint = (endpoint if endpoint is not None else os.environ.get("HF_ENDPOINT", "")).strip().rstrip("/")
    if endpoint and url.startswith(HF_OFFICIAL + "/"):
        return endpoint + url[len(HF_OFFICIAL):]
    return url


def main() -> int:
    parser = argparse.ArgumentParser(description="准备或离线验证 LDOS 过滤模型")
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument("--models", required=True, nargs="+", choices=tuple(MODEL_FILES))
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--dedup-dir", type=Path)
    args = parser.parse_args()
    names = list(dict.fromkeys(args.models))
    if args.prepare:
        # Fail before downloading if the configured dedup environment is incomplete.
        import onnxruntime  # noqa: F401
        if args.dedup_dir is None:
            parser.error("准备模型必须提供受信去重脚本目录")
        sys.path.insert(0, str(args.dedup_dir))
        from dedup_models import download_file
        for name in names:
            for path, (_filename, _size, sha256, url) in zip(model_paths(args.model_dir, name), MODEL_FILES[name]):
                download_file(mirrored_url(url), path, sha256)
    result = check_models(args.model_dir, names)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if all(item["available"] for item in result.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
