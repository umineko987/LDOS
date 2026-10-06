"""打标模型登记表。

每个模型登记为一条不可变的 spec：固定 revision 的文件清单（含 SHA256）、
适配器类型、分类别默认阈值与许可信息。新增模型 = 在这里加一条登记，
安装/推理代码不感知具体模型。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping


@dataclass(frozen=True, slots=True)
class RemoteFile:
    """bundle 内一个文件的相对路径与校验信息。"""

    name: str
    sha256: str
    size: int


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


# v3 系五个模型共用同一份词表（校验值一致）。
_WD_V3_VOCAB = RemoteFile(
    name="selected_tags.csv",
    sha256="298633d94d0031d2081c0893f29c82eab7f0df00b08483ba8f29d1e979441217",
    size=308_468,
)

_WD_DEFAULT_THRESHOLDS = {"general": 0.35, "character": 0.85}


def _wd_spec(key: str, repo: str, revision: str, onnx_sha256: str, onnx_size: int) -> TaggerModelSpec:
    return TaggerModelSpec(
        key=key,
        repo=repo,
        revision=revision,
        adapter="wd_onnx",
        files=(
            RemoteFile("model.onnx", onnx_sha256, onnx_size),
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
            "35f23693620b668f4d53fd3c62bf65e40af739bc52c7eb0fbc49258b58d065b6",
            378_536_310,
        ),
        _wd_spec(
            "wd-convnext-v3",
            "SmilingWolf/wd-convnext-tagger-v3",
            "d39e46de298d27340111b64965e20b8185c407e6",
            "1b8a7abf13d9b8368267df47501d523789c4aeae66b2296ad98483239dfa32eb",
            394_990_732,
        ),
        _wd_spec(
            "wd-swinv2-v3",
            "SmilingWolf/wd-swinv2-tagger-v3",
            "627aef95638667ddcaa3ac8ae625e88ea5b02f51",
            "e6774bff34d43bd49f75a47db4ef217dce701c9847b546523eb85ff6dbba1db1",
            467_460_978,
        ),
        _wd_spec(
            "wd-vit-large-v3",
            "SmilingWolf/wd-vit-large-tagger-v3",
            "ae469aa2e4706a3af08d3673cf73a11d1add314c",
            "e4c8001b000a6c98f2db10794f7c406daa79873d071d6ca924330fa053fa1845",
            1_260_645_673,
        ),
        _wd_spec(
            "wd-eva02-large-v3",
            "SmilingWolf/wd-eva02-large-tagger-v3",
            "b25b82a03f7282e41aa2f257a52c7583b710bd1c",
            "9e768793060c7939b277ccb382783e8670e8a042d29d77aa736be0c8cc898bfc",
            1_260_435_999,
        ),
    )
}
