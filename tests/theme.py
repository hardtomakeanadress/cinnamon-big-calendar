#!/usr/bin/env python3
"""Check real St label measurement using temporary, nonreactive Cinnamon actors.
Does not reload, reparent or modify the installed desklet. Exit 77 if unavailable.
"""
import json
from pathlib import Path
import sys

from gi.repository import Gio, GLib

ROOT = Path(__file__).resolve().parents[1]
try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    available = bus.call_sync('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'NameHasOwner', GLib.Variant('(s)', ('org.Cinnamon',)),
        None, Gio.DBusCallFlags.NONE, 5000, None).unpack()[0]
except GLib.Error:
    available = False
if not available:
    print('SKIP: no Cinnamon session available for St theme checks')
    sys.exit(77)

source = (ROOT / 'desklet.js').read_text()
code = '''(()=>{
    const Klass=new Function('imports','global',SOURCE+'\\nreturn BigCalendarDesklet;')(imports,global);
    const St=imports.gi.St, Main=imports.ui.main;
    const widths=[];
    for(const scale of [50,100,200,400]){
        const d=Object.create(Klass.prototype);
        d.fontScale=scale;d._moreWidths=new Map();
        d._root=new St.BoxLayout({reactive:false,opacity:0});
        d._root.set_style('font-size: '+d._basePoints()+'pt;');
        Main.uiGroup.add_child(d._root);
        let area=null,reference=null;
        try{
            reference=d._moreLabel(12);d._root.add_child(reference);
            const expected=reference.get_preferred_width(-1)[1];
            const actual=d._moreLabelWidth(12);
            if(!(actual>0) || actual!==expected)throw new Error('wrong themed width at '+scale);
            if(d._root.get_children().length!==1)throw new Error('measurement actor leaked');
            reference.destroy();reference=null;
            d.showEvents=true;d.eventStyle='dots';d.eventMax=1;
            d._eventIndex={};d._index={eventsOnDay:()=>Array.from({length:3},()=>({event:{color:'#fff'}}))};
            area=d._buildEventArea({year:2026,month:9,day:16});d._root.add_child(area);
            const children=area.get_children();
            if(children.length!==2 || children[1].get_text()!=='+2')throw new Error('hidden count lost at '+scale);
            widths.push(actual);
        }finally{d._root.destroy();}
    }
    if(widths[3]<=widths[0])throw new Error('label measurement ignored font scale');
    return widths;
})()'''.replace('SOURCE', json.dumps(source))
ok, value = bus.call_sync('org.Cinnamon', '/org/Cinnamon', 'org.Cinnamon', 'Eval',
    GLib.Variant('(s)', (code,)), None, Gio.DBusCallFlags.NONE, 15000, None).unpack()
if not ok:
    raise SystemExit('FAIL: Cinnamon theme check: ' + value)
print('PASS: real St label widths and hidden counts at 50/100/200/400%: ' + value)
