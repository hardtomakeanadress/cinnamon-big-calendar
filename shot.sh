#!/usr/bin/env bash
# Screenshot the desklet as it actually renders.
#
# A desklet is drawn on the desktop layer, underneath application windows, so
# a plain screen grab would capture whatever is covering it. This temporarily
# re-parents the desklet's actor to the top-level UI group, captures it, then
# puts it back where it belongs. The user's own windows are never touched.
#
#   ./shot.sh [output.png]
#
#   --opaque   flatten the background to fully opaque for the capture
#
# --opaque exists because lifting the desklet puts it in front of whatever is
# on screen, and the default background is translucent -- the window behind it
# then shows through and ends up in the image. Nothing is written to the
# desklet's settings: the style is re-applied from the settings afterwards, so
# the desklet goes back to looking exactly as it did.

UUID="bigCalendar@adis"
DBUS_DEST="org.Cinnamon"
DBUS_PATH="/org/Cinnamon"
X=300
Y=150
MARGIN=24

OPAQUE=false
OUT=""
for arg in "$@"; do
    case "$arg" in
        --opaque) OPAQUE=true ;;
        *) OUT="$arg" ;;
    esac
done
OUT="${OUT:-/tmp/bigcal.png}"

eval_js() {
    gdbus call --session --dest "$DBUS_DEST" --object-path "$DBUS_PATH" \
        --method org.Cinnamon.Eval "$1" 2>/dev/null
}

FIND="
  const Main = imports.ui.main, DM = imports.ui.deskletManager;
  let f = null;
  for (let i = 0; i < DM.definitions.length; i++) {
    if (DM.definitions[i].uuid === '$UUID' && DM.definitions[i].desklet) {
      f = DM.definitions[i].desklet; break;
    }
  }
"

# --- lift: move the actor above windows and report its size -----------------
# Where it came from is stashed on the desklet first: this must be undone later
# or the tool would quietly move the user's desklet somewhere they did not ask
# for, which is a side effect of taking a picture.
FLATTEN=""
if $OPAQUE; then
    FLATTEN="f._root.set_style('background-color: ' + f.bgColor + '; border-radius: ' + f.cornerRadius + 'px;' + (f.borderWidth > 0 ? ' border: ' + f.borderWidth + 'px solid ' + f.borderColor + ';' : '') + ' padding: ' + f.outerPadding + 'px; font-size: ' + (11 * (f.fontScale / 100)).toFixed(1) + 'pt;');"
fi

LIFT="(function(){ $FIND
  if (!f) return 'NOTFOUND';
  const actor = f.actor;
  const parent = actor.get_parent();
  if (!parent) return 'NOPARENT';
  f.__bcShot = { parent: parent, x: actor.get_x(), y: actor.get_y() };
  // The desklet container lives inside Meta_WindowGroup, and Main.uiGroup is
  // below that on the stage, so the only way above application windows is to
  // append the actor to the stage itself (last child == topmost).
  parent.remove_actor(actor);
  global.stage.add_actor(actor);
  actor.set_position($X, $Y);
  $FLATTEN
  return actor.get_width() + 'x' + actor.get_height();
})()"

RESULT=$(eval_js "$LIFT")

# gdbus wraps the string in quotes and escapes it; pull out the WxH payload.
SIZE=$(printf '%s' "$RESULT" | python3 -c "
import sys, re
m = re.search(r'(\d+)x(\d+)', sys.stdin.read())
print(m.group(0) if m else '')
")

if [[ -z "$SIZE" ]]; then
    echo "Could not determine desklet size. Raw reply: $RESULT" >&2
    exit 1
fi

W=${SIZE%x*}
H=${SIZE#*x}
echo "rendered size: ${W}x${H}"

# --- capture ---------------------------------------------------------------
# Give the compositor a frame to actually paint the re-parented actor; without
# this the grab returns the previous frame and the desklet is missing.
sleep 1
rm -f "$OUT"
gdbus call --session --dest "$DBUS_DEST" --object-path "$DBUS_PATH" \
    --method org.Cinnamon.ScreenshotArea false \
    $((X - MARGIN)) $((Y - MARGIN)) $((W + MARGIN * 2)) $((H + MARGIN * 2)) false "$OUT" \
    >/dev/null 2>&1

# The grab is asynchronous: the call returns before the compositor has painted
# and written the file, so restoring straight away gets a picture of the
# desklet already back in its usual place -- under the windows, which is what
# half the captures used to come back showing. Wait for the file to land.
for _ in $(seq 1 40); do
    [[ -s "$OUT" ]] && break
    sleep 0.25
done

# --- restore: the original parent *and* position ----------------------------
eval_js "(function(){ $FIND
  if (!f) return 'gone';
  const saved = f.__bcShot;
  if (!saved) return 'NOSAVED';
  const parent = f.actor.get_parent();
  if (parent) parent.remove_actor(f.actor);
  saved.parent.add_actor(f.actor);
  f.actor.set_position(saved.x, saved.y);
  // Puts the background back to whatever the settings say, undoing --opaque.
  f._applyRootStyle();
  delete f.__bcShot;
  return 'restored';
})()" >/dev/null

if [[ -s "$OUT" ]]; then
    echo "wrote $OUT"
else
    echo "screenshot did not appear" >&2
    exit 1
fi
