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
    )
}
