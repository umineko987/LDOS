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

from bundle import bundle_path, installed, read_manifest
from preprocess import canary_prepare, cl_prepare, wd_prepare
from specs import TaggerModelSpec
from vocabulary import Vocabulary, load_cl_vocabulary, load_pixai_config, load_wd_csv

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


class TimmCanaryAdapter:
    """ashen-sensored wd-eva02-2026-canary（timm safetensors）。

    输出为原始 logits，需 sigmoid；输入 CHW/BGR/±1 归一化。
    构造参数（img_size/ref_feat_shape/num_classes）取自 bundle 内
    官方 config.json，权重以 strict 模式加载。
    """

    def __init__(self, spec: TaggerModelSpec, model_dir: Path):
        if spec.adapter != "timm_canary":
            raise TaggerAdapterError(f"{spec.key} 不是 timm_canary 适配器模型")
        self.spec = spec
        self.model_dir = model_dir
        self.vocabulary: Vocabulary | None = None
        self._model = None
        self._input_size = 448
        self.fingerprint = ""

    def load(self) -> None:
        if not installed(self.spec, self.model_dir):
            raise TaggerAdapterError(f"模型未安装: {self.spec.key}")
        try:
            import timm
            import torch
            from safetensors.torch import load_file
        except ImportError as error:
            raise TaggerAdapterError(
                f"缺少 torch 系依赖（timm/safetensors），请安装 tagger-torch 组: {error}"
            ) from error

        import json

        path = bundle_path(self.model_dir, self.spec.key)
        self.vocabulary = load_wd_csv(path / "selected_tags.csv")
        config = json.loads((path / "config.json").read_text(encoding="utf-8"))
        model_args = dict(config.get("model_args") or {})
        num_classes = int(config.get("num_classes") or len(self.vocabulary))
        if num_classes != len(self.vocabulary):
            raise TaggerAdapterError(
                f"config.json 类别数 {num_classes} 与词表 {len(self.vocabulary)} 不一致"
            )
        self._input_size = int(model_args.get("img_size") or 448)

        self._model = timm.create_model(
            config["architecture"],
            pretrained=False,
            num_classes=num_classes,
            **model_args,
        )
        state_dict = load_file(str(path / "model.safetensors"))
        self._model.load_state_dict(state_dict, strict=True)
        self._model.eval()

        digest = hashlib.sha256()
        digest.update(f"timm_canary:v{ADAPTER_VERSION}".encode())
        digest.update(self.spec.revision.encode())
        digest.update(self.vocabulary.fingerprint.encode())
        self.fingerprint = digest.hexdigest()

    def infer_scores(self, images: Sequence[Image.Image]) -> np.ndarray:
        if self._model is None:
            raise TaggerAdapterError("模型未加载")
        import torch

        prepared = np.stack([canary_prepare(image, self._input_size) for image in images])
        with torch.inference_mode():
            logits = self._model(torch.from_numpy(prepared))
            return torch.sigmoid(logits).numpy().astype(np.float32, copy=False)

    def close(self) -> None:
        self._model = None


class PixaiHfAdapter:
    """pixai-labs/pixai-tagger-v1.0（transformers remote code）。

    复用官方 ViTDetCls 与 RescalePadProcessor（从固定 revision 的本地
    bundle 加载，local_files_only），但绕开官方 TaggerPipeline 的阈值
    过滤，直接返回完整 sigmoid 分数。词表来自 config.json 的
    tags + tags_split。
    """

    def __init__(self, spec: TaggerModelSpec, model_dir: Path):
        if spec.adapter != "pixai_hf":
            raise TaggerAdapterError(f"{spec.key} 不是 pixai_hf 适配器模型")
        self.spec = spec
        self.model_dir = model_dir
        self.vocabulary: Vocabulary | None = None
        self._model = None
        self._processor = None
        self.fingerprint = ""

    def load(self) -> None:
        if not installed(self.spec, self.model_dir):
            raise TaggerAdapterError(f"模型未安装: {self.spec.key}")
        try:
            from transformers import AutoImageProcessor, AutoModel
        except ImportError as error:
            raise TaggerAdapterError(
                f"缺少 transformers 依赖，请安装 tagger-torch 组: {error}"
            ) from error

        path = bundle_path(self.model_dir, self.spec.key)
        self.vocabulary = load_pixai_config(path / "config.json")
        self._model = AutoModel.from_pretrained(
            path, trust_remote_code=True, local_files_only=True,
        )
        self._model.eval()
        self._processor = AutoImageProcessor.from_pretrained(
            path, trust_remote_code=True, local_files_only=True,
        )
        num_classes = int(getattr(self._model.config, "num_classes", 0) or 0)
        if num_classes and num_classes != len(self.vocabulary):
            raise TaggerAdapterError(
                f"模型输出维度 {num_classes} 与词表 {len(self.vocabulary)} 不一致"
            )

        digest = hashlib.sha256()
        digest.update(f"pixai_hf:v{ADAPTER_VERSION}".encode())
        digest.update(self.spec.revision.encode())
        digest.update(self.vocabulary.fingerprint.encode())
        self.fingerprint = digest.hexdigest()

    def infer_scores(self, images: Sequence[Image.Image]) -> np.ndarray:
        if self._model is None or self._processor is None:
            raise TaggerAdapterError("模型未加载")
        import torch

        batches = []
        with torch.inference_mode():
            for image in images:
                pixel_values = self._processor(image)["pixel_values"]
                logits = self._model(pixel_values.to(self._model.dtype))
                batches.append(torch.sigmoid(logits))
        return torch.cat(batches, dim=0).numpy().astype(np.float32, copy=False)

    def close(self) -> None:
        self._model = None
        self._processor = None


