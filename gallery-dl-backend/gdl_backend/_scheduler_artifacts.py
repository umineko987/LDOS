from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Protocol


@dataclass(frozen=True)
class ArtifactRecord:
    """Filesystem facts supplied to the pure artifact filters."""

    path: Path
    is_file: bool
    size: int | None = None


def parse_artifact_output(line: str) -> Path | None:
    """Parse gallery-dl stdout without resolving or reading the path."""

    value = str(line or "").strip()
    if value.startswith("# "):
        value = value[2:].strip()
    if not value:
        return None
    path = Path(value)
    return path if path.is_absolute() else None


def is_complete_artifact_name(name: str) -> bool:
    return not name.lower().endswith(".part") and not name.startswith(
        ".gdl-activity-"
    )


def filter_artifact_records(
    records: Iterable[ArtifactRecord],
    *,
    resolved_root: Path | None = None,
    filter_names: bool = True,
) -> tuple[ArtifactRecord, ...]:
    """Filter explicit filesystem observations without touching the filesystem."""

    accepted: list[ArtifactRecord] = []
    for record in records:
        if not record.is_file:
            continue
        if filter_names and not is_complete_artifact_name(record.path.name):
            continue
        if resolved_root is not None:
            try:
                if not record.path.is_relative_to(resolved_root):
                    continue
            except ValueError:
                continue
        accepted.append(record)
    return tuple(accepted)


def summarize_artifact_records(
    records: Iterable[ArtifactRecord],
) -> tuple[int, int]:
    """Count only records whose size observation completed successfully."""

    count = 0
    total = 0
    for record in records:
        if not record.is_file or record.size is None:
            continue
        count += 1
        total += int(record.size)
    return count, total


class ArtifactCatalog(Protocol):
    def scan(self, output_dir: str) -> tuple[int, int]: ...

    def from_output(self, line: str, output_dir: str) -> Path | None: ...

    def totals(self, paths: Iterable[Path]) -> tuple[int, int]: ...

    def size(self, path: Path) -> int | None: ...


class LocalArtifactCatalog:
    """The explicit local-filesystem boundary used by attempt execution."""

    def scan(self, output_dir: str) -> tuple[int, int]:
        root = Path(output_dir)
        if not root.is_dir():
            return 0, 0

        def records() -> Iterable[ArtifactRecord]:
            for path in root.rglob("*"):
                try:
                    is_file = path.is_file()
                    if not is_file or not is_complete_artifact_name(path.name):
                        continue
                    yield ArtifactRecord(path, True, int(path.stat().st_size))
                except OSError:
                    continue

        return summarize_artifact_records(records())

    def from_output(self, line: str, output_dir: str) -> Path | None:
        path = parse_artifact_output(line)
        if path is None:
            return None
        try:
            resolved = path.resolve()
            root = Path(output_dir).resolve()
            records = filter_artifact_records(
                (ArtifactRecord(resolved, resolved.is_file()),),
                resolved_root=root,
            )
        except (OSError, ValueError):
            return None
        return records[0].path if records else None

    def totals(self, paths: Iterable[Path]) -> tuple[int, int]:
        def records() -> Iterable[ArtifactRecord]:
            for path in paths:
                try:
                    if path.is_file():
                        yield ArtifactRecord(path, True, int(path.stat().st_size))
                except OSError:
                    continue

        return summarize_artifact_records(records())

    def size(self, path: Path) -> int | None:
        try:
            if path.is_file():
                return int(path.stat().st_size)
        except OSError:
            return None
        return None
