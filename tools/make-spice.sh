#!/usr/bin/env bash
# Build the submission tree for the Cinnamon Spices repository:
# dist/spice/bigCalendar@adis/.
#
#   ./tools/make-spice.sh
#
# That directory is exactly what a pull request to
# linuxmint/cinnamon-spices-desklets adds, and its shape is theirs rather than
# ours -- a desklet sits one level down under files/, wrapped in its own uuid,
# with info.json and a screenshot beside it:
#
#   bigCalendar@adis/
#   ├── info.json          {"author": "<github username>"} and nothing else
#   ├── screenshot.png     the image the Spices website shows
#   ├── README.md          optional, but it is the desklet's page
#   └── files/
#       └── bigCalendar@adis/   the desklet itself: what make-dist.sh ships
#
# files/ holds that one directory and no siblings. A stray file at that level
# is the mistake their validator is built to catch, so the layout is asserted
# below rather than assumed.
#
# The README is not the repository's. Ours tells a reader to curl a release
# from GitHub, which is the right way to install something from its own
# repository and the wrong thing to publish inside the Spices catalogue; the
# desklet's page there should send people to Desklets -> Download instead. So
# the page comes from tools/spice-README.md, which is written for that audience
# and links to nothing outside the tree.
#
# What this script can check, it checks; it is not the validator. Before
# opening the pull request, run their ./validate-spice bigCalendar@adis from a
# checkout of the Spices repository -- that is the copy that decides.

set -euo pipefail

cd "$(dirname "$0")/.."

ROOT=$(pwd)
UUID="bigCalendar@adis"
OUT="dist/spice/$UUID"
AUTHOR="hardtomakeanadress"

# The desklet, as it goes into files/$UUID. The same set make-dist.sh ships,
# less install.sh: in the catalogue Cinnamon does the installing, and a script
# that copies files into ~/.local/share/cinnamon is not something a reviewer
# should have to read past.
FILES=(desklet.js metadata.json settings-schema.json stylesheet.css icon.png
       LICENSE)

for f in "${FILES[@]}" tools/spice-README.md screenshot.png; do
    [[ -f "$f" ]] || { echo "make-spice: missing $f" >&2; exit 1; }
