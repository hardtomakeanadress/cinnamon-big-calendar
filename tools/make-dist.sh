#!/usr/bin/env bash
# Build the release archive: dist/bigCalendar@adis.zip.
#
#   ./tools/make-dist.sh
#
# What goes in is what a machine needs to *run* the desklet rather than to
# develop it -- the five files Cinnamon loads, lib/, the translations, the
# licence, the README, and install.sh. The development scripts (deploy.sh,
# shot.sh, tests/, tools/) are left out; they assume a source checkout and a
# session to reload into, and on someone else's machine they are noise.
#
# The archive has a single top-level bigCalendar@adis/ directory. That is not
# cosmetic: Cinnamon's spice installer looks for exactly that folder name
# inside the zip, so an archive without it installs as an empty desklet.

set -euo pipefail

cd "$(dirname "$0")/.."

ROOT=$(pwd)
UUID="bigCalendar@adis"
OUT="dist/$UUID.zip"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

FILES=(desklet.js metadata.json settings-schema.json stylesheet.css icon.png
       LICENSE README.md install.sh)

# Everything the desklet cannot start without. Checked before the archive is
# built rather than after it is unzipped on another machine.
for f in "${FILES[@]}"; do
    [[ -f "$f" ]] || { echo "make-dist: missing $f" >&2; exit 1; }
done

python3 -c 'import json,sys; json.load(open(sys.argv[1]))' metadata.json \
    || { echo "make-dist: metadata.json is not valid JSON" >&2; exit 1; }

mkdir -p dist "$STAGE/$UUID/lib" "$STAGE/$UUID/po"

cp "${FILES[@]}" "$STAGE/$UUID/"
cp lib/*.js "$STAGE/$UUID/lib/"

# The template always; any actual translations if a translator has added some.
cp po/*.pot "$STAGE/$UUID/po/"
for po in po/*.po; do
    [[ -e "$po" ]] && cp "$po" "$STAGE/$UUID/po/"
done

# install.sh is run as ./install.sh by whoever unpacks this, so it has to
# arrive executable.
chmod +x "$STAGE/$UUID/install.sh"

rm -f "$OUT"
( cd "$STAGE" && zip -qr -X "$ROOT/$OUT" "$UUID" )

# Prove the layout, since the failure it guards against is silent: the wrong
# top level makes Cinnamon install a desklet with no desklet.js in it.
TOP=$(unzip -Z1 "$OUT" | cut -d/ -f1 | sort -u)
[[ "$TOP" == "$UUID" ]] || { echo "make-dist: bad archive layout: $TOP" >&2; exit 1; }
unzip -Z1 "$OUT" | grep -qx "$UUID/desklet.js" \
    || { echo "make-dist: desklet.js is not in the archive root" >&2; exit 1; }

# A checksum to publish beside the archive, so someone can check what they
# downloaded before running it. Built here rather than by hand at release time,
# because a checksum made any other way is a checksum of something other than
# what this script just produced.
#
# The name inside is the bare filename, so `sha256sum -c` works from whatever
# directory the two files were downloaded into.
rm -f "$OUT.sha256"
( cd dist && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

printf '%s  (%s, %s files)\n' "$OUT" "$(du -h "$OUT" | cut -f1)" "$(unzip -Z1 "$OUT" | wc -l)"
printf '%s\n' "$(cat "$OUT.sha256")"
