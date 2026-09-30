#!/usr/bin/env bash
# Install the Big Calendar desklet on a Cinnamon desktop.
#
#   ./install.sh              install or update, and enable it
#   ./install.sh --uninstall  remove it and its entry from the desklet list
#   ./install.sh --check      report whether this machine can run it, change nothing
#
# This is the installer for a machine that does not have the source checked
# out: unzip the release, run this, and the desklet is on the desktop. It takes
# no arguments for the common case, needs no root, writes only under $HOME, and
# leaves every other desklet alone.
#
# deploy.sh is the other script, for the machine where the source lives: it
# also reloads the running desklet so an edit takes effect. This one does not
# need to, because on a machine installing for the first time there is nothing
# loaded yet -- enabling the desklet in the settings is enough.

set -euo pipefail

UUID="bigCalendar@adis"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/cinnamon/desklets/$UUID"
LOCALE_DIR="$HOME/.local/share/locale"

# Where an install lands on the desktop the first time. Cinnamon remembers
# wherever the user drags it afterwards and we never move it again.
FIRST_X=400
FIRST_Y=200

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'
[[ -t 1 ]] || { RED=""; GREEN=""; YELLOW=""; BOLD=""; OFF=""; }

die()  { printf '%serror:%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$OFF" "$*"; }

# --- What this machine is -------------------------------------------------

# The version Cinnamon reports. The desklet declares the ones it needs in
# metadata.json, and Extension.versionCheck compares against exactly that list,
# so the check here reads the same file rather than repeating it -- otherwise
# the two drift apart the first time the requirement changes.
cinnamon_version() {
    command -v cinnamon >/dev/null 2>&1 || return 1
    cinnamon --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1
}

# Every requirement in metadata.json, one per line.
required_versions() {
    python3 - "$SRC/metadata.json" <<'PYEOF'
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    for v in json.load(fh)["cinnamon-version"]:
        print(v)
PYEOF
}

# Cinnamon's own rule, from js/ui/extension.js: a newer major always passes,
# and within the same major a newer minor passes. Patch is ignored. So 5.9 does
# not satisfy 6.0, but 7.0 and 6.6 both do.
#
# awk rather than shell arithmetic: bash reads a leading zero as octal, so
# $((10#...)) spells it, and a version like "6.08" -- which JavaScript's
# parseInt reads as 8 without complaint -- would take a special case. awk's
# `+0` does the right thing with no ceremony.
version_ok() {
    awk -v have="$1" -v want="$2" 'BEGIN {
        split(have, h, "."); split(want, w, ".")
        hmaj = h[1] + 0; hmin = h[2] + 0
        wmaj = w[1] + 0; wmin = w[2] + 0
        exit !(hmaj > wmaj || (hmaj == wmaj && hmin >= wmin))
    }'
}

# Satisfied by any one of the declared requirements, which is what
# versionCheck does with the list.
any_requirement_ok() {
    local have="$1" want
    while read -r want; do
        [[ -n "$want" ]] || continue
        version_ok "$have" "$want" && return 0
    done < <(required_versions)
    return 1
}

# The three typelibs the desklet imports. Cinnamon depends on all three, so on
# a working Cinnamon these are present -- but the failure mode when one is
# missing is a desklet that loads and silently shows no events, so it is worth
# turning into a sentence. The probe imports the namespaces *and reaches into
# the classes it uses*, because importing alone does not make the dynamic
# loader open the calendar libraries: a namespace whose shared library is
# missing would otherwise pass.
#
# Returns 0 the libraries work, 1 they are missing, 2 the check could not run.
# The third case is not the second and must not be reported as it.
typelibs_check() {
    local probe rc=0
    probe=$(mktemp --suffix=.js 2>/dev/null) || return 2

    cat > "$probe" <<'EOF' || { rm -f "$probe"; return 2; }
import ECal from 'gi://ECal?version=2.0';
import EDataServer from 'gi://EDataServer?version=1.2';
import ICalGLib from 'gi://ICalGLib?version=3.0';
if (!ECal.Client || !EDataServer.SourceRegistry || !ICalGLib.Time || !ICalGLib.Timezone)
    throw new Error("a namespace imported but its classes are missing");
EOF

    [[ -s "$probe" ]] || { rm -f "$probe"; return 2; }
    cjs -m "$probe" >/dev/null 2>&1 || rc=1
    rm -f "$probe"
    return $rc
}

