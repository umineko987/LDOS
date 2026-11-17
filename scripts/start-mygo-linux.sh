#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
desktop_dir="$(CDPATH= cd -- "$script_dir/../desktop" && pwd)"

if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
    printf 'This entry point currently accepts Linux x86_64 only.\n' >&2
    exit 1
fi
if [[ ! -x "$desktop_dir/build/linux-amd64/ldos" ]]; then
    printf 'Missing Linux mygo build. Run: cd desktop && npm run build\n' >&2
    exit 1
fi
if [[ ! -x "$desktop_dir/../backend/build/ldos-backend" ]]; then
    printf 'Missing native backend. Run: cd desktop && npm run build:backend\n' >&2
    exit 1
fi

# This build embeds the frontend. The native backend and its executors run from this checkout.
export LDOS_DESKTOP_SOURCE=1
cd "$desktop_dir"
exec ./build/linux-amd64/ldos "$@"