class ClOnnxAdapter:
    """cella110n/cl_tagger_v2（SigLIP2 ONNX，外置权重）。

    gated 模型：加载前校验 manifest 的 license_accepted。
    输出为原始 logits，需 sigmoid；输入 CHW 或 HWC 由 session 形状
    动态判定，RGB、/255、mean/std 0.5。
    """

    def __init__(self, spec: TaggerModelSpec, model_dir: Path):
        if spec.adapter != "cl_onnx":
            raise TaggerAdapterError(f"{spec.key} 不是 cl_onnx 适配器模型")
        self.spec = spec
        self.model_dir = model_dir
        self.vocabulary: Vocabulary | None = None
        self._session = None
        self._input_name = ""
        self._input_size = 0
        self._channels_first = True
        self.fingerprint = ""

    def load(self) -> None:
        if not installed(self.spec, self.model_dir):
            raise TaggerAdapterError(f"模型未安装: {self.spec.key}")
        if self.spec.gated:
            manifest = read_manifest(bundle_path(self.model_dir, self.spec.key)) or {}
            if not manifest.get("license_accepted"):
                raise TaggerAdapterError(
                    f"{self.spec.key} 需要先在安装时显式接受其许可（accept_license）"
                )
        import onnxruntime as ort

        path = bundle_path(self.model_dir, self.spec.key)
        self.vocabulary = load_cl_vocabulary(path / "v2_00" / "model_vocabulary.json")
        self._session = ort.InferenceSession(
            str(path / "v2_00" / "model.onnx"),
            providers=["CPUExecutionProvider"],
        )
        if "CPUExecutionProvider" not in self._session.get_providers():
            raise TaggerAdapterError("CPU 执行提供器不可用")

        inputs = self._session.get_inputs()
        outputs = self._session.get_outputs()
        if len(inputs) != 1 or len(outputs) != 1:
            raise TaggerAdapterError("期望单输入单输出的 ONNX 图")
        shape = [dimension if isinstance(dimension, int) else None for dimension in inputs[0].shape]
        if len(shape) != 4:
            raise TaggerAdapterError(f"期望 4 维输入，实际 {inputs[0].shape}")
        self._input_name = inputs[0].name
        if shape[1] == 3:  # NCHW
            self._channels_first = True
            self._input_size = shape[2] or shape[3]
        elif shape[3] == 3:  # NHWC
            self._channels_first = False
            self._input_size = shape[1] or shape[2]
        else:
            raise TaggerAdapterError(f"无法识别输入布局: {inputs[0].shape}")
        if not self._input_size:
            raise TaggerAdapterError(f"输入尺寸非静态: {inputs[0].shape}")

        output_shape = [dimension if isinstance(dimension, int) else None for dimension in outputs[0].shape]
        expected = len(self.vocabulary)
        if output_shape[-1] not in (expected, None) and output_shape[1] not in (expected, None):
            raise TaggerAdapterError(
                f"输出维度 {outputs[0].shape} 与词表数量 {expected} 不一致"
            )

        digest = hashlib.sha256()
        digest.update(f"cl_onnx:v{ADAPTER_VERSION}".encode())
        digest.update(self.spec.revision.encode())
        digest.update(self.vocabulary.fingerprint.encode())
        self.fingerprint = digest.hexdigest()

    def infer_scores(self, images: Sequence[Image.Image]) -> np.ndarray:
        if self._session is None:
            raise TaggerAdapterError("模型未加载")
        prepared = np.stack([cl_prepare(image, self._input_size) for image in images])
        if not self._channels_first:
            prepared = np.ascontiguousarray(prepared.transpose(0, 2, 3, 1))
        logits = self._session.run(None, {self._input_name: prepared})[0]
        logits = np.asarray(logits, dtype=np.float32)
        return 1.0 / (1.0 + np.exp(-logits))

    def close(self) -> None:
        self._session = None
