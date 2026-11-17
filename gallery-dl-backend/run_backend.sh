#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
native_bin="$script_dir/../backend/build/ldos-backend"
if [[ ! -x "$native_bin" ]]; then
    printf '错误：Go 后端未构建：%s\n请先运行：./scripts/setup-linux.sh --device cpu\n' "$native_bin" >&2
    exit 1
fi

# Preserve the original config location and relative-path semantics.
cd "$script_dir"
exec "$native_bin" --config "${GDL_BACKEND_CONFIG:-$script_dir/config.json}" \
    --executors-dir "$script_dir/../backend/executors" "$@"
