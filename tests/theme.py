#!/usr/bin/env python3
"""Check real St measurements and allocations with temporary Cinnamon actors.
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
    try {
    const source=SOURCE;
    const [Klass,Tip]=new Function('imports','global',source+'\\nreturn [BigCalendarDesklet,DayTooltip];')(imports,global);
    const schema=SCHEMA;
    const St=imports.gi.St, Clutter=imports.gi.Clutter, Main=imports.ui.main;
    const allocate=(actor,w,h)=>actor.allocate(new Clutter.ActorBox({x1:0,y1:0,x2:w,y2:h}),0);
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const widths=[];
    for(const scale of [50,100,200,400]){
        const d=Object.create(Klass.prototype);
        for(const [,key,prop] of source.matchAll(/s.bind\\("([^\"]+)", "([^\"]+)"/g))d[prop]=schema[key].default;
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
            area.destroy();area=null;
            d.eventStyle='titles';d.eventMax=3;d.showEventTooltips=false;
            d._entriesFor=cell=>cell.day===1?Array.from({length:2},()=>({event:{summary:'Long meeting '.repeat(20),allDay:true}})):[];
            d._utils={weekdayNames:()=>['Mon','Tue','Wed','Thu','Fri','Sat','Sun']};
            for(const grid of [false,true]){
                d.showGridLines=grid;
                d._table=new St.Table({homogeneous:false,reactive:false});d._root.add_child(d._table);
                d._renderWeekdayHeader(1,true);
                d._renderWeeks([{week:{week:42},days:Array.from({length:7},(_,i)=>({year:2026,month:9,day:i+1,inMonth:true}))}],true);
                const w=d._table.get_preferred_width(-1)[1], h=d._table.get_preferred_height(w)[1];
                allocate(d._table,w,h);
                const actors=d._table.get_children(),cells=actors.filter(a=>a.has_style_class_name('bigcal-cell'));
                const first=cells[0],cellBox=first.get_allocation_box();
                const content=first.get_theme_node().get_content_box(new Clutter.ActorBox({x1:0,y1:0,x2:first.width,y2:first.height}));
                const list=first.get_children()[1],listBox=list.get_allocation_box();
                check(listBox.x1>=content.x1&&listBox.x2<=content.x2,'title list outside cell at '+scale+'/'+grid);
                for(const label of list.get_children())check(label.width<=content.x2-content.x1,'title wider than content at '+scale+'/'+grid);
                for(const cell of cells){
                    const box=cell.get_allocation_box();
                    check(box.y1===cellBox.y1&&box.y2===cellBox.y2,'grid cells have unequal heights');
                    check(cell.get_theme_node().get_border_width(St.Side.LEFT)===(grid?1:0),'border is not on cell');
                    check(cell.get_children()[0].get_child().get_theme_node().get_border_width(St.Side.LEFT)===0,'grid border surrounds number');
                }
                for(let i=0;i<8;i++){
                    const heading=actors[i].get_allocation_box(),day=actors[i+8].get_allocation_box();
                    check(heading.x1===day.x1&&heading.x2===day.x2,'heading border does not span column');
                    check(actors[i].get_theme_node().get_border_width(St.Side.LEFT)===(grid?1:0),'heading border missing');
                }
                d._table.destroy();
            }
            const tip=new Tip();
            try{
                tip._actor.opacity=0;tip.setSurface('#303036',d._basePoints());
                const m=Main.layoutManager.primaryMonitor;
                tip._pointer=[m.x+m.width-1,m.y+m.height-1];
                tip.show(Array.from({length:12},(_,i)=>({text:'Long event '.repeat(60),color:i?'#ff0000':null})));
                allocate(tip._actor,tip._actor.width,tip._actor.height);
                check(tip._actor.x>=m.x&&tip._actor.x+tip._actor.width<=m.x+m.width,'tooltip exceeds monitor width');
                check(tip._actor.y>=m.y&&tip._actor.y+tip._actor.height<=m.y+m.height,'tooltip exceeds monitor height');
                check(tip._actor.clip_to_allocation,'tall tooltip is not clipped');
                for(const label of tip._actor.get_children()){
                    check(label.clutter_text.ellipsize===imports.gi.Pango.EllipsizeMode.END,'tooltip title is not ellipsized');
                    check(label.width<=tip._actor.width,'tooltip label overflows');
                }
                tip.show([{text:'Short'}]);
                check(tip._actor.width<m.width,'tooltip retained previous width');
            }finally{tip.destroy();}
        }finally{d._root.destroy();}
    }
    if(widths[3]<=widths[0])throw new Error('label measurement ignored font scale');
    return widths;
    } catch(e) { return {error:e.message,stack:e.stack}; }
})()'''.replace('SCHEMA', (ROOT / 'settings-schema.json').read_text()).replace('SOURCE', json.dumps(source))
ok, value = bus.call_sync('org.Cinnamon', '/org/Cinnamon', 'org.Cinnamon', 'Eval',
    GLib.Variant('(s)', (code,)), None, Gio.DBusCallFlags.NONE, 15000, None).unpack()
if not ok or isinstance(json.loads(value), dict):
    raise SystemExit('FAIL: Cinnamon theme check: ' + value)
print('PASS: real St labels, cell borders, title allocations and tooltip bounds at 50/100/200/400%: ' + value)
