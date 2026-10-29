"""图库缩略图服务（§6.3）：有界解码 + EXIF 方向 + 磁盘缓存。

缓存键 = asset_id + modified_ns + size，命中直接复用；未命中时经
Pillow 以限制边长缩放（`ImageOps.exif_transpose` 保证方向一致），
JPEG 有损编码后原子写入缓存。任何解码失败上抛固定错误码，不携带
原始异常文本或绝对路径。
"""

from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError
from PIL.ImageOps import exif_transpose

from .gallery_safe_paths import SafeSourceRoot, UnsafeSourcePathError
SUPPORTED_THUMBNAIL_SIZES: frozenset[int] = frozenset({256, 512})


class ThumbnailUnavailable(Exception):
    """缩略图无法生成（损坏、过大或格式不支持）。"""

    def __init__(self, code: str) -> None:
        super().__init__(f"thumbnail_unavailable:{code}")
        self.code = code


class ThumbnailService:
    def __init__(self, cache_dir: Path) -> None:
        self._cache_dir = Path(cache_dir)
        self._cache_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _etag(asset_id: str, modified_ns: int, size: int) -> str:
        digest = hashlib.sha1(
            f"{asset_id}:{modified_ns}:{size}".encode("utf-8")
        ).hexdigest()
        return f'W/"{digest[:24]}"'

    def _cache_path(self, asset_id: str, modified_ns: int, size: int) -> Path:
        return self._cache_dir / f"{asset_id}.{int(modified_ns)}.{size}.jpg"

    def cached_path(self, asset_id: str, modified_ns: int, size: int) -> Path | None:
        """已缓存的缩略图路径（不生成）；语义地图用它当雪碧图素材，省掉解码原图。"""
        cached = self._cache_path(asset_id, modified_ns, size)
        return cached if cached.is_file() and not cached.is_symlink() else None

    def thumbnail_response(
        self,
        *,
        source_root: Path,
        relative_path: str,
        asset_id: str,
        modified_ns: int,
        size: int,
    ) -> dict[str, Any]:
        """返回 {path, etag}；缓存未命中时同步生成。"""
        if size not in SUPPORTED_THUMBNAIL_SIZES:
            raise ValueError("invalid_thumbnail_size")
        try:
            with SafeSourceRoot(source_root) as safe_root:
                source_handle = safe_root.open_binary(relative_path)
        except UnsafeSourcePathError as error:
            code = "missing" if error.reason == "file_missing" else "unsafe_source_path"
            raise ThumbnailUnavailable(code) from error
        try:
            actual_modified_ns = int(os.fstat(source_handle.fileno()).st_mtime_ns)
            etag = self._etag(asset_id, actual_modified_ns, size)
            cached = self._cache_path(asset_id, actual_modified_ns, size)
            if cached.is_file():
                return {"path": cached, "etag": etag}
            with Image.open(source_handle) as image:
                oriented = exif_transpose(image)
                oriented.thumbnail((size, size), Image.Resampling.LANCZOS)
                if oriented.mode not in ("RGB", "L"):
                    oriented = oriented.convert("RGB")
                descriptor, temp_name = tempfile.mkstemp(
                    dir=str(self._cache_dir), suffix=".tmp"
                )
                try:
                    with os.fdopen(descriptor, "wb") as handle:
                        oriented.save(handle, format="JPEG", quality=82)
                    os.replace(temp_name, cached)
                except BaseException:
                    try:
                        os.unlink(temp_name)
                    except OSError:
                        pass
                    raise
        except UnidentifiedImageError:
            raise ThumbnailUnavailable("unidentified") from None
        except Image.DecompressionBombError:
            raise ThumbnailUnavailable("too_large") from None
        except OSError:
            raise ThumbnailUnavailable("decode_failed") from None
        finally:
            source_handle.close()
        return {"path": cached, "etag": etag}
