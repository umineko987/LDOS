"""图库目录合同纯函数（docs/图库(含导出).md §3.1–§3.7、§5）。

本模块只包含无 I/O 的确定性合同函数：受支持扩展名、图片/TXT 配对、
严格 UTF-8 解码与客观 TXT 状态、跨平台自然排序键、来源根目录规范化与
路径安全、`.ldos` 保留目录与回收区布局。扫描器、repository 和
service 阶段（G1+）必须复用这里的定义，不得在 API 层重复实现。
"""

from __future__ import annotations

import os
import re
from pathlib import Path, PurePosixPath
from typing import Literal


SUPPORTED_IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {".jpg", ".jpeg", ".png", ".webp"}
)

TxtState = Literal[
    "normal",
    "missing",
    "blank",
    "invalid_encoding",
    "pair_conflict",
    "io_error",
]
TXT_STATES: frozenset[str] = frozenset(
    {
        "normal",
        "missing",
        "blank",
        "invalid_encoding",
        "pair_conflict",
        "io_error",
    }
)

LDOS_RESERVED_DIR = ".ldos"
LDOS_TEMP_DIRECTORY_PREFIXES = (".ldos-copy-",)
TRASH_DIR_NAME = "trash"

_UTF8_BOM = b"\xef\xbb\xbf"
_DIGIT_RUN = re.compile(r"\d+")
_UNSAFE_COMPONENT = re.compile(r"[\x00-\x1f\x7f]")


def is_supported_image_name(name: str) -> bool:
    """第一版只接受四种扩展名（大小写不敏感）且必须有非空基本名。"""
    if not isinstance(name, str) or not name:
        return False
    stem, dot, extension = name.rpartition(".")
    if not dot or not stem:
        return False
    return f".{extension.lower()}" in SUPPORTED_IMAGE_EXTENSIONS


def image_extension(name: str) -> str:
    """返回小写扩展名（含点）；非受支持名称抛出 ValueError。"""
    if not is_supported_image_name(name):
        raise ValueError(f"unsupported_image_name:{name!r}")
    return "." + name.rpartition(".")[2].lower()


def txt_name_for_image(name: str) -> str:
    """配对规则：替换图片最后一个扩展名为 `.txt`（foo.bar.jpg → foo.bar.txt）。"""
    if not is_supported_image_name(name):
        raise ValueError(f"unsupported_image_name:{name!r}")
    stem, dot, _extension = name.rpartition(".")
    if not dot:
        raise ValueError(f"unsupported_image_name:{name!r}")
    return f"{stem}.txt"


def decode_txt_bytes(data: bytes) -> tuple[bool, str]:
    """严格 UTF-8 解码；接受 UTF-8 BOM 并在成功时剥离。

    永不使用替换字符：解码失败返回 ``(False, "")``，由调用方标记
    ``invalid_encoding`` 并阻止导出，不做自动检测、替换或隐式转码。
    """
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise TypeError("txt_bytes_required")
    raw = bytes(data)
    if raw.startswith(_UTF8_BOM):
        raw = raw[len(_UTF8_BOM) :]
    try:
        return True, raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError:
        return False, ""


def classify_txt_state(
    *,
    exists: bool,
    read_ok: bool = True,
    data: bytes | None = None,
    pair_conflict: bool = False,
) -> str:
    """客观 TXT 状态分类；判定优先级固定，禁止人工质量状态。"""
    if pair_conflict:
        return "pair_conflict"
    if not read_ok:
        return "io_error"
    if not exists:
        return "missing"
    if data is None:
        raise ValueError("txt_data_required_when_present")
    ok, text = decode_txt_bytes(data)
    if not ok:
        return "invalid_encoding"
    if not text.strip():
        return "blank"
    return "normal"


