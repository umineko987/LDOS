"""打标模型登记表。

每个模型登记为一条不可变的 spec：下载地址固定为 repo@revision 的
Hugging Face 直链，不做事后哈希校验（用户决定：纯过度防御）。
新增模型 = 在这里加一条登记，安装/推理代码不感知具体模型。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True, slots=True)
class RemoteFile:
    """bundle 内一个文件的相对路径。"""

    name: str


@dataclass(frozen=True, slots=True)
class TaggerModelSpec:
    key: str
    repo: str
    revision: str
    adapter: str
    files: tuple[RemoteFile, ...]
    default_thresholds: Mapping[str, float]
    license: str
    gated: bool = False

    def url_for(self, remote_file: RemoteFile) -> str:
        return f"https://huggingface.co/{self.repo}/resolve/{self.revision}/{remote_file.name}"


# v3 系五个模型共用同一份词表。
_WD_V3_VOCAB = RemoteFile("selected_tags.csv")

_WD_DEFAULT_THRESHOLDS = {"general": 0.35, "character": 0.85}


def _wd_spec(key: str, repo: str, revision: str) -> TaggerModelSpec:
    return TaggerModelSpec(
        key=key,
        repo=repo,
        revision=revision,
        adapter="wd_onnx",
        files=(
            RemoteFile("model.onnx"),
            _WD_V3_VOCAB,
        ),
        default_thresholds=_WD_DEFAULT_THRESHOLDS,
        license="open",
    )


SPECS: dict[str, TaggerModelSpec] = {
    spec.key: spec
    for spec in (
        _wd_spec(
            "wd-vit-v3",
            "SmilingWolf/wd-vit-tagger-v3",
            "7f6b584d0bd3f55c4531f14ba3d4761b2bccdc0f",
        ),
        _wd_spec(
            "wd-convnext-v3",
            "SmilingWolf/wd-convnext-tagger-v3",
            "d39e46de298d27340111b64965e20b8185c407e6",
        ),
        _wd_spec(
            "wd-swinv2-v3",
            "SmilingWolf/wd-swinv2-tagger-v3",
            "627aef95638667ddcaa3ac8ae625e88ea5b02f51",
        ),
        _wd_spec(
            "wd-vit-large-v3",
            "SmilingWolf/wd-vit-large-tagger-v3",
            "ae469aa2e4706a3af08d3673cf73a11d1add314c",
        ),
        _wd_spec(
            "wd-eva02-large-v3",
            "SmilingWolf/wd-eva02-large-tagger-v3",
            "b25b82a03f7282e41aa2f257a52c7583b710bd1c",
        ),
        TaggerModelSpec(
            key="wd-eva02-2026-canary",
            repo="ashen-sensored/wd-eva02-tagger-2026-canary",
            revision="c45a59a3f17c0ca6066072b1c213e0c12a90e242",
            adapter="timm_canary",
            files=(
                RemoteFile("model.safetensors"),
                RemoteFile("selected_tags.csv"),
                RemoteFile("config.json"),
            ),
            # 官方 README 的 P=R 阈值；character 沿用 WD 惯例
            default_thresholds={"general": 0.6094, "character": 0.85},
            license="apache-2.0",
        ),
        TaggerModelSpec(
            key="pixai-tagger-v1",
            repo="pixai-labs/pixai-tagger-v1.0",
            revision="9fe10addf9326e292da8a85a98ea74cd91b41771",
            adapter="pixai_hf",
            files=(
                RemoteFile("model.safetensors"),
                RemoteFile("config.json"),
                RemoteFile("preprocessor_config.json"),
                RemoteFile("tagger_pipeline.py"),
            ),
            # 模型卡各类别推荐阈值
            default_thresholds={
                "general": 0.17,
                "character": 0.27,
                "style": 0.15,
                "copyright": 0.24,
                "meta": 0.17,
                "rating": 0.41,
            },
            license="open",
        ),
        TaggerModelSpec(
            key="cl-tagger-v2",
            repo="cella110n/cl_tagger_v2",
            revision="b57909b8e9c63f71e208a26473e7aabdf45ed6b6",
            adapter="cl_onnx",
            files=(
                RemoteFile("v2_00/model.onnx"),
                RemoteFile("v2_00/model.onnx.data"),
                RemoteFile("v2_00/model_vocabulary.json"),
            ),
            # 模型卡实用统一阈值（best_thr 逐标签 F1 偏过标，不采用）
            default_thresholds={
                "general": 0.55,
                "character": 0.55,
                "rating": 0.55,
                "quality": 0.55,
            },
            license="CL Tagger v2 Model License v1.0（下载/执行即视为同意，禁止再分发）",
            gated=True,
        ),
    )
}
