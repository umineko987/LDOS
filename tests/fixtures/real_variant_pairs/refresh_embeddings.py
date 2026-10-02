#!/usr/bin/env python3
"""Refresh or verify model embeddings for the real-variant fixture."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np


FIXTURE_ROOT = Path(__file__).resolve().parent
ROOT = FIXTURE_ROOT.parents[2]
if str(ROOT / "dedup") not in sys.path:
    sys.path.insert(0, str(ROOT / "dedup"))

from dedup_models import (  # noqa: E402
    DINO_REPOSITORY,
    DINO_SHA256,
    SSCD_SHA256,
    SSCD_URL,
    DeepEmbeddingExtractor,
)
from generate import IMAGE_NAMES, check_fixtures  # noqa: E402


EMBEDDINGS_NAME = "embeddings.json"
MODEL_METADATA = {
    "sscd": {
        "artifact_sha256": SSCD_SHA256,
        "source": SSCD_URL,
        "vector_key": "sscd_embedding",
    },
    "dino": {
        "artifact_sha256": DINO_SHA256,
        "source": DINO_REPOSITORY,
        "vector_key": "dino_embedding",
    },
}


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _calculate_embeddings(model_dir: Path) -> dict[str, dict[str, list[float]]]:
    import importlib.util

    specification = importlib.util.spec_from_file_location(
        "dedup_fixture_refresh",
        ROOT / "dedup" / "dedup_core.py",
    )
    module = importlib.util.module_from_spec(specification)
    assert specification.loader is not None
    specification.loader.exec_module(module)

    infos = [module.get_image_info(str(FIXTURE_ROOT / name)) for name in IMAGE_NAMES]
    extractor = DeepEmbeddingExtractor(model_dir, device="cpu", batch_size=len(infos))
    try:
        for model_name, metadata in MODEL_METADATA.items():
            vectors = extractor.encode_infos(infos, model_name)
            for info, vector in zip(infos, vectors):
                info[metadata["vector_key"]] = np.asarray(vector, dtype=np.float32)
    finally:
        extractor.close()

    return {
        name: {
            metadata["vector_key"]: [float(value) for value in info[metadata["vector_key"]]]
            for metadata in MODEL_METADATA.values()
        }
        for name, info in zip(IMAGE_NAMES, infos)
    }


def _embedding_document(vectors: dict[str, dict[str, list[float]]]) -> dict:
    return {
        "schema_version": 1,
        "dtype": "float32",
        "normalization": "L2 unit vectors emitted by the pinned model adapters",
        "models": MODEL_METADATA,
        "vectors": vectors,
    }


def _write_json(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _write_manifest() -> None:
    files = {}
    roles = {
        "recolored-sketch-a.png": "source image for the recolored outline pair",
        "recolored-sketch-b.png": "recolored image for the L1-SSCD pair",
        "structure-color.png": "color image for the structural pair",
        "structure-gray.png": "grayscale structural variant for the L2 pair",
        EMBEDDINGS_NAME: "pinned SSCD and DINOv2 outputs for clean-checkout tests",
    }
    for name, role in roles.items():
        path = FIXTURE_ROOT / name
        files[name] = {
            "bytes": path.stat().st_size,
            "role": role,
            "sha256": _sha256(path),
        }

    manifest = {
        "schema_version": 1,
        "license": {
            "spdx": "MIT",
            "notice": "Copyright (c) 2026 LDOS contributors; see ../../../LICENSE",
        },
        "origin": (
            "All four images are original deterministic drawings rendered by generate.py. "
            "No downloaded or user-owned image is included. Model weights are not redistributed."
        ),
        "reproduction": {
            "images": "./.venv/bin/python tests/fixtures/real_variant_pairs/generate.py",
            "embeddings": (
                "./.venv/bin/python tests/fixtures/real_variant_pairs/"
                "refresh_embeddings.py --model-dir .models"
            ),
        },
        "models": MODEL_METADATA,
        "pairs": {
            "recolored-sketch": {
                "files": ["recolored-sketch-a.png", "recolored-sketch-b.png"],
                "expected_level": "L1-SSCD",
            },
            "color-grayscale-structure": {
                "files": ["structure-color.png", "structure-gray.png"],
                "expected_level": "L2-结构",
            },
        },
        "files": files,
    }
    _write_json(FIXTURE_ROOT / "manifest.json", manifest)


def refresh(model_dir: Path) -> None:
    vectors = _calculate_embeddings(model_dir)
    _write_json(FIXTURE_ROOT / EMBEDDINGS_NAME, _embedding_document(vectors))
    _write_manifest()
    print("real-variant embeddings and manifest refreshed")


def check(model_dir: Path) -> None:
    check_fixtures(FIXTURE_ROOT)
    committed = json.loads((FIXTURE_ROOT / EMBEDDINGS_NAME).read_text(encoding="utf-8"))
    actual = _calculate_embeddings(model_dir)
    for name in IMAGE_NAMES:
        for metadata in MODEL_METADATA.values():
            key = metadata["vector_key"]
            expected_vector = np.asarray(committed["vectors"][name][key], dtype=np.float32)
            actual_vector = np.asarray(actual[name][key], dtype=np.float32)
            if expected_vector.shape != actual_vector.shape:
                raise SystemExit(
                    f"embedding shape mismatch for {name}/{key}: "
                    f"{expected_vector.shape} != {actual_vector.shape}"
                )
            similarity = float(np.dot(expected_vector, actual_vector))
            if similarity < 0.9999:
                raise SystemExit(
                    f"embedding drift for {name}/{key}: cosine={similarity:.8f}"
                )
    print("real-variant embeddings match the pinned models (cosine >= 0.9999)")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, default=ROOT / ".models")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check(args.model_dir)
    else:
        refresh(args.model_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
