#!/usr/bin/env bash
# Capture the running desklet, restoring its parent, position and style on exit.
# Usage: ./shot.sh [--opaque] [new-output.png]
# Existing output files are never overwritten.
set -euo pipefail
OPAQUE=false
OUT=""
for arg in "$@"; do
    case "$arg" in
        --opaque) OPAQUE=true ;;
        --help|-h) sed -n '2,4p' "$0" | sed 's/^# //'; exit 0 ;;
        -*) echo "Unknown option: $arg" >&2; exit 1 ;;
        *) [[ -z "$OUT" ]] || { echo "Only one output path is allowed" >&2; exit 1; }; OUT="$arg" ;;
    esac
done
if [[ -z "$OUT" ]]; then
    OUT="$(mktemp -d /tmp/big-calendar-shot.XXXXXX)/screenshot.png"
fi
[[ ! -e "$OUT" && ! -L "$OUT" ]] || { echo "Output already exists: $OUT" >&2; exit 1; }
OUT=$(realpath -m -- "$OUT")
CAPTURE_DIR=$(mktemp -d "$(dirname "$OUT")/.big-calendar-shot.XXXXXX")
CAPTURE="$CAPTURE_DIR/capture.png"
TOKEN=$(basename "$CAPTURE_DIR")
RESTORED=false
eval_js() {
    gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
        --method org.Cinnamon.Eval "$1"
}
FIND="const f=imports.ui.deskletManager.definitions.find(x=>x.uuid==='bigCalendar@adis')?.desklet;"
restore() {
    local status=$? reply
    trap - EXIT INT TERM
    if $RESTORED; then
        rm -rf -- "$CAPTURE_DIR"
        exit "$status"
    fi
    if ! reply=$(eval_js "(()=>{$FIND const s=f?.__bcShot;if(!s || s.token!=='$TOKEN')return 'nothing';s.restore();return 'restored';})()"); then
        echo "Could not restore desklet; the in-process recovery timer will retry." >&2
        status=1
    elif [[ "$reply" != *restored* && "$reply" != *nothing* ]]; then
        echo "Desklet restoration failed: $reply" >&2
        status=1
    fi
    rm -rf -- "$CAPTURE_DIR"
    exit "$status"
}
trap restore EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
RESULT=$(eval_js "(()=>{
    $FIND
    if(!f || !f._root)return 'NOTREADY';
    if(f.__bcShot)return 'BUSY';
    const a=f.actor,p=a.get_parent();if(!p)return 'NOPARENT';
    const s={token:'$TOKEN',parent:p,x:a.x,y:a.y,style:f._root.get_style(),timer:0};
    s.restore=()=>{
        if(s.timer){imports.gi.GLib.source_remove(s.timer);s.timer=0;}
        const current=a.get_parent();if(current)current.remove_child(a);
        s.parent.add_child(a);a.set_position(s.x,s.y);f._root.set_style(s.style);
        delete f.__bcShot;
    };
    f.__bcShot=s;
    s.timer=imports.gi.GLib.timeout_add(imports.gi.GLib.PRIORITY_DEFAULT,20000,()=>{
        s.timer=0;s.restore();return imports.gi.GLib.SOURCE_REMOVE;
    });
    p.remove_child(a);global.stage.add_child(a);a.set_position(24,24);
    if($OPAQUE)f._root.set_style(s.style+' background-color: '+f.bgColor+';');
    return Math.ceil(a.width)+'x'+Math.ceil(a.height);
})()")
SIZE=$(printf '%s' "$RESULT" | python3 -c 'import re,sys; m=re.search(r"(\d+)x(\d+)",sys.stdin.read()); print(m[0] if m else "")')
[[ -n "$SIZE" ]] || { echo "Could not capture desklet: $RESULT" >&2; exit 1; }
W=${SIZE%x*}; H=${SIZE#*x}
sleep 1
gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
    --method org.Cinnamon.ScreenshotArea false 0 0 "$((W+48))" "$((H+48))" false "$CAPTURE" >/dev/null
for ((i=0;i<40;i++)); do
    [[ ! -s "$CAPTURE" ]] || break
    sleep .25
done
[[ -s "$CAPTURE" ]] || { echo "Screenshot did not appear" >&2; exit 1; }
# Restore before publishing. If recovery ran during any part of capture, the
# token is gone and the image cannot be certified as the staged desklet.
REPLY=$(eval_js "(()=>{$FIND const s=f?.__bcShot;if(!s || s.token!=='$TOKEN')return 'nothing';s.restore();return 'restored';})()")
[[ "$REPLY" == "(true, "* && "$REPLY" == *'"restored"'* ]] || { echo "Capture expired or restoration failed; no screenshot published." >&2; exit 1; }
RESTORED=true
# Both files are on the same filesystem. A hard link refuses a destination
# created by someone else since the initial check, without a check/write race.
ln -- "$CAPTURE" "$OUT"
echo "Wrote $OUT"
