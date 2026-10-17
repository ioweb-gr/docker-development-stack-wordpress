#!/bin/sh
# ioweb-managed: read-only WordPress audit wrapper.
set -eu
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
exec node "$script_dir/../src/cli.js" audit --project-root "$PWD" "$@"
