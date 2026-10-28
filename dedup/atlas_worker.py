"""语义地图（atlas）计算 worker。

后端以子进程调用（后端 venv 没有 numpy）。读一个 JSON 任务，写出 ``atlas.json`` 和
缩略图雪碧图；不新增依赖，只用 numpy / Pillow 与 dedup_models 里现成的 DINOv2 提取器
和嵌入缓存（按文件 sha256 缓存，与去重共用 ``<model-dir>/embeddings.sqlite3``）。

用法：
  python dedup/atlas_worker.py --job JOB.json [--output-dir DIR] [--model-dir DIR]
      [--device auto|cpu|cuda] [--workers N] [--deep-batch-size N] [--torch-threads N]
  python dedup/atlas_worker.py --job - < JOB.json

任务 JSON（schema_version 1）::

  {
    "schema_version": 1,
    "output_dir": "/abs/dir",                  # 可被 --output-dir 覆盖
    "items": [
      {"asset_id": "a1", "path": "/abs/img.png",
       "sha256": "<64 位小写十六进制>" | null,   # null 时由 worker 计算
       "thumbnail_path": "/abs/thumb.webp"}     # 可选，只用来做雪碧图
    ],
    "options": {                               # 全部可选，缺省见 DEFAULT_OPTIONS
      "perplexity": 30, "iterations": 750, "exact_max": 1000, "clusters": null,
      "seed": 0, "knn": 10, "sprites": true, "sprite_format": "webp"
    }
  }

stdout 只输出 JSON 行（人类可读日志与 tqdm 走 stderr）::

  {"type": "start", "items": N}
  {"type": "progress", "stage": "read" | "embed" | "layout", "done": d, "total": t}
  {"type": "stage", "stage": "pca" | "neighbors" | "layout" | "cluster" | "write"}
  {"type": "done", "output": "<dir>/atlas.json", "items": n, "skipped": m,
   "clusters": k, "method": "exact" | "approximate" | "trivial", "seconds": s}
  {"type": "error", "code": "invalid_job" | "model_unavailable" | "output_unwritable" | "internal",
   "message": "..."}

退出码：0 成功；2 任务无效；1 其他失败。atlas.json 最后原子写入，它存在即代表本次完成。

计算流程：嵌入（L2 归一化）→ PCA-50 → t-SNE 2D（n ≤ exact_max 用精确梯度，否则 kNN 稀疏 P
+ 网格 FFT 斥力近似；PCA 初始化，确定性）→ 球面 k-means（k 缺省 round(√n)，2..64）→
kNN 离群分数（PCA 空间里到最近 knn 个邻居的平均距离，取稳健 z 分数）。
输出格式见 build_atlas() 文档。
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import itertools
import json
import math
import os
import stat
import sys
import time
import traceback
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Iterable, Iterator

import numpy as np
from PIL import Image, ImageOps, features


SCHEMA_VERSION = 1
WORKSPACE_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL_DIR = WORKSPACE_DIR / ".models"
MAX_ITEMS = 200_000
SHEET_SIZE = 2048
CELL_SIZE = 64
SHEET_COLUMNS = SHEET_SIZE // CELL_SIZE
CELLS_PER_SHEET = SHEET_COLUMNS * SHEET_COLUMNS
# 与工作台面板底色一致（#181b20），雪碧图空格和透明图都垫这个颜色。
SPRITE_BACKGROUND = (0x18, 0x1B, 0x20)
PCA_DIMS = 50
VECTOR_DIMS = 32
EMBED_CHUNK = 64
EARLY_EXAGGERATION = 12.0
EARLY_ITERATIONS = 250
EXACT_LIMIT = 5000
OUTLIER_Z = 3.5
# 离群分数 = 1 - exp(-max(z, 0) / 3)；z ≥ 3.5（常用的稳健 z 阈值）即视为离群。
OUTLIER_THRESHOLD = round(1.0 - math.exp(-OUTLIER_Z / 3.0), 4)

DEFAULT_OPTIONS: dict[str, Any] = {
    "perplexity": 30.0,
    "iterations": 750,
    "exact_max": 1000,
    "clusters": None,
    "seed": 0,
    "knn": 10,
    "sprites": True,
    "sprite_format": "webp",
}


class JobError(ValueError):
    """任务内容无效（退出码 2）。"""


class WorkerError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Reporter:
    """JSON 行事件输出；stream=None 时静默（进程内调用/测试）。"""

    def __init__(self, stream: Any = None) -> None:
        self.stream = stream
        self._last: dict[str, int] = {}

    def emit(self, payload: dict[str, Any]) -> None:
        if self.stream is None:
            return
        self.stream.write(json.dumps(payload, ensure_ascii=False, allow_nan=False) + "\n")
        self.stream.flush()

    def progress(self, stage: str, done: int, total: int) -> None:
        # 逐项输出太密：每 5% 或完成时打点
        step = max(1, total // 20)
        if done < total and done - self._last.get(stage, -step) < step:
            return
        self._last[stage] = done
        self.emit({"type": "progress", "stage": stage, "done": done, "total": total})

    def stage(self, name: str) -> None:
        self.emit({"type": "stage", "stage": name})


# ---- 任务解析 ----

def _absolute_path(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or "\0" in value or not os.path.isabs(value):
        raise JobError(f"{field} 必须是绝对路径")
    return value


def _option(options: dict[str, Any], key: str, kind: type, low: float, high: float) -> Any:
    value = options[key]
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise JobError(f"options.{key} 必须是数字")
    if kind is int and (isinstance(value, float) and not value.is_integer()):
        raise JobError(f"options.{key} 必须是整数")
    value = kind(value)
    if not (low <= value <= high) or (isinstance(value, float) and not math.isfinite(value)):
        raise JobError(f"options.{key} 必须在 {low}..{high} 之间")
    return value


def parse_job(payload: Any, *, output_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise JobError("任务必须是 JSON 对象")
    if payload.get("schema_version", SCHEMA_VERSION) != SCHEMA_VERSION:
        raise JobError(f"不支持的任务版本: {payload.get('schema_version')}")
    raw_items = payload.get("items")
    if not isinstance(raw_items, list) or len(raw_items) > MAX_ITEMS:
        raise JobError(f"items 必须是不超过 {MAX_ITEMS} 项的数组")
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise JobError("items 的每一项必须是对象")
        asset_id = raw.get("asset_id")
        if not isinstance(asset_id, str) or not 1 <= len(asset_id) <= 128:
            raise JobError("asset_id 必须是 1..128 个字符的字符串")
        if asset_id in seen:
            raise JobError(f"asset_id 重复: {asset_id}")
        seen.add(asset_id)
        sha256 = raw.get("sha256")
        if sha256 is not None:
            if not isinstance(sha256, str) or len(sha256) != 64:
                raise JobError(f"sha256 无效: {asset_id}")
            sha256 = sha256.lower()
            if any(char not in "0123456789abcdef" for char in sha256):
                raise JobError(f"sha256 无效: {asset_id}")
        thumbnail = raw.get("thumbnail_path")
        items.append({
            "asset_id": asset_id,
            "path": _absolute_path(raw.get("path"), "path"),
            "sha256": sha256,
            "thumbnail_path": None if thumbnail is None else _absolute_path(thumbnail, "thumbnail_path"),
        })

    raw_options = payload.get("options") or {}
    if not isinstance(raw_options, dict):
        raise JobError("options 必须是对象")
    unknown = set(raw_options) - set(DEFAULT_OPTIONS)
    if unknown:
        raise JobError(f"未知的选项: {', '.join(sorted(unknown))}")
    options = {**DEFAULT_OPTIONS, **raw_options}
    options["perplexity"] = _option(options, "perplexity", float, 2, 100)
    options["iterations"] = _option(options, "iterations", int, 100, 5000)
    # 精确路径要几个 n×n 矩阵：5000 点约 1.5 GB 已是上限
    options["exact_max"] = _option(options, "exact_max", int, 0, EXACT_LIMIT)
    options["seed"] = _option(options, "seed", int, 0, 2**31 - 1)
    options["knn"] = _option(options, "knn", int, 2, 50)
    if options["clusters"] is not None:
        options["clusters"] = _option(options, "clusters", int, 1, 256)
    if not isinstance(options["sprites"], bool):
        raise JobError("options.sprites 必须是布尔值")
    if options["sprite_format"] not in ("webp", "png"):
        raise JobError("options.sprite_format 必须是 webp 或 png")

    target = os.fspath(output_dir) if output_dir is not None else payload.get("output_dir")
    return {
        "items": items,
        "options": options,
        "output_dir": _absolute_path(target, "output_dir"),
    }


def input_digest(job: dict[str, Any]) -> str:
    """输入摘要：资源集合（asset_id + sha256）与影响结果的选项。"""

    digest = hashlib.sha256()
    for item in sorted(job["items"], key=lambda item: item["asset_id"]):
        digest.update(f"{item['asset_id']}\0{item['sha256'] or ''}\n".encode("utf-8"))
    digest.update(json.dumps(job["options"], sort_keys=True).encode("utf-8"))
    return digest.hexdigest()


# ---- 输出目录与原子写入 ----

def _reject_symlinks(path: Path) -> None:
    for candidate in (*reversed(path.parents), path):
        if candidate.is_symlink():
            raise WorkerError("output_unwritable", f"输出路径不能包含符号链接: {candidate}")


def prepare_output_dir(value: str) -> Path:
    path = Path(os.path.abspath(value))
    _reject_symlinks(path)
    try:
        existed = path.exists()
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        # 只收紧 worker 新建的目录；已有目录保留调用方的权限策略。
        if not existed:
            path.chmod(0o700)
        sprites = path / "sprites"
        _reject_symlinks(sprites)
        sprites.mkdir(mode=0o700, exist_ok=True)
        for stale in sprites.glob("sheet-*"):
            if stale.is_file() and not stale.is_symlink():
                stale.unlink()
    except OSError as error:
        raise WorkerError("output_unwritable", f"无法准备输出目录: {error}") from error
    return path


def _atomic_write(path: Path, write: Callable[[Any], None]) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | int(getattr(os, "O_NOFOLLOW", 0))
    try:
        descriptor = os.open(temporary, flags, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            write(handle)
        _reject_symlinks(path)
        os.replace(temporary, path)
    except OSError as error:
        temporary.unlink(missing_ok=True)
        raise WorkerError("output_unwritable", f"写入失败: {path.name}: {error}") from error


# ---- 读图与雪碧图 ----

def make_cell(source: Any) -> Image.Image:
    """把一张图裁成 CELL_SIZE 正方形（居中 cover 裁剪），透明区域垫底色。"""

    with Image.open(source) as opened:
        opened.draft("RGB", (CELL_SIZE * 2, CELL_SIZE * 2))
        image = ImageOps.exif_transpose(opened)
        if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
            rgba = image.convert("RGBA")
            canvas = Image.new("RGBA", rgba.size, SPRITE_BACKGROUND + (255,))
            canvas.alpha_composite(rgba)
            image = canvas.convert("RGB")
        else:
            image = image.convert("RGB")
    width, height = image.size
    if width <= 0 or height <= 0:
        raise ValueError("图片尺寸无效")
    scale = CELL_SIZE / min(width, height)
    size = (max(CELL_SIZE, round(width * scale)), max(CELL_SIZE, round(height * scale)))
    image = image.resize(size, Image.Resampling.BICUBIC, reducing_gap=3.0)
    left = (size[0] - CELL_SIZE) // 2
    top = (size[1] - CELL_SIZE) // 2
    return image.crop((left, top, left + CELL_SIZE, top + CELL_SIZE))


class SpriteWriter:
    """按顺序把格子拼进 SHEET_SIZE² 的雪碧图，写满一张就落盘。"""

    def __init__(self, directory: Path, image_format: str) -> None:
        if image_format == "webp" and not features.check("webp"):
            image_format = "png"
        self.directory = directory
        self.format = image_format
        self.sheets: list[str] = []
        self.count = 0
        self._current: Image.Image | None = None

    def add(self, cell: Image.Image) -> tuple[int, int]:
        sheet, slot = divmod(self.count, CELLS_PER_SHEET)
        if slot == 0:
            self._flush()
            self._current = Image.new("RGB", (SHEET_SIZE, SHEET_SIZE), SPRITE_BACKGROUND)
        assert self._current is not None
        x = (slot % SHEET_COLUMNS) * CELL_SIZE
        y = (slot // SHEET_COLUMNS) * CELL_SIZE
        self._current.paste(cell, (x, y))
        self.count += 1
        return sheet, slot

    def _flush(self) -> None:
        if self._current is None:
            return
        name = f"sheet-{len(self.sheets):04d}.{self.format}"
        image = self._current

        def write(handle: Any) -> None:
            if self.format == "webp":
                image.save(handle, "WEBP", quality=82, method=4)
            else:
                image.save(handle, "PNG", compress_level=6)

        _atomic_write(self.directory / name, write)
        self.sheets.append(f"sprites/{name}")
        self._current = None

    def close(self) -> None:
        self._flush()

    def describe(self) -> dict[str, Any]:
        return {
            "format": self.format,
            "sheet_size": SHEET_SIZE,
            "cell_size": CELL_SIZE,
            "columns": SHEET_COLUMNS,
            "per_sheet": CELLS_PER_SHEET,
            "sheets": list(self.sheets),
        }


def _read_item(item: dict[str, Any], need_hash: bool, sprites: bool) -> dict[str, Any]:
    path = item["path"]
    try:
        info = os.lstat(path)
    except OSError:
        return {"status": "missing"}
    if not stat.S_ISREG(info.st_mode):
        return {"status": "missing"}
    data: bytes | None = None
    sha256 = item["sha256"]
    if need_hash:
        try:
            data = Path(path).read_bytes()
        except OSError:
            return {"status": "missing"}
        actual = hashlib.sha256(data).hexdigest()
        if sha256 is not None and sha256 != actual:
            return {"status": "changed"}
        sha256 = actual
    cell = None
    if sprites:
        if item["thumbnail_path"]:
            try:
                cell = make_cell(item["thumbnail_path"])
            except Exception:
                cell = None
        if cell is None:
            try:
                if data is None:
                    data = Path(path).read_bytes()
                cell = make_cell(io.BytesIO(data))
            except Exception:
                return {"status": "unreadable"}
    return {"status": "ok", "sha256": sha256, "cell": cell}


def _ordered_map(function: Callable[[Any], Any], values: Iterable[Any], workers: int) -> Iterator[Any]:
    """线程池按输入顺序产出结果；在途任务有上限，避免解码结果无界堆积。"""

    window = max(1, workers) * 8
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        iterator = iter(values)
        pending = deque(pool.submit(function, value) for value in itertools.islice(iterator, window))
        while pending:
            future = pending.popleft()
            yield future.result()
            for value in itertools.islice(iterator, 1):
                pending.append(pool.submit(function, value))


# ---- 数值部分 ----

def normalize_rows(matrix: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return matrix / norms


def pca(matrix: np.ndarray, dims: int) -> np.ndarray:
    """中心化后投影到前 dims 个主成分；每个主成分绝对值最大的载荷取正号，结果确定。"""

    count, width = matrix.shape
    dims = max(0, min(dims, width, count - 1))
    if dims == 0:
        return np.zeros((count, 0))
    centered = matrix - matrix.mean(axis=0)
    covariance = centered.T @ centered / max(count - 1, 1)
    values, vectors = np.linalg.eigh(covariance)
    order = np.argsort(values)[::-1][:dims]
    components = vectors[:, order].T
    pivots = np.abs(components).argmax(axis=1)
    signs = np.sign(components[np.arange(dims), pivots])
    signs[signs == 0] = 1.0
    return centered @ (components * signs[:, None]).T


def _squared_distances(left: np.ndarray, right: np.ndarray) -> np.ndarray:
    distances = (left * left).sum(1)[:, None] + (right * right).sum(1)[None, :] - 2.0 * (left @ right.T)
    np.maximum(distances, 0.0, out=distances)
    return distances


def nearest_neighbors(points: np.ndarray, k: int, block: int = 1024) -> tuple[np.ndarray, np.ndarray]:
    """暴力分块 kNN（不含自身）。返回 (索引, 平方距离)，每行按 (距离, 索引) 升序。"""

    count = len(points)
    k = min(k, count - 1)
    indices = np.empty((count, k), dtype=np.int64)
    distances = np.empty((count, k))
    for start in range(0, count, block):
        stop = min(count, start + block)
        block_distances = _squared_distances(points[start:stop], points)
        block_distances[np.arange(stop - start), np.arange(start, stop)] = np.inf
        part = np.argpartition(block_distances, k - 1, axis=1)[:, :k]
        part_distances = np.take_along_axis(block_distances, part, axis=1)
        order = np.lexsort((part, part_distances), axis=1)
        indices[start:stop] = np.take_along_axis(part, order, axis=1)
        distances[start:stop] = np.take_along_axis(part_distances, order, axis=1)
    return indices, distances


def conditional_probabilities(squared: np.ndarray, perplexity: float) -> np.ndarray:
    """逐行二分高斯带宽，使条件分布的困惑度等于 perplexity；inf 视为不相邻。"""

    finite = np.isfinite(squared)
    row_min = np.where(finite, squared, np.inf).min(axis=1, keepdims=True)
    shifted = np.where(finite, squared - row_min, np.inf)
    weights_basis = np.where(finite, shifted, 0.0)
    target = math.log(perplexity)
    count = squared.shape[0]
    beta = np.ones(count)
    low = np.zeros(count)
    high = np.full(count, np.inf)
    probabilities = np.zeros_like(squared)
    for _ in range(100):
        probabilities = np.exp(-shifted * beta[:, None])
        total = np.maximum(probabilities.sum(axis=1), 1e-300)
        entropy = np.log(total) + beta * (weights_basis * probabilities).sum(axis=1) / total
        difference = entropy - target
        if np.all(np.abs(difference) < 1e-5):
            break
        too_flat = difference > 0
        low = np.where(too_flat, beta, low)
        high = np.where(too_flat, high, beta)
        beta = np.where(
            too_flat,
            np.where(np.isinf(high), beta * 2.0, (beta + high) / 2.0),
            (beta + low) / 2.0,
        )
    return probabilities / np.maximum(probabilities.sum(axis=1, keepdims=True), 1e-300)


def _initial_layout(features_: np.ndarray) -> np.ndarray:
    layout = np.zeros((len(features_), 2))
    width = min(2, features_.shape[1])
    layout[:, :width] = features_[:, :width]
    scale = layout[:, 0].std()
    return layout / scale * 1e-4 if scale > 0 else layout


def _optimize(
    layout: np.ndarray,
    gradient: Callable[[np.ndarray, float], np.ndarray],
    iterations: int,
    learning_rate: float,
    reporter: Reporter,
) -> np.ndarray:
    early = min(EARLY_ITERATIONS, iterations // 3)
    update = np.zeros_like(layout)
    gains = np.ones_like(layout)
    for iteration in range(iterations):
        if iteration == early:
            # 与 sklearn 一致：退出早期夸大阶段时重置动量与增益
            update = np.zeros_like(layout)
            gains = np.ones_like(layout)
        exaggeration = EARLY_EXAGGERATION if iteration < early else 1.0
        momentum = 0.5 if iteration < early else 0.8
        grad = gradient(layout, exaggeration)
        increase = update * grad < 0.0
        gains = np.where(increase, gains + 0.2, gains * 0.8)
        np.maximum(gains, 0.01, out=gains)
        update = momentum * update - learning_rate * gains * grad
        layout = layout + update
        layout -= layout.mean(axis=0)
        reporter.progress("layout", iteration + 1, iterations)
    return layout


_WORKERS = max(1, min(8, os.cpu_count() or 1))
_POOL: ThreadPoolExecutor | None = None


def _pool() -> ThreadPoolExecutor:
    """数值计算线程池：numpy 的逐元素运算与 FFT 会释放 GIL，按行分块并行。"""

    global _POOL
    if _POOL is None:
        _POOL = ThreadPoolExecutor(max_workers=_WORKERS)
    return _POOL


def _row_blocks(count: int, size: int = 256) -> list[tuple[int, int]]:
    # 分块大小固定（与 CPU 数无关），浮点求和顺序因此在不同机器上一致。
    return [(start, min(count, start + size)) for start in range(0, count, size)]


def exact_gradient_factory(joint: np.ndarray) -> Callable[[np.ndarray, float], np.ndarray]:
    """精确 O(n²) 梯度：float32 n×n 核矩阵，两遍按行分块（先求 Z，再求梯度）。"""

    count = len(joint)
    joint32 = joint.astype(np.float32)
    kernel = np.empty((count, count), dtype=np.float32)
    blocks = _row_blocks(count)

    def gradient(layout: np.ndarray, exaggeration: float) -> np.ndarray:
        points = layout.astype(np.float32)

        def fill(bounds: tuple[int, int]) -> float:
            start, stop = bounds
            block = kernel[start:stop]
            dx = points[start:stop, 0, None] - points[None, :, 0]
            dy = points[start:stop, 1, None] - points[None, :, 1]
            np.multiply(dx, dx, out=block)
            dy *= dy
            block += dy
            block += 1.0
            np.reciprocal(block, out=block)
            block[np.arange(stop - start), np.arange(start, stop)] = 0.0
            return float(block.sum(dtype=np.float64))

        normalizer = sum(_pool().map(fill, blocks))
        inverse = np.float32(1.0 / normalizer)
        scale = np.float32(exaggeration)
        result = np.empty_like(layout)

        def apply(bounds: tuple[int, int]) -> None:
            start, stop = bounds
            block = kernel[start:stop]
            weights = joint32[start:stop] * scale
            weights -= block * inverse
            weights *= block
            result[start:stop] = (
                weights.sum(axis=1, dtype=np.float64)[:, None] * layout[start:stop]
                - (weights @ points).astype(np.float64)
            )

        list(_pool().map(apply, blocks))
        return 4.0 * result

    return gradient


class GridRepulsion:
    """网格 FFT 近似斥力（particle-mesh，CIC 分配/插值）。

    返回 (R, Z)：R_i ≈ Σ_j w_ij² (y_i - y_j)，Z ≈ Σ_{i≠j} w_ij，w = 1 / (1 + r²)。
    奇核与对称的 CIC 分配/插值使自身斥力严格为 0。网格步长取离散值、节点数取 16 的倍数，
    使核的 FFT 可以跨迭代缓存。
    """

    def __init__(self, spacing: float = 0.3, max_nodes: int = 384) -> None:
        self.spacing = spacing
        self.max_nodes = max_nodes
        self._kernels: dict[tuple[int, float], tuple[np.ndarray, ...]] = {}

    def _geometry(self, span: float) -> tuple[int, float]:
        step = self.spacing
        if math.ceil(span / step) + 3 > self.max_nodes:
            ratio = span / (self.max_nodes - 3) / self.spacing
            step = self.spacing * 1.05 ** math.ceil(math.log(ratio) / math.log(1.05))
        needed = math.ceil(span / step) + 3
        nodes = min(self.max_nodes, max(32, -(-needed // 16) * 16))
        return nodes, round(step, 9)

    def _kernel_transforms(self, nodes: int, step: float) -> tuple[np.ndarray, ...]:
        key = (nodes, step)
        cached = self._kernels.get(key)
        if cached is None:
            padded = 2 * nodes
            offsets = np.arange(padded)
            offsets = (np.where(offsets < nodes, offsets, offsets - padded) * step).astype(np.float32)
            offset_x = offsets[:, None]
            offset_y = offsets[None, :]
            kernel = 1.0 / (1.0 + offset_x * offset_x + offset_y * offset_y)
            squared = kernel * kernel
            cached = tuple(_pool().map(np.fft.rfft2, (kernel, offset_x * squared, offset_y * squared)))
            if len(self._kernels) >= 4:
                self._kernels.pop(next(iter(self._kernels)))
            self._kernels[key] = cached
        return cached

    def __call__(self, layout: np.ndarray) -> tuple[np.ndarray, float]:
        count = len(layout)
        low = layout.min(axis=0)
        high = layout.max(axis=0)
        nodes, step = self._geometry(float((high - low).max()))
        padded = 2 * nodes
        origin = (low + high) / 2.0 - (nodes - 1) * step / 2.0
        grid = (layout - origin) / step
        base = np.floor(grid).astype(np.int64)
        fraction = grid - base
        corners = []
        for dx in (0, 1):
            for dy in (0, 1):
                weight = (fraction[:, 0] if dx else 1.0 - fraction[:, 0]) * (fraction[:, 1] if dy else 1.0 - fraction[:, 1])
                corners.append(((base[:, 0] + dx) * padded + (base[:, 1] + dy), weight))
        density = np.zeros(padded * padded)
        for index, weight in corners:
            density += np.bincount(index, weights=weight, minlength=padded * padded)
        density_hat = np.fft.rfft2(density.reshape(padded, padded).astype(np.float32))

        def field(transform: np.ndarray) -> np.ndarray:
            flat = np.fft.irfft2(density_hat * transform, s=(padded, padded)).reshape(-1)
            return sum(flat[index].astype(np.float64) * weight for index, weight in corners)

        potential, force_x, force_y = _pool().map(field, self._kernel_transforms(nodes, step))
        normalizer = max(float(potential.sum()) - count, 1e-12)
        return np.stack([force_x, force_y], axis=1), normalizer


def sparse_joint_probabilities(indices: np.ndarray, squared: np.ndarray, perplexity: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    count, k = indices.shape
    conditional = conditional_probabilities(squared, perplexity)
    rows = np.repeat(np.arange(count, dtype=np.int64), k)
    cols = indices.reshape(-1)
    values = conditional.reshape(-1)
    keys = np.concatenate([rows * count + cols, cols * count + rows])
    weights = np.concatenate([values, values])
    unique, inverse = np.unique(keys, return_inverse=True)
    summed = np.bincount(inverse, weights=weights) / (2.0 * count)
    return unique // count, unique % count, summed


def approximate_gradient_factory(rows: np.ndarray, cols: np.ndarray, values: np.ndarray, count: int):
    """稀疏 kNN 吸引力 + 网格 FFT 斥力。rows 已升序且每行至少一条边（kNN 对称化保证）。"""

    repulsion_field = GridRepulsion()
    starts = np.searchsorted(rows, np.arange(count + 1))
    blocks = _row_blocks(count)

    def gradient(layout: np.ndarray, exaggeration: float) -> np.ndarray:
        x = np.ascontiguousarray(layout[:, 0])
        y = np.ascontiguousarray(layout[:, 1])
        attraction = np.empty_like(layout)

        def attract(bounds: tuple[int, int]) -> None:
            start, stop = bounds
            low, high = starts[start], starts[stop]
            neighbours = cols[low:high]
            repeats = np.diff(starts[start : stop + 1])
            dx = np.repeat(x[start:stop], repeats) - x.take(neighbours)
            dy = np.repeat(y[start:stop], repeats) - y.take(neighbours)
            weight = values[low:high] / (1.0 + dx * dx + dy * dy)
            offsets = starts[start:stop] - low
            attraction[start:stop, 0] = np.add.reduceat(weight * dx, offsets)
            attraction[start:stop, 1] = np.add.reduceat(weight * dy, offsets)

        # 斥力在调用线程计算（其内部也用线程池），避免线程池任务互相等待。
        pending = [_pool().submit(attract, bounds) for bounds in blocks]
        repulsion, normalizer = repulsion_field(layout)
        for future in pending:
            future.result()
        return 4.0 * (exaggeration * attraction - repulsion / normalizer)

    return gradient


def tsne(
    features_: np.ndarray,
    *,
    perplexity: float,
    iterations: int,
    exact_max: int,
    reporter: Reporter,
    neighbors: tuple[np.ndarray, np.ndarray] | None = None,
) -> tuple[np.ndarray, str]:
    count = len(features_)
    if count <= 3:
        layout = np.zeros((count, 2))
        width = min(2, features_.shape[1])
        layout[:, :width] = features_[:, :width]
        return layout, "trivial"
    perplexity = max(1.0, min(perplexity, (count - 1) / 3.0))
    learning_rate = max(count / EARLY_EXAGGERATION / 4.0, 50.0)
    layout = _initial_layout(features_)
    if count <= exact_max:
        squared = _squared_distances(features_, features_)
        np.fill_diagonal(squared, np.inf)
        conditional = conditional_probabilities(squared, perplexity)
        joint = (conditional + conditional.T) / (2.0 * count)
        gradient = exact_gradient_factory(joint)
        method = "exact"
    else:
        k = min(count - 1, max(int(3 * perplexity), 2))
        if neighbors is None or neighbors[0].shape[1] < k:
            neighbors = nearest_neighbors(features_, k)
        indices, squared = neighbors[0][:, :k], neighbors[1][:, :k]
        rows, cols, values = sparse_joint_probabilities(indices, squared, perplexity)
        gradient = approximate_gradient_factory(rows, cols, values, count)
        method = "approximate"
    reporter.stage("layout")
    layout = _optimize(layout, gradient, iterations, learning_rate, reporter)
    return layout, method


def _distinct_rows(matrix: np.ndarray) -> int:
    return len(np.unique(np.round(matrix, 6), axis=0))


def _kmeans_plus_plus(vectors: np.ndarray, k: int, rng: np.random.Generator) -> np.ndarray:
    count = len(vectors)
    chosen = [int(rng.integers(count))]
    closest = np.maximum(1.0 - vectors @ vectors[chosen[0]], 0.0)
    for _ in range(1, k):
        weights = closest * closest
        total = weights.sum()
        index = int(rng.integers(count)) if total <= 0 else int(rng.choice(count, p=weights / total))
        chosen.append(index)
        closest = np.minimum(closest, np.maximum(1.0 - vectors @ vectors[index], 0.0))
    return vectors[chosen].copy()


def spherical_kmeans(vectors: np.ndarray, k: int, seed: int, restarts: int = 4, max_iter: int = 100) -> np.ndarray:
    """余弦 k-means（k-means++ 初始化，多次重启取目标最优）。返回按簇大小降序重排后的标签。"""

    count = len(vectors)
    if k <= 1 or count <= 1:
        return np.zeros(count, dtype=np.int64)
    best_labels = None
    best_score = -np.inf
    for restart in range(restarts):
        rng = np.random.default_rng(seed + restart)
        centers = _kmeans_plus_plus(vectors, k, rng)
        labels = None
        for _ in range(max_iter):
            similarity = vectors @ centers.T
            assigned = similarity.argmax(axis=1)
            if labels is not None and np.array_equal(assigned, labels):
                break
            labels = assigned
            membership = np.zeros((k, count))
            membership[labels, np.arange(count)] = 1.0
            sums = membership @ vectors
            empty = np.flatnonzero(membership.sum(axis=1) == 0)
            if len(empty):
                # 空簇改用离自己簇心最远的点重新起步
                fit = similarity[np.arange(count), labels]
                for cluster, index in zip(empty, np.argsort(fit, kind="stable")[: len(empty)]):
                    sums[cluster] = vectors[index]
            centers = normalize_rows(sums)
        similarity = vectors @ centers.T
        labels = similarity.argmax(axis=1)
        score = float(similarity[np.arange(count), labels].sum())
        if score > best_score + 1e-9:
            best_score = score
            best_labels = labels
    assert best_labels is not None
    sizes = np.bincount(best_labels, minlength=k)
    first_member = np.full(k, count)
    np.minimum.at(first_member, best_labels, np.arange(count))
    present = [cluster for cluster in range(k) if sizes[cluster] > 0]
    order = sorted(present, key=lambda cluster: (-sizes[cluster], first_member[cluster]))
    mapping = np.zeros(k, dtype=np.int64)
    mapping[order] = np.arange(len(order))
    return mapping[best_labels]


def outlier_scores(neighbor_squared: np.ndarray, knn: int) -> np.ndarray:
    count = len(neighbor_squared)
    if count < 3 or neighbor_squared.shape[1] == 0:
        return np.zeros(count)
    distance = np.sqrt(neighbor_squared[:, :knn]).mean(axis=1)
    median = np.median(distance)
    spread = 1.4826 * np.median(np.abs(distance - median))
    if spread <= 1e-12:
        return np.zeros(count)
    z = np.maximum((distance - median) / spread, 0.0)
    return 1.0 - np.exp(-z / 3.0)


def quantize(vectors: np.ndarray) -> dict[str, Any]:
    """PCA-32 逐维 int8 量化：q = round(v / scale)，scale = max|v| / 127；还原 v ≈ q * scale。"""

    padded = np.zeros((len(vectors), VECTOR_DIMS))
    width = min(VECTOR_DIMS, vectors.shape[1])
    padded[:, :width] = vectors[:, :width]
    scales = np.abs(padded).max(axis=0) / 127.0 if len(padded) else np.zeros(VECTOR_DIMS)
    safe = np.where(scales > 0, scales, 1.0)
    quantized = np.clip(np.rint(padded / safe), -127, 127).astype(np.int8)
    return {
        "dims": VECTOR_DIMS,
        "dtype": "int8",
        "encoding": "base64",
        "order": "items",
        "scales": [float(value) for value in scales],
        "data": base64.b64encode(quantized.tobytes()).decode("ascii"),
    }


def default_cluster_count(count: int) -> int:
    return int(np.clip(round(math.sqrt(count)), 2, 64))


def analyze(embeddings: np.ndarray, options: dict[str, Any], reporter: Reporter) -> dict[str, Any]:
    """纯计算：嵌入矩阵 → 坐标、簇、离群分数、PCA-32。"""

    count = len(embeddings)
    vectors = normalize_rows(np.asarray(embeddings, dtype=np.float64))
    reporter.stage("pca")
    projected = pca(vectors, max(PCA_DIMS, VECTOR_DIMS))
    features_ = projected[:, :PCA_DIMS]
    neighbors = None
    neighbor_squared = np.zeros((count, 0))
    if count >= 2 and features_.shape[1] > 0:
        reporter.stage("neighbors")
        approximate = count > options["exact_max"] and count > 3
        k = options["knn"]
        if approximate:
            k = max(k, min(count - 1, int(3 * max(1.0, min(options["perplexity"], (count - 1) / 3.0)))))
        neighbors = nearest_neighbors(features_, k)
        neighbor_squared = neighbors[1]
    layout, method = tsne(
        features_ if features_.shape[1] else np.zeros((count, 1)),
        perplexity=options["perplexity"],
        iterations=options["iterations"],
        exact_max=options["exact_max"],
        reporter=reporter,
        neighbors=neighbors,
    )
    layout = layout - layout.mean(axis=0) if count else layout
    extent = float(np.abs(layout).max()) if count else 0.0
    if extent > 0:
        layout = layout / extent

    reporter.stage("cluster")
    if options["clusters"] is not None:
        k = options["clusters"]
    else:
        k = default_cluster_count(count)
    k = max(1, min(k, count, _distinct_rows(vectors) if count else 1))
    labels = spherical_kmeans(vectors, k, options["seed"]) if count else np.zeros(0, dtype=np.int64)
    scores = outlier_scores(neighbor_squared, options["knn"])
    return {
        "layout": layout,
        "method": method,
        "labels": labels,
        "vectors": vectors,
        "outliers": scores,
        "projected": projected[:, :VECTOR_DIMS],
    }


def build_atlas(
    records: list[dict[str, Any]],
    result: dict[str, Any],
    *,
    job: dict[str, Any],
    skipped: list[dict[str, str]],
    sprites: dict[str, Any] | None,
    timings: dict[str, float],
) -> dict[str, Any]:
    """atlas.json 结构（schema_version 1）：

    - ``items``：与 ``vectors`` 同序。每项 ``asset_id``、``sha256``、``x``/``y``（居中后按最大
      绝对值缩放到 [-1, 1]，纵横同比）、``cluster``（0 起，按簇大小降序）、``outlier``（0..1，
      ≥ ``params.outlier_threshold`` 视为离群）、``sprite``（``[sheet, cell]`` 或 null）。
    - ``clusters``：``id``、``size``、``share``、``medoid_asset_id``（离簇心最近的成员）、
      ``x``/``y``（成员坐标均值）。
    - ``vectors``：PCA-32 的 int8 量化，``data`` 为行主序 n×32 字节的 base64，v ≈ q * scales[d]。
    - ``sprites``：null 或 ``{format, sheet_size, cell_size, columns, per_sheet, sheets}``；格子
      cell 位于 ``((cell % columns) * cell_size, (cell // columns) * cell_size)``。
    - ``skipped``：``{asset_id, reason}``，reason ∈ missing / changed / unreadable。
    """

    layout = result["layout"]
    labels = result["labels"]
    vectors = result["vectors"]
    scores = result["outliers"]
    count = len(records)
    items = []
    for index, record in enumerate(records):
        items.append({
            "asset_id": record["asset_id"],
            "sha256": record["sha256"],
            "x": round(float(layout[index, 0]), 5),
            "y": round(float(layout[index, 1]), 5),
            "cluster": int(labels[index]),
            "outlier": round(float(scores[index]), 4),
            "sprite": list(record["sprite"]) if record["sprite"] is not None else None,
        })
    clusters = []
    cluster_count = int(labels.max()) + 1 if count else 0
    for cluster in range(cluster_count):
        members = np.flatnonzero(labels == cluster)
        centroid = normalize_rows(vectors[members].sum(axis=0, keepdims=True))[0]
        medoid = members[int(np.argmax(vectors[members] @ centroid))]
        clusters.append({
            "id": cluster,
            "size": int(len(members)),
            "share": round(len(members) / count, 6),
            "medoid_asset_id": records[medoid]["asset_id"],
            "x": round(float(layout[members, 0].mean()), 5),
            "y": round(float(layout[members, 1].mean()), 5),
        })
    options = job["options"]
    return {
        "schema_version": SCHEMA_VERSION,
        "generated_at": time.time(),
        "input_digest": input_digest(job),
        "method": result["method"],
        "params": {
            "perplexity": options["perplexity"],
            "iterations": options["iterations"],
            "exact_max": options["exact_max"],
            "clusters": cluster_count,
            "seed": options["seed"],
            "knn": options["knn"],
            "outlier_threshold": OUTLIER_THRESHOLD,
        },
        "counts": {
            "input": len(job["items"]),
            "items": count,
            "skipped": len(skipped),
            "clusters": cluster_count,
            "outliers": int((scores >= OUTLIER_THRESHOLD).sum()) if count else 0,
        },
        "items": items,
        "clusters": clusters,
        "vectors": quantize(result["projected"]),
        "sprites": sprites,
        "skipped": skipped,
        "timings_seconds": {key: round(value, 4) for key, value in timings.items()},
    }


# ---- 嵌入 ----

def _dedup_models():
    import dedup_models

    return dedup_models


def _embed_missing(
    records: list[dict[str, Any]],
    *,
    model_dir: Path,
    device: str,
    profile: Any,
    reporter: Reporter,
) -> tuple[dict[str, np.ndarray], set[str]]:
    from dedup_resources import configure_process_resources

    models = _dedup_models()
    configure_process_resources(profile)
    try:
        extractor = models.DeepEmbeddingExtractor(
            model_dir,
            device=device,
            batch_size=profile.deep_batch_size,
            use_sscd=False,
            use_dino=True,
            decode_workers=profile.model_decode_workers,
        )
    except Exception as error:
        raise WorkerError("model_unavailable", f"DINOv2 模型不可用: {error}") from error
    vectors: dict[str, np.ndarray] = {}
    failed: set[str] = set()
    total = len(records)
    try:
        for start in range(0, total, EMBED_CHUNK):
            chunk = records[start:start + EMBED_CHUNK]
            infos = [{"path": record["path"], "file_hash": record["sha256"]} for record in chunk]
            try:
                encoded = extractor.encode_all(infos, ["dino"])["dino"]
                for record, vector in zip(chunk, encoded):
                    vectors[record["sha256"]] = vector
            except Exception:
                # 一张坏图会让整批失败：逐张重试，只淘汰真正读不了的
                for record, info in zip(chunk, infos):
                    try:
                        vectors[record["sha256"]] = extractor.encode_all([info], ["dino"])["dino"][0]
                    except Exception:
                        failed.add(record["asset_id"])
            reporter.progress("embed", min(total, start + len(chunk)), total)
    finally:
        extractor.close()
    return vectors, failed


def run_job(
    job: dict[str, Any],
    *,
    model_dir: str | os.PathLike[str] = DEFAULT_MODEL_DIR,
    device: str = "auto",
    profile: Any = None,
    reporter: Reporter | None = None,
) -> dict[str, Any]:
    started = time.perf_counter()
    reporter = reporter or Reporter()
    timings: dict[str, float] = {}
    models = _dedup_models()
    if profile is None:
        from dedup_resources import build_resource_profile

        profile = build_resource_profile(device)
    items = job["items"]
    options = job["options"]
    output = prepare_output_dir(job["output_dir"])
    reporter.emit({"type": "start", "items": len(items)})

    root = models.model_root(model_dir)
    cache = models.EmbeddingCache(root / "embeddings.sqlite3")
    try:
        known: dict[str, np.ndarray] = {}
        for item in items:
            if item["sha256"] and item["sha256"] not in known:
                vector = cache.get(models.DINO_CACHE_KEY, item["sha256"])
                if vector is not None:
                    known[item["sha256"]] = vector

        stage_started = time.perf_counter()
        writer = SpriteWriter(output / "sprites", options["sprite_format"]) if options["sprites"] else None
        records: list[dict[str, Any]] = []
        skipped: list[dict[str, str]] = []

        def read(item: dict[str, Any]) -> dict[str, Any]:
            need_hash = item["sha256"] is None or item["sha256"] not in known
            return _read_item(item, need_hash, writer is not None)

        for done, (item, outcome) in enumerate(zip(items, _ordered_map(read, items, profile.workers)), 1):
            if outcome["status"] != "ok":
                skipped.append({"asset_id": item["asset_id"], "reason": outcome["status"]})
            else:
                sprite = writer.add(outcome["cell"]) if writer is not None else None
                records.append({
                    "asset_id": item["asset_id"],
                    "path": item["path"],
                    "sha256": outcome["sha256"],
                    "sprite": sprite,
                })
            reporter.progress("read", done, len(items))
        if writer is not None:
            writer.close()
        timings["read"] = time.perf_counter() - stage_started

        for record in records:
            if record["sha256"] not in known:
                vector = cache.get(models.DINO_CACHE_KEY, record["sha256"])
                if vector is not None:
                    known[record["sha256"]] = vector
    finally:
        cache.close()

    stage_started = time.perf_counter()
    missing = [record for record in records if record["sha256"] not in known]
    unique_missing = list({record["sha256"]: record for record in missing}.values())
    if unique_missing:
        computed, failed = _embed_missing(
            unique_missing, model_dir=root, device=device, profile=profile, reporter=reporter,
        )
        known.update(computed)
        failed_hashes = {record["sha256"] for record in unique_missing if record["asset_id"] in failed}
        kept = []
        for record in records:
            if record["sha256"] in failed_hashes:
                skipped.append({"asset_id": record["asset_id"], "reason": "unreadable"})
            else:
                kept.append(record)
        records = kept
    timings["embed"] = time.perf_counter() - stage_started

    stage_started = time.perf_counter()
    if records:
        width = len(known[records[0]["sha256"]])
        embeddings = np.zeros((len(records), width), dtype=np.float32)
        for index, record in enumerate(records):
            vector = known[record["sha256"]]
            if len(vector) != width:
                raise WorkerError("internal", "嵌入维度不一致，请清理嵌入缓存后重试")
            embeddings[index] = vector
    else:
        embeddings = np.zeros((0, 1), dtype=np.float32)
    result = analyze(embeddings, options, reporter)
    timings["analysis"] = time.perf_counter() - stage_started

    reporter.stage("write")
    order = {item["asset_id"]: index for index, item in enumerate(items)}
    skipped.sort(key=lambda entry: order[entry["asset_id"]])
    timings["total"] = time.perf_counter() - started
    atlas = build_atlas(
        records, result, job=job, skipped=skipped,
        sprites=writer.describe() if writer is not None else None, timings=timings,
    )
    target = output / "atlas.json"
    payload = json.dumps(atlas, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    _atomic_write(target, lambda handle: handle.write(payload))
    reporter.emit({
        "type": "done",
        "output": str(target),
        "items": atlas["counts"]["items"],
        "skipped": atlas["counts"]["skipped"],
        "clusters": atlas["counts"]["clusters"],
        "method": atlas["method"],
        "seconds": round(time.perf_counter() - started, 3),
    })
    return atlas


# ---- CLI ----

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="为数据集生成语义地图（坐标、簇、离群分数、雪碧图）")
    parser.add_argument("--job", required=True, help="任务 JSON 路径；- 表示从 stdin 读取")
    parser.add_argument("--output-dir", type=Path, help="覆盖任务里的 output_dir")
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    parser.add_argument("--workers", type=int, default=0, help="0=按设备与 CPU 数量选择")
    parser.add_argument("--torch-threads", type=int, default=0, help="0=按设备选择")
    parser.add_argument("--deep-batch-size", type=int, default=0, help="0=按设备选择")
    return parser


def main(argv: list[str] | None = None) -> int:
    if os.name != "nt":
        os.umask(0o077)
    args = build_parser().parse_args(argv)
    reporter = Reporter(sys.stdout)
    try:
        for name, value, maximum in (
            ("--workers", args.workers, 64),
            ("--torch-threads", args.torch_threads, 128),
            ("--deep-batch-size", args.deep_batch_size, 128),
        ):
            if not 0 <= value <= maximum:
                raise JobError(f"{name} 必须是 0（自动）或 1..{maximum}")
        try:
            text = sys.stdin.read() if args.job == "-" else Path(args.job).read_text(encoding="utf-8")
            payload = json.loads(text)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise JobError(f"无法读取任务: {error}") from error
        job = parse_job(payload, output_dir=args.output_dir)
        from dedup_resources import build_resource_profile

        profile = build_resource_profile(
            args.device,
            workers=args.workers,
            torch_threads=args.torch_threads,
            deep_batch_size=args.deep_batch_size,
        )
        run_job(job, model_dir=args.model_dir, device=args.device, profile=profile, reporter=reporter)
    except JobError as error:
        reporter.emit({"type": "error", "code": "invalid_job", "message": str(error)})
        return 2
    except WorkerError as error:
        reporter.emit({"type": "error", "code": error.code, "message": str(error)})
        return 1
    except Exception as error:  # noqa: BLE001 - 子进程边界：任何异常都要变成稳定的错误事件
        traceback.print_exc(file=sys.stderr)
        reporter.emit({"type": "error", "code": "internal", "message": f"{type(error).__name__}: {error}"})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
