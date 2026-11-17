#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(CDPATH= cd -- "$script_dir/.." && pwd)"
backend_dir="$root_dir/gallery-dl-backend"
native_bin="$root_dir/backend/build/ldos-backend"
config_path="${GDL_BACKEND_CONFIG:-$backend_dir/config.json}"

if [[ "$(uname -s)" != "Linux" ]]; then
    printf '错误：doctor.sh 仅用于 Linux 部署。\n' >&2
    exit 1
fi
if [[ ! -x "$native_bin" ]]; then
    printf '错误：Go 后端未构建：%s\n请先运行：./scripts/setup-linux.sh --device cpu\n' "$native_bin" >&2
    exit 1
fi

cd "$backend_dir"
exec "$native_bin" --doctor --config "$config_path" --executors-dir "$root_dir/backend/executors" "$@"
