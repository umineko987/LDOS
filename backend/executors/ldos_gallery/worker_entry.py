from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main() -> int:
    args = list(sys.argv[1:])
    try:
        separator = args.index("--")
    except ValueError as exc:
        raise SystemExit("worker_entry requires '--' before gallery-dl arguments") from exc
    control_args = args[:separator]
    gallery_args = args[separator + 1 :]
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--marker", required=True)
    parser.add_argument("--gallery-root", required=True)
    parser.add_argument("--resolve", action="store_true")
    parser.add_argument("--danbooru-auth", action="store_true")
    control = parser.parse_args(control_args)

    gallery_root = Path(control.gallery_root).resolve()
    if not (gallery_root / "gallery_dl" / "__init__.py").is_file():
        raise SystemExit(f"gallery-dl source not found: {gallery_root}")
    sys.path.insert(0, str(gallery_root))

    if control.resolve:
        if len(gallery_args) != 1:
            raise SystemExit("resolve requires exactly one URL after '--'")
        import json

        from .resolve import resolve

        print(json.dumps(resolve(gallery_args[0], gallery_root), ensure_ascii=False))
        return 0

    username = os.environ.pop("GDL_WORKER_USERNAME", "")
    password = os.environ.pop("GDL_WORKER_PASSWORD", "")
    if username:
        gallery_args[0:0] = ["--username", username]
    if password:
        gallery_args[0:0] = ["--password", password]

    if control.danbooru_auth:
        import contextlib
        import io
        import json
        import logging

        from .danbooru_auth import AuthResolutionError, resolve_auth

        # Neither argparse nor vendor config/cookie errors may echo secrets.
        logging.disable(logging.CRITICAL)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try:
                payload = {"headers": resolve_auth(gallery_args), "error": ""}
            except AuthResolutionError as exc:
                payload = {"headers": {}, "error": str(exc)}
            except (Exception, SystemExit):
                payload = {"headers": {}, "error": "invalid_configuration"}
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    sys.argv = ["gallery-dl", *gallery_args]
    import gallery_dl

    # Runtime hooks stay outside the vendored tree and the business backend.
    from . import worker_patches

    worker_patches.apply_all()
    return int(gallery_dl.main() or 0)


if __name__ == "__main__":
    raise SystemExit(main())
