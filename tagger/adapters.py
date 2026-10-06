"""模型适配器：统一"装、加载、喂图得分数、卸载"四动作。

WD 系列 ONNX：激活函数已烘焙进计算图，输出即概率，直接透传；
输入布局 HWC/BGR/0-255，尺寸与 batch 能力从 session 动态读取，
输出维度必须与词表数量一致，否则拒绝加载。
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Sequence

import numpy as np
from PIL import Image

from bundle import bundle_path, installed
from preprocess import wd_prepare
from specs import TaggerModelSpec
from vocabulary import Vocabulary, load_wd_csv

# 适配器实现版本：预处理或输出解码语义变化时递增，使缓存指纹失效
ADAPTER_VERSION = 1


class TaggerAdapterError(RuntimeError):
    pass


class WdOnnxAdapter:
    """SmilingWolf WD 系列 ONNX 模型。"""

    def __init__(self, spec: TaggerModelSpec, model_dir: Path):
        if spec.adapter != "wd_onnx":
            raise TaggerAdapterError(f"{spec.key} 不是 wd_onnx 适配器模型")
        self.spec = spec
        self.model_dir = model_dir
        self.vocabulary: Vocabulary | None = None
        self._session = None
        self._input_name = ""
        self._input_size = 0
        self._max_batch = 1
        self.fingerprint = ""

    def load(self) -> None:
        if not installed(self.spec, self.model_dir):
            raise TaggerAdapterError(f"模型未安装: {self.spec.key}")
        import onnxruntime as ort

        path = bundle_path(self.model_dir, self.spec.key)
        self.vocabulary = load_wd_csv(path / "selected_tags.csv")
        self._session = ort.InferenceSession(
            str(path / "model.onnx"),
            providers=["CPUExecutionProvider"],
        )
        applied = self._session.get_providers()
        if "CPUExecutionProvider" not in applied:
            raise TaggerAdapterError(f"CPU 执行提供器不可用: {applied}")

        inputs = self._session.get_inputs()
        outputs = self._session.get_outputs()
        if len(inputs) != 1 or len(outputs) != 1:
            raise TaggerAdapterError("期望单输入单输出的 ONNX 图")
        shape = [dimension if isinstance(dimension, int) else None for dimension in inputs[0].shape]
        if len(shape) != 4:
            raise TaggerAdapterError(f"期望 4 维输入，实际 {inputs[0].shape}")
        self._input_name = inputs[0].name
        # NHWC：shape = (N, H, W, C)
        if shape[3] != 3:
            raise TaggerAdapterError(f"期望通道在最后维（NHWC），实际 {inputs[0].shape}")
        self._input_size = shape[1] or shape[2]
        if not self._input_size:
            raise TaggerAdapterError(f"输入尺寸非静态，无法确定预处理目标: {inputs[0].shape}")
        self._max_batch = shape[0] or 0  # 0 表示动态 batch

        output_shape = [dimension if isinstance(dimension, int) else None for dimension in outputs[0].shape]
        expected = len(self.vocabulary)
        if output_shape[-1] not in (expected, None) and output_shape[1] not in (expected, None):
            raise TaggerAdapterError(
                f"输出维度 {outputs[0].shape} 与词表数量 {expected} 不一致"
            )

        digest = hashlib.sha256()
        digest.update(f"wd_onnx:v{ADAPTER_VERSION}".encode())
        digest.update(self.spec.revision.encode())
        digest.update(self.vocabulary.fingerprint.encode())
        self.fingerprint = digest.hexdigest()

    def infer_scores(self, images: Sequence[Image.Image]) -> np.ndarray:
        """返回 [B, N] 概率，与词表顺序一致，未做任何阈值筛选。"""
        if self._session is None:
            raise TaggerAdapterError("模型未加载")
        prepared = np.stack([wd_prepare(image, self._input_size) for image in images])
        if self._max_batch and prepared.shape[0] > self._max_batch:
            chunks = []
            for start in range(0, prepared.shape[0], self._max_batch):
                chunks.append(
                    self._session.run(None, {self._input_name: prepared[start:start + self._max_batch]})[0]
                )
            return np.concatenate(chunks, axis=0).astype(np.float32, copy=False)
        result = self._session.run(None, {self._input_name: prepared})[0]
        return np.asarray(result, dtype=np.float32)

    def close(self) -> None:
        self._session = None