# Whether Cinnamon is actually running and listening on this session's bus.
#
# Checking DBUS_SESSION_BUS_ADDRESS is not the same question: the variable can
# name a bus that is gone, or one belonging to a different desktop, and then
# the install reports success while the desklet list is never touched. Asking
# D-Bus whether anything owns the name org.Cinnamon answers the real question.
# python3 and gi are both present on any machine running Cinnamon -- its own
# settings application is written in them.
cinnamon_running() {
    python3 - <<'PYEOF' >/dev/null 2>&1
import sys
from gi.repository import Gio, GLib
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = bus.call_sync(
        "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "NameHasOwner", GLib.Variant("(s)", ("org.Cinnamon",)),
        None, Gio.DBusCallFlags.NONE, 5000, None)
    sys.exit(0 if reply.unpack()[0] else 1)
except Exception:
    sys.exit(1)
PYEOF
}

# --- Checks ---------------------------------------------------------------

check_machine() {
    local have want
    have=$(cinnamon_version) || die "Cinnamon is not installed on this machine.
       This is a Cinnamon desklet: it draws with Cinnamon's own toolkit (St)
       and only runs inside the Cinnamon desktop. On GNOME, KDE or XFCE it
       cannot run at all."

    if any_requirement_ok "$have"; then
        ok "Cinnamon $have (needs $(required_versions | paste -sd' or ' -) or newer)"
    else
        die "this desklet needs Cinnamon $(required_versions | paste -sd' or ' -) or newer;
       this machine has $have.
       Cinnamon 6.0 is Linux Mint 21.3 or newer. See the Requirements section
       of README.md."
    fi

    local rc=0
    typelibs_check || rc=$?
    case $rc in
        0) ok "calendar libraries present" ;;
        2) die "could not run the library check: no usable temporary directory
       (TMPDIR=${TMPDIR:-unset}). Nothing was installed." ;;
        *) die "the calendar libraries the desklet reads events with are missing.
       Install them with:
           sudo apt install gir1.2-ecal-2.0 gir1.2-edataserver-1.2 gir1.2-ical-3.0
       (on Fedora, Arch and others these come with evolution-data-server)" ;;
    esac

    if cinnamon_running; then
        ok "Cinnamon is running"
    else
        warn "Cinnamon is not running on this shell's session bus.
       What that means depends on where you are: over ssh the files will be
       installed but the desklet cannot be enabled from here. Run this again
       from a terminal on the Cinnamon desktop."
    fi
}

# --- The desklet list -----------------------------------------------------

