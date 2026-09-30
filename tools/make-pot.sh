#!/usr/bin/env bash
# Regenerate po/bigCalendar@adis.pot.
#
# The strings needing translation come from two places: the _() calls in
# desklet.js, and the descriptions, tooltips and option labels in
# settings-schema.json, which Cinnamon looks up in the same gettext domain when
# it builds the configuration dialog. xgettext only reads source code, so the
# schema's strings are collected separately and the two are merged with
# msgcat, which also drops any string that appears in both.
#
#   ./tools/make-pot.sh
#
# To add a language, copy the .pot to po/LL.po, translate it, then:
#   msgfmt po/LL.po -o ~/.local/share/locale/LL/LC_MESSAGES/bigCalendar@adis.mo
# which is the directory desklet.js points gettext at.

set -euo pipefail

cd "$(dirname "$0")/.."

DOMAIN="bigCalendar@adis"
OUT="po/$DOMAIN.pot"

TMPDIR_POT=$(mktemp -d)
trap 'rm -rf "$TMPDIR_POT"' EXIT

xgettext \
    --language=JavaScript \
    --keyword=_ \
    --from-code=UTF-8 \
    --package-name="Big Calendar" \
    --output="$TMPDIR_POT/js.pot" \
    desklet.js

# The schema's translatable fields, with a fake source reference so a
# translator can see which setting each string belongs to.
python3 - "$TMPDIR_POT/schema.pot" <<'PYEOF'
import json
import sys

with open("settings-schema.json", encoding="utf-8") as fh:
    schema = json.load(fh)

seen = set()
entries = []


def add(text, where):
    if not isinstance(text, str) or not text.strip() or text in seen:
        return
    seen.add(text)
    entries.append((where, text))


def walk(node, path):
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("description", "tooltip"):
                add(value, path)
            elif key == "options" and isinstance(value, dict):
                # The visible half of an options map is what the user reads.
                for label in value:
                    add(label, path + "/options")
            elif isinstance(value, (dict, list)):
                walk(value, path + "/" + key)
    elif isinstance(node, list):
        for item in node:
            walk(item, path)


for key, value in schema.items():
    walk(value, key)

with open(sys.argv[1], "w", encoding="utf-8") as out:
    out.write('msgid ""\nmsgstr ""\n')
    out.write('"Content-Type: text/plain; charset=UTF-8\\n"\n\n')
    for where, text in entries:
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        out.write("#: settings-schema.json:%s\n" % where)
        out.write('msgid "%s"\n' % escaped)
        out.write('msgstr ""\n\n')
PYEOF

msgcat --use-first "$TMPDIR_POT/js.pot" "$TMPDIR_POT/schema.pot" --output-file="$OUT"

# The placeholders xgettext leaves in the header read as unfinished work.
python3 - "$OUT" <<'PYEOF'
import re
import sys

path = sys.argv[1]
with open(path, encoding="utf-8") as fh:
    text = fh.read()

text = text.replace("# SOME DESCRIPTIVE TITLE.", "# Translation template for the Big Calendar desklet.")
text = text.replace("# Copyright (C) YEAR THE PACKAGE'S COPYRIGHT HOLDER",
                    "# Copyright (C) 2026 the Big Calendar authors")
text = text.replace("# FIRST AUTHOR <EMAIL@ADDRESS>, YEAR.", "# adis, 2026.")
# The header entry is marked fuzzy, which tells a translator not to translate
# it -- fine for a generated template, wrong once the fields above are real.
text = text.replace("#, fuzzy\n", "", 1)

with open(path, "w", encoding="utf-8") as fh:
    fh.write(text)
PYEOF

# A .po with a syntax error in it is worse than no .po, so prove it compiles.
msgfmt --check-format --output-file=/dev/null "$OUT"

printf '%s: %s strings\n' "$OUT" "$(grep -c '^msgid ' "$OUT")"
