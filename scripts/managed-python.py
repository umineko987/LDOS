#!/usr/bin/env python3
"""Install the release-locked interpreter for source-mode venvs; print its path."""
from pathlib import Path
from tempfile import TemporaryDirectory

from desktop_release import ROOT, default_cache_dir, download_runtime, host_target, load_lock, safe_extract


def main() -> None:
    lock = load_lock()
    target = host_target()
    item = lock["targets"][target]
    home = ROOT / ".local" / "runtimes" / item["archive"].removesuffix(".tar.gz")
    relative = Path(item["python"]).relative_to("runtime")
    if not (home / relative).is_file():
        archive = download_runtime(lock, target, default_cache_dir())
        home.parent.mkdir(parents=True, exist_ok=True)
        with TemporaryDirectory(dir=home.parent) as tmp:
            staging = Path(tmp) / "runtime"
            safe_extract(archive, staging)
            staging.rename(home)
    print(home / relative)


if __name__ == "__main__":
    main()