# Add or remove this desklet's entry, leaving every other desklet in the list
# untouched. Replacing the list wholesale is the obvious way to do this and the
# wrong one: it would disable whatever else the user has on their desktop.
#
# An entry is "uuid:instance:x:y". Every existing entry for this uuid is kept,
# not just the first, and nothing is added when some are already there.
#
# The desklet declares max-instances 1, and that has two consequences worth
# knowing before changing it.
#
# Cinnamon deletes a desklet's settings file when an instance disappears from
# this list, but skips that for a desklet limited to a single instance. So at 1
# the desklet can be taken off the desktop and put back without losing its
# configuration; above 1, removing it would reset every setting.
#
# The file is also named differently. A single-instance xlet keeps its settings
# in spices/<uuid>/<uuid>.json, and a multi-instance one in
# spices/<uuid>/<instance>.json. Raising the limit would move the settings and
# strand the old file, so they would have to be carried across by hand.
edit_enabled() {
    local mode="$1" current updated
    current=$(gsettings get org.cinnamon enabled-desklets) \
        || die "could not read the desklet list (gsettings get org.cinnamon enabled-desklets)"

    updated=$(printf '%s' "$current" | python3 -c '
import ast, json, sys

uuid, mode, x, y = sys.argv[1:5]
raw = sys.stdin.read().strip()

# An empty list arrives as the typed form "@as []".
if raw.startswith("@as "):
    raw = raw[4:]
try:
    items = ast.literal_eval(raw)
except (ValueError, SyntaxError):
    items = []
if not isinstance(items, list):
    items = []

def is_mine(item):
    return isinstance(item, str) and item.split(":", 1)[0] == uuid

mine = [i for i in items if is_mine(i)]
others = [i for i in items if not is_mine(i)]

if mode == "remove":
    items = others
else:
    if not mine:
        taken = set()
        for item in others:
            parts = item.split(":")
            # isascii() first: str.isdigit() is true of "²", and int() then
            # raises, which would abort the install on someone else s desklet.
            if len(parts) > 1 and parts[1].isascii() and parts[1].isdigit():
                taken.add(int(parts[1]))
        n = 1
        while n in taken:
            n += 1
        mine = ["%s:%d:%s:%s" % (uuid, n, x, y)]
    items = others + mine

# json.dumps escapes the way GVariant reads; Python repr() does not. repr()
# writes a control character as \x01, which GVariant takes as four literal
# characters, so a uuid containing one would be rewritten and another desklet
# silently disabled. json writes \u0001, which GVariant understands.
sys.stdout.write(json.dumps(items))
' "$UUID" "$mode" "$FIRST_X" "$FIRST_Y") || die "could not work out the new desklet list"

    gsettings set org.cinnamon enabled-desklets "$updated" \
        || die "could not write the desklet list"
}

# --- Compiling translations ----------------------------------------------

# Cinnamon's own installer compiles po/*.po into the user's locale directory,
# so this does the same, for the same reason: a translation that is present
# but uncompiled is invisible.
install_translations() {
    local po mo lang
    for po in "$SRC"/po/*.po; do
        [[ -e "$po" ]] || return 0
        command -v msgfmt >/dev/null 2>&1 || {
            warn "msgfmt is not installed, so translations were skipped (gettext)"
            return 0
        }
        lang=$(basename "$po" .po)
        mkdir -p "$LOCALE_DIR/$lang/LC_MESSAGES"
        mo="$LOCALE_DIR/$lang/LC_MESSAGES/$UUID.mo"
        if msgfmt -c "$po" -o "$mo" 2>/dev/null; then
            ok "translation $lang"
        else
            warn "po/$lang.po has an error and was skipped"
        fi
    done
}

# --- Install --------------------------------------------------------------

do_install() {
    check_machine

    # If the release was unpacked straight into the desklets directory, the
    # source and the destination are the same tree. The copy below removes
    # lib/ before writing it, so it would delete the only copy of the modules
    # and then fail trying to copy them back from where they no longer are.
    if [[ "$(readlink -f "$SRC")" == "$(readlink -f "$DEST")" ]]; then
        die "this installer is running from inside $DEST, where it would
       overwrite itself and delete its own source. Unpack the release
       somewhere else and run it from there."
    fi

    # lib/ is replaced rather than merged, so a module deleted from the source
    # does not linger in the installed copy.
    rm -rf "$DEST/lib"
    mkdir -p "$DEST/lib"
    cp "$SRC/desklet.js" "$SRC/metadata.json" "$SRC/settings-schema.json" \
       "$SRC/stylesheet.css" "$SRC/icon.png" "$SRC/LICENSE" "$DEST/"
    cp "$SRC"/lib/*.js "$DEST/lib/"
    ok "installed to $DEST"

    install_translations

    if cinnamon_running; then
        edit_enabled add
        ok "enabled on the desktop"
        printf '\n%sDone.%s The calendar should be on your desktop now.\n' "$BOLD" "$OFF"
        note "Right-click it and choose Configure for its settings."
        note "No events? Add your Google account in Online Accounts."
    else
        printf '\n%sFiles installed.%s Enable it in Add desklets when you are on the desktop.\n' \
            "$BOLD" "$OFF"
    fi

    # A few words about what was just installed, since "installer ran a script"
    # is a reasonable thing to want reassurance about.
    printf '\n'
    note "It has no account or password of its own and contacts no server;"
    note "it reads the calendars already in Online Accounts. README.md → Privacy."
}

do_uninstall() {
    # The list is edited before the files go, so a failure here leaves a
    # working desklet rather than an entry pointing at nothing.
    if cinnamon_running; then
        edit_enabled remove
        ok "removed from the desklet list"
    else
        warn "Cinnamon is not running here, so the desklet list was not touched.
       Remove it by hand in Add desklets if it is still listed."
    fi

    if [[ -d "$DEST" ]]; then
        rm -rf "$DEST"
        ok "removed $DEST"
    else
        note "nothing installed at $DEST"
    fi

    # The settings file is deliberately left in place. Removing a desklet and
    # removing the choices made about it are different requests, and only one
    # of them was asked for.
    local cfg="$HOME/.config/cinnamon/spices/$UUID"
    if [[ -d "$cfg" ]]; then
        note "your settings are still in $cfg (delete it to start fresh)"
    fi

    printf '\n%sDone.%s Restart Cinnamon (Ctrl+Alt+Esc) if the desklet is still on screen.\n' \
        "$BOLD" "$OFF"
}

case "${1:-}" in
    --uninstall|--remove|-u) do_uninstall ;;
    --check|--dry-run|-n)    check_machine; ok "this machine can run the desklet" ;;
    --help|-h)               sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' ;;
    "")                      do_install ;;
    *)                       die "unknown option: $1 (try --help)" ;;
esac
