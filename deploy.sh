#!/usr/bin/env bash
# Install/update and reload; --disable uninstalls, preserving settings.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
if [[ $# -eq 1 && "$1" == --disable ]]; then
    exec bash "$SRC/install.sh" --uninstall
fi
exec bash "$SRC/install.sh" "$@"
