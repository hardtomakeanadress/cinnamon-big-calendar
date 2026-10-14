#!/usr/bin/env bash
# Synthetic add/edit/delete checks on a private D-Bus session and EDS profile.
# Personal accounts are not loaded. Temporary artifacts are left for inspection.
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_ROOT=$(mktemp -d /tmp/big-calendar-private-eds-XXXXXX)
mkdir -p "$TEST_ROOT/config" "$TEST_ROOT/cache" "$TEST_ROOT/data"
printf 'Isolated calendar test: %s\n' "$TEST_ROOT"
GIO_USE_VFS=local BIG_CALENDAR_ISOLATED_TEST=1 \
XDG_CONFIG_HOME="$TEST_ROOT/config" XDG_CACHE_HOME="$TEST_ROOT/cache" \
XDG_DATA_HOME="$TEST_ROOT/data" \
timeout 45s dbus-run-session -- cjs -m tests/live-refresh.js
