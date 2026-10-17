#!/bin/sh
# ioweb-managed: read-only WordPress benchmark wrapper.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
exec node "$script_dir/../src/cli.js" benchmark --project-root "$PWD" "$@"
