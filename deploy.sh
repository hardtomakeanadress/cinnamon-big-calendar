#!/usr/bin/env bash
# Install the desklet into the user's Cinnamon desklet directory and reload it
# in the running session, without restarting Cinnamon.
#
#   ./deploy.sh            install/update and reload
#   ./deploy.sh --disable  remove from the desktop and uninstall

set -euo pipefail

UUID="bigCalendar@adis"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/cinnamon/desklets/$UUID"
DBUS_DEST="org.Cinnamon"
DBUS_PATH="/org/Cinnamon"
INSTANCE_ID=1
X=400
Y=200

# Is our desklet currently loaded and rendering?
is_loaded() {
    gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
        --method org.Cinnamon.Eval "
        (function(){
          const DM = imports.ui.deskletManager;
          for (let i = 0; i < DM.definitions.length; i++) {
            if (DM.definitions[i].uuid === '$UUID' && DM.definitions[i].desklet) return true;
          }
          return false;
        })()" 2>/dev/null | grep -q "'true'"
}

# Force the shell to drop the compiled module for this desklet.
#
# Toggling enabled-desklets alone is not enough. It destroys the desklet
# *instance*, but the extension stays loaded and Cinnamon re-adds the new
# instance through getModuleByIndex() -- the already-compiled copy. Edits to
# desklet.js then never run, with no error, and the desklet silently keeps
# executing the old code. unloadExtension() is what evicts it from GJS's
# module cache. deleteConfig must be false or it deletes the user's settings.
unload_module() {
    gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
        --method org.Cinnamon.Eval "
        (function(){
          const E = imports.ui.extension;
          try {
            E.unloadExtension('$UUID', E.Type.DESKLET, false, true);
            return 'unloaded';
          } catch (e) { return 'error: ' + e.message; }
        })()" 2>/dev/null | grep -q "unloaded" || true
}

# Unload, wait for the shell to actually drop it, then load again.
#
# The wait is the second half. Withdrawing the entry and putting it straight
# back is a race: if Cinnamon has not finished tearing the old desklet down, it
# keeps the stale instance and skips the reload.
#
# Only this desklet's entries are withdrawn, never the whole list. An entry
# that disappears from enabled-desklets is not merely disabled -- Cinnamon
# removes the desklet and, for a desklet allowed more than one instance,
# deletes its settings file along with it. Blanking the list would therefore
# take the configuration of every other multi-instance desklet on the desktop
# with it, and putting the list back afterwards does not put that back.
reload() {
    local CURRENT
    CURRENT=$(gsettings get org.cinnamon enabled-desklets)

    unload_module

    remove_from_enabled || echo "WARNING: could not withdraw the entry; the reload may not take." >&2
    for _ in $(seq 1 20); do
        is_loaded || break
        sleep 0.5
    done

    if is_loaded; then
        echo "WARNING: desklet did not unload; reload may be incomplete." >&2
    fi

    gsettings set org.cinnamon enabled-desklets "$CURRENT"
    sleep 2
}

log_tail() {
    sleep 2
    # "already loaded" and "Failed to" are the two ways a reload quietly does
    # nothing, so they are matched rather than filtered out.
    tail -c 3000 "$HOME/.xsession-errors" 2>/dev/null \
        | grep -iE "bigCalendar|desklet.*error|JS ERROR|already loaded|Failed to (load|evaluate)" \
        | tail -12 || true
}

# Remove only this desklet's entry, leaving every other desklet enabled.
# Replacing the whole list with [] would disable the user's other desklets too.
#
# A value that cannot be read aborts instead of being treated as an empty list.
# The write below replaces the key outright, so guessing wrong here does not
# fail quietly -- it deletes desklets the user never asked to touch.
#
# The output is json, not Python repr(): repr() writes a control character as
# \x01, which GVariant reads back as the four literal characters "x01", so a
# uuid containing one would be rewritten and that desklet disabled.
remove_from_enabled() {
    local CURRENT UPDATED
    CURRENT=$(gsettings get org.cinnamon enabled-desklets) || return 1

    UPDATED=$(printf '%s' "$CURRENT" | python3 -c '
import ast, json, sys

uuid = sys.argv[1]
raw = sys.stdin.read().strip()
if raw.startswith("@as "):
    raw = raw[4:]

items = ast.literal_eval(raw)
if not isinstance(items, list):
    raise SystemExit("enabled-desklets is not a list")

sys.stdout.write(json.dumps([
    i for i in items
    if not (isinstance(i, str) and i.split(":", 1)[0] == uuid)
]))
' "$UUID") || return 1

    gsettings set org.cinnamon enabled-desklets "$UPDATED" || return 1
}

if [[ "${1:-}" == "--disable" ]]; then
    remove_from_enabled || echo "WARNING: could not remove the entry; remove it in Add desklets." >&2
    sleep 1
    unload_module
    rm -rf "$DEST"
    echo "Removed $UUID."
    exit 0
fi

# lib/ is replaced wholesale rather than merged, so a module deleted from the
# source tree does not linger in the installed copy.
rm -rf "$DEST/lib"
mkdir -p "$DEST/lib"
cp "$SRC/desklet.js" "$SRC/metadata.json" "$SRC/settings-schema.json" "$SRC/stylesheet.css" \
   "$SRC/icon.png" "$SRC/LICENSE" "$DEST/"
cp "$SRC"/lib/*.js "$DEST/lib/"

echo "Installed to $DEST"

# Enable (idempotent: replaces any existing entry for this uuid).
EXISTING=$(gsettings get org.cinnamon enabled-desklets)
if [[ "$EXISTING" != *"$UUID"* ]]; then
    if [[ "$EXISTING" == "@as []" || "$EXISTING" == "[]" ]]; then
        gsettings set org.cinnamon enabled-desklets "['$UUID:$INSTANCE_ID:$X:$Y']"
    else
        INNER="${EXISTING#[}"
        INNER="${INNER%]}"
        gsettings set org.cinnamon enabled-desklets "[$INNER, '$UUID:$INSTANCE_ID:$X:$Y']"
    fi
    echo "Enabled."
else
    reload
    echo "Reloaded."
fi

log_tail
