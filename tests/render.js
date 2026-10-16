import {fixture, assert, equal, Actor, GLib} from './desklet-fixture.js';
let passed=0;
function test(name,fn){const f=fixture();try{fn(f);passed++;print('PASS '+name);}finally{f.cleanup();}}
function descendants(a){return [a,...a.children.flatMap(descendants)];}
test('full month render lays out headings, week numbers and 42 distinct dates',({d})=>{
    d._systemLocale=()=> 'en-US';d.weekStartSetting='monday';d.rows='6';d.showWeekNumbers=true;d.weekNumbering='iso';
    d._render();
    equal(d._titleLabel.text,'October 2026');equal(d._table.children.length,56);
    const cells=d._table.children.filter(a=>a.style_class==='bigcal-cell');equal(cells.length,42);
    equal(cells.slice(0,7).map(a=>a.children[0].children[0].text),['28','29','30','1','2','3','4']);
    equal(d._table.children.filter(a=>a.style_class==='bigcal-weeknum').map(a=>a.text),['#','40','41','42','43','44','45']);
    assert(!d._todayButton.visible&&d._prevButton.visible);
    const old=d._table.children.slice();d.showWeekNumbers=false;d.showNavigation=false;d._view.month=11;d._render();
    equal(d._table.children.length,49);assert(old.every(a=>a.destroyed));assert(d._todayButton.visible&&!d._prevButton.visible);
});
test('day highlights, weekend tint and outside-month fade use valid styles',({d})=>{
    const cell={year:2026,month:9,day:16,inMonth:true,isToday:true,isWeekend:false};
    for(const [style,expected] of [['filled','background-color:'],['ring','border: 2px solid'],['bold','font-weight: bold']]){
        d.todayStyle=style;assert(d._makeDayCell(cell).children[0].children[0].style.includes(expected),style);
    }
    d.todayStyle='none';const weekend=d._makeDayCell({...cell,isToday:false,isWeekend:true,inMonth:false});
    const css=weekend.children[0].children[0].style;assert(css.includes('rgba(')&&css.includes('background-color:'));
});
test('all settings colour sinks reject CSS declarations and preserve valid alpha',({d})=>{
    const props=['bgColor','borderColor','textColor','headerColor','weekdayColor','weekendColor','otherMonthColor','todayBgColor','todayTextColor','weekNumberColor','navColor','gridLineColor'];
    for(const prop of props)d[prop]='red; injected:12345';
    d.showGridLines=true;d.showWeekNumbers=true;d.weekNumbering='iso';d._render();
    assert(![d._root,d._titleLabel,d._todayButton,d._prevButton,d._nextButton,...descendants(d._table)].some(a=>a.style?.includes('injected')));
    for(const bad of ['rgba(1,2,3,2)','rgb(999,2,3)','rgb(1,2,3,0.5)','rgba(1,2,3,.)','url(x)',null]){
        d.borderColor=bad;equal(d._color('borderColor'),'rgba(255,255,255,0.55)');
    }
    d.borderColor='rgba(10,20,30,0.25)';equal(d._color('borderColor'),d.borderColor);
    d._applyRootStyle();assert(d._root.style.includes('rgba(10,20,30,0.25)'));
    equal(d._withAlpha('bad; injected:12345',.5),'rgba(255, 255, 255, 0.50)');
});
test('hidden-event count uses real indexing, slicing and parented width measurement',({d})=>{
    const cell={year:2026,month:9,day:16};const event={summary:'Meeting',color:'#ff0000',allDay:true,start:Date.UTC(2026,9,16),end:Date.UTC(2026,9,17)};
    d._eventIndex=d._index.buildEventIndex([event,{...event,summary:'Two'},{...event,summary:'Three'}]);
    d.eventMax=1;d.eventStyle='dots';const area=d._buildEventArea(cell);
    equal(area.children.length,2);equal(area.children[1].text,'+2');
    equal(d._moreLabelWidth(3),16,'probe should use synthetic parent theme, not unparented width');
    equal(d._root.children.length,0,'measurement probe leaked');
    for(const style of ['bars','titles']){d.eventStyle=style;const a=d._buildEventArea(cell);equal(a.children.length,2);equal(a.children[1].text,'+2');}
});
test('event labels, tooltip limits and dates describe visible entries',({d})=>{
    d._systemLocale=()=> 'en-US';d.eventTimeFormat='24';
    const cell={year:2026,month:9,day:16};const entry={first:true,last:true,event:{summary:'Meeting',allDay:true}};
    equal(d._eventLabel(entry),'Meeting');equal(d._eventLabel({event:{allDay:true}}),'All day');
    const rows=d._tooltipRows(cell,Array.from({length:12},()=>entry));equal(rows.length,12);equal(rows[11].text,'+2 more');
    equal(rows[0].text,'Friday, October 16, 2026');
    const timed={first:true,last:true,event:{summary:'Call',allDay:false,start:new Date(2026,9,16,9).getTime(),end:new Date(2026,9,16,10).getTime()}};
    assert(d._eventLabel(timed).includes('09:00')&&d._eventLabel(timed).includes('Call'));
});
test('font metrics follow DPI and measurement errors degrade safely',({d,stub})=>{
    d.fontScale=100;equal(d._fontDpi(),96);equal(d._emToPx(3),44);
    stub.gi.Clutter.Settings.get_default=()=>({font_dpi:192*1024});equal(d._emToPx(3),88);
    stub.gi.Clutter.Settings.get_default=()=>{throw new Error('no display');};equal(d._fontDpi(),96);
    equal(d._naturalWidth({get_preferred_width(){throw new Error('no theme');}}),0);
});
test('navigation persists the view and refreshes once; invalid saved views are ignored',({d})=>{
    let saved='2025-11',renders=0,reads=0;
    d.settings={isReady:true,getValue:()=>saved,setValue:(key,value)=>saved=value};d.startOnToday=false;
    d._restoreView();equal(d._view,{year:2025,month:11});d._render=()=>renders++;d._refreshEventsSoon=()=>reads++;
    d._shiftMonth(1);equal(d._view,{year:2026,month:0});equal(saved,'2026-0');equal([renders,reads],[1,1]);
    saved='2024-99';d._restoreView();equal(d._view,{year:2026,month:0});
    d._goToToday();const now=new Date();equal(d._view,{year:now.getFullYear(),month:now.getMonth()});equal([renders,reads],[2,2]);
});
test('locale and week-start settings follow explicit choices and system fallback',({d,stub})=>{
    for(const [setting,day] of [['sunday',0],['monday',1],['saturday',6]]){d.weekStartSetting=setting;equal(d._firstDayOfWeek(),day);}
    d.weekStartSetting='auto';equal(d._firstDayOfWeek(),1);
    const old=GLib.get_language_names;
    try{GLib.get_language_names=()=>['ro_RO.UTF-8'];equal(d._systemLocale(),'ro-RO');
        stub.gi.Cinnamon.util_get_week_start=()=>{throw new Error('unavailable');};equal(d._firstDayOfWeek(),1);
        GLib.get_language_names=()=>{throw new Error('unavailable');};equal(d._systemLocale(),'en-US');equal(d._firstDayOfWeek(),0);
    }finally{GLib.get_language_names=old;}
});
print('Render tests passed: '+passed);