def natural_sort_key(name: str) -> str:
    """稳定自然排序键：`2.jpg` 先于 `10.jpg`，跨平台一致。

    键为字符串（持久化到 ``sort_key`` 列）：基本名 casefold 后按数字游程
    拆分，每个数字游程以两位十进制长度前缀 + 原数字编码，保证不同位数
    的数值比较仍然正确；非数字游程保持原样小写。并列时（如 ``A.jpg``
    与 ``a.jpg``）由调用方以原始文件名做次级排序。
    """
    if not isinstance(name, str):
        raise TypeError("name_required")
    folded = name.casefold()
    parts: list[str] = []
    position = 0
    for match in _DIGIT_RUN.finditer(folded):
        parts.append(folded[position : match.start()])
        digits = match.group(0)
        if len(digits) < 99:
            parts.append(f"{len(digits):02d}{digits}")
        else:
            # 超长数字游程（>98 位）在文件名场景之外；用 99 桶保持单调。
            parts.append(f"99{digits}")
        position = match.end()
    parts.append(folded[position:])
    return "".join(parts)


def is_safe_relative_path(relative_path: str | PurePosixPath) -> bool:
    """受管相对路径合同：纯相对、无 `..`/`.`、无反斜杠、无控制字符。"""
    if isinstance(relative_path, PurePosixPath):
        text = str(relative_path)
    elif isinstance(relative_path, str):
        text = relative_path
    else:
        return False
    if not text or text.startswith("/") or "\\" in text:
        return False
    if _UNSAFE_COMPONENT.search(text):
        return False
    path = PurePosixPath(text)
    if path.is_absolute():
        return False
    # PurePosixPath 会吞掉 `.` 组件，必须按原始斜杠分段校验。
    for component in text.split("/"):
        if component in {"", ".", ".."}:
            return False
        if component.endswith(" ") or component.endswith("."):
            # Windows 目录项约束：保守拒绝，避免跨平台写入失败。
            return False
    return True


def is_ldos_reserved_path(relative_path: str | PurePosixPath) -> bool:
    """任何一层等于 `.ldos` 的相对路径都属于保留区（含自身）。"""
    text = str(relative_path)
    return LDOS_RESERVED_DIR in PurePosixPath(text).parts


def canonical_root_key(path: str | Path) -> str:
    """来源根目录规范化真实路径键：解析符号链接、统一分隔符与大小写语义。

    同一路径、祖先与后代冲突检查（§3.1/§8.2）都基于该键，不做字符串
    前缀比较。Windows 上额外应用 normcase 处理盘符与大小写。
    """
    real = os.path.realpath(os.fspath(path))
    return os.path.normcase(str(Path(real)))


RootRelation = Literal["same", "ancestor", "descendant", "disjoint"]


def root_relation(left_key: str, right_key: str) -> str:
    """比较两个 canonical key 的层级关系（同一/祖先/后代/不相交）。"""
    left = Path(left_key)
    right = Path(right_key)
    if left == right:
        return "same"
    try:
        if left.is_relative_to(right):
            return "descendant"
    except (TypeError, ValueError):
        return "disjoint"
    try:
        if right.is_relative_to(left):
            return "ancestor"
    except (TypeError, ValueError):
        return "disjoint"
    return "disjoint"


def trash_files_relative_dir(operation_id: str) -> PurePosixPath:
    """来源根目录下回收操作目录中的 files/ 相对路径（§3.5）。"""
    if not operation_id or "/" in operation_id or "\\" in operation_id or ".." in operation_id:
        raise ValueError("invalid_operation_id")
    return PurePosixPath(LDOS_RESERVED_DIR) / TRASH_DIR_NAME / operation_id / "files"


def trash_operation_manifest_relative_path(operation_id: str) -> PurePosixPath:
    """回收操作元数据 `operation.json` 的相对路径（§3.5）。"""
    if not operation_id or "/" in operation_id or "\\" in operation_id or ".." in operation_id:
        raise ValueError("invalid_operation_id")
    return (
        PurePosixPath(LDOS_RESERVED_DIR)
        / TRASH_DIR_NAME
        / operation_id
        / "operation.json"
    )