done
[[ -d lib ]] || { echo "make-spice: missing lib/" >&2; exit 1; }
[[ -d po  ]] || { echo "make-spice: missing po/"  >&2; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/files/$UUID/lib" "$OUT/files/$UUID/po"

cp "${FILES[@]}" "$OUT/files/$UUID/"
cp lib/*.js "$OUT/files/$UUID/lib/"
cp tools/spice-README.md "$OUT/README.md"
cp screenshot.png "$OUT/screenshot.png"

# One .pot, the template, and any real translations. Their validator wants
# exactly one .pot and nothing but .po/.pot in po/ -- the compiled .mo files
# msgfmt writes are for installing, not for committing.
cp po/*.pot "$OUT/files/$UUID/po/"
for po in po/*.po; do
    [[ -e "$po" ]] && cp "$po" "$OUT/files/$UUID/po/"
done

# info.json is generated rather than stored, because the rule for it is one
# line long and a stored copy is a second place for the author name to be
# wrong. No whitespace in the value: that is theirs, not a preference.
printf '{"author": "%s"}\n' "$AUTHOR" > "$OUT/info.json"

# ---------------------------------------------------------------- assertions
#
# Each of these mirrors a rule their validate-spice enforces. They are here so
# a mistake surfaces while the tree is being built rather than in the pull
# request, and they are written against the rule as published, not against a
# copy of their script.

fail() { echo "make-spice: $*" >&2; exit 1; }

python3 - "$OUT" "$UUID" <<'PY' || exit 1
import json, os, sys

out, uuid = sys.argv[1], sys.argv[2]
fail = lambda m: (print("make-spice: " + m, file=sys.stderr), sys.exit(1))

def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()

# info.json: exactly the author, and no whitespace anywhere in the value.
info = json.loads(read(os.path.join(out, "info.json")))
if "author" not in info:
    fail("info.json has no author")
if any(c.isspace() for c in info["author"]):
    fail("info.json author contains whitespace")

# metadata.json: the three required fields, none of the three forbidden ones,
# the uuid matching the directory, and no non-ASCII -- their rule, and it
# catches a curly quote in a description that would otherwise ship.
meta = json.loads(read(os.path.join(out, "files", uuid, "metadata.json")))
for key in ("uuid", "name", "description"):
    if key not in meta:
        fail("metadata.json has no " + key)
for key in ("icon", "dangerous", "last-edited"):
    if key in meta:
        fail("metadata.json must not set " + key)
if meta["uuid"] != uuid:
    fail("metadata.json uuid is %r, not %r" % (meta["uuid"], uuid))
for key, value in meta.items():
    if isinstance(value, str) and not value.isascii():
        fail("metadata.json %s is not ASCII" % key)

# The descriptor, for the same reason.
schema = json.loads(read(os.path.join(out, "files", uuid, "settings-schema.json")))
PY

# files/ holds the uuid directory and nothing else.
mapfile -t level < <(ls -A "$OUT/files")
[[ "${#level[@]}" -eq 1 && "${level[0]}" == "$UUID" ]] \
    || fail "files/ must contain only $UUID (found: ${level[*]})"

# Nothing compiled, and no template outside po/.
mapfile -t top < <(ls -A "$OUT")
for f in "${top[@]}"; do
    case "$f" in
        *.po|*.pot) fail "a translation file is at the top level: $f" ;;
        icon.png)   fail "icon.png belongs in files/$UUID, not at the top level" ;;
    esac
done
[[ -f "$OUT/files/$UUID/desklet.js" ]] || fail "desklet.js is missing"
[[ -f "$OUT/screenshot.png" ]] || fail "screenshot.png is missing"

mapfile -t pots < <(ls -A "$OUT/files/$UUID/po"/*.pot 2>/dev/null || true)
[[ "${#pots[@]}" -eq 1 ]] || fail "po/ must hold exactly one .pot, found ${#pots[@]}"
shopt -s nullglob
mos=("$OUT/files/$UUID/po"/*.mo)
shopt -u nullglob
[[ "${#mos[@]}" -eq 0 ]] || fail "a compiled .mo is in the tree: ${mos[*]}"

# The icon has to be square -- theirs, and one a hand-drawn icon can fail.
python3 - "$OUT/files/$UUID/icon.png" <<'PY' || exit 1
import struct, sys
with open(sys.argv[1], "rb") as fh:
    head = fh.read(24)
if head[:8] != b"\x89PNG\r\n\x1a\n":
    sys.exit("make-spice: icon.png is not a PNG")
w, h = struct.unpack(">II", head[16:24])
if w != h:
    sys.exit("make-spice: icon.png is %dx%d, not square" % (w, h))
print("icon.png %dx%d" % (w, h))
PY

# The .pot, under the validator's own rule: it runs `xgettext <file> -o -` and
# fails the desklet if anything at all came out on stderr. Not the exit status
# -- stderr. Which is why this is written as the same command rather than as a
# stricter one that would pass here and fail there. It catches a malformed
# header, a bad placeholder, a stray byte that would ship to translators.
for pot in "$OUT/files/$UUID/po/"*.pot; do
    err=$(xgettext "$pot" -o - 2>&1 >/dev/null) || true
    [[ -z "$err" ]] || fail "xgettext wrote to stderr for $(basename "$pot"): $err"
done

printf '%s/  (%s files)\n' "$OUT" "$(find "$OUT" -type f | wc -l)"
echo
echo "Next: cp -r $OUT <spices-checkout>/ && cd <spices-checkout> && ./validate-spice $UUID"
