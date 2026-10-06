"""打标图像预处理：加载规范化 + 各模型配方。

所有配方共享同一个入口 load_image()：EXIF 转正、透明区域白底合成。
与去重模块的 _open_rgb 不同——那个直接 convert("RGB") 会把透明垫黑，
打标必须垫白，故不复用。
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageOps


def load_image(path: Path | str) -> Image.Image:
    """读取图片：EXIF 转正 + 透明合成到白底，返回 RGB。"""
    with Image.open(path) as image:
        image = ImageOps.exif_transpose(image)
        if image.mode != "RGB":
            if "A" in image.getbands() or (image.mode == "P" and "transparency" in image.info):
                rgba = image.convert("RGBA")
                background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
                image = Image.alpha_composite(background, rgba)
            return image.convert("RGB").copy()
        return image.copy()


def wd_prepare(image: Image.Image, input_size: int) -> np.ndarray:
    """WD 系列 ONNX 配方：白色 pad 成正方形 → bicubic 缩放 → HWC、BGR、0-255。

    ONNX 图内已烘焙归一化，输入保持原始像素值。
    """
    side = max(image.size)
    square = Image.new("RGB", (side, side), (255, 255, 255))
    square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
    resized = square.resize((input_size, input_size), Image.BICUBIC)
    array = np.asarray(resized, dtype=np.float32)
    return array[:, :, ::-1]  # RGB -> BGR
