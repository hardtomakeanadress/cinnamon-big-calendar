import {requireCalendarLibraries} from './require-calendar.js';
await requireCalendarLibraries();
const {default:ECal}=await import('gi://ECal?version=2.0');
const {CalendarFeed}=await import('../lib/calendarSource.js');
import GLib from 'gi://GLib';
import {assert,equal} from './desklet-fixture.js';
let passed=0;
async function test(name,fn){await fn();passed++;print('PASS '+name);}
function client(){let next=0;const signals=new Set();return {signals,connect(){signals.add(++next);return next;},disconnect(id){signals.delete(id);}};}
function source(uid){return {get_uid:()=>uid,get_display_name:()=>uid,get_extension:()=>({get_selected:()=>true,get_color:()=> '#123456'})};}
await test('real openAll connects, merges and replaces dead entries without leaking handlers',async()=>{
    const oldConnect=ECal.Client.connect,oldFinish=ECal.Client.connect_finish;
    const f=new CalendarFeed();let attempts=0,fail=true;const clients=[];
    ECal.Client.connect=(s,type,wait,cancel,cb)=>{attempts++;if(s.get_uid()==='retry'&&fail)throw new Error('offline');const c=client();clients.push(c);cb(null,c);};
    ECal.Client.connect_finish=result=>result;
    const registry={list_sources:()=>['a','retry'].map(source),check_enabled:()=>true};
    try{
        await f._openAll(registry);equal(f.calendars.map(c=>c.uid),['a']);equal(attempts,2);equal(clients[0].signals.size,2);
        const original=f._entries[0];fail=false;await f._openAll(registry);equal(attempts,3);assert(f._entries[0]===original);equal(f.calendars.map(c=>c.uid),['a','retry']);
        original.dead=true;original.cached={events:[{uid:'kept'}]};await f._openAll(registry);
        equal(attempts,4);equal(clients[0].signals.size,0);equal(f._entries.find(e=>e.uid==='a').cached,original.cached);
    }finally{f.destroy();ECal.Client.connect=oldConnect;ECal.Client.connect_finish=oldFinish;}
    assert(clients.every(c=>c.signals.size===0),'handlers leaked');
});
function component(uid,...lines){return ECal.Component.new_from_string(['BEGIN:VEVENT','UID:'+uid,'SUMMARY:'+uid,...lines,'END:VEVENT'].join('\r\n'));}
await test('query fetches recurrence families two at a time and applies moved exceptions',async()=>{
    const masters=['a','b','c'].map(uid=>component(uid,'DTSTART:20261001T090000Z','DTEND:20261001T100000Z','RRULE:FREQ=DAILY;COUNT=3'));
    const moved=component('a','RECURRENCE-ID:20261002T090000Z','DTSTART:20261020T090000Z','DTEND:20261020T100000Z');
    const movedInside=component('b','RECURRENCE-ID:20261002T090000Z','DTSTART:20261002T120000Z','DTEND:20261002T130000Z');
    const families={a:[masters[0],moved],b:[masters[1],movedInside],c:[masters[2]]};
    let active=0,peak=0,fetches=[],listCalls=0,fail=false;
    const c=client();
    Object.assign(c,{
        get_object_list_as_comps(q,cancel,cb){listCalls++;cb(this,{});},
        get_object_list_as_comps_finish(){return [true,[...masters,masters[0],component('outside','DTSTART:20261030T090000Z','DTEND:20261030T100000Z')]];},
        get_objects_for_uid(uid,cancel,cb){fetches.push(uid);peak=Math.max(peak,++active);GLib.idle_add(GLib.PRIORITY_DEFAULT,()=>{active--;cb(this,uid);return GLib.SOURCE_REMOVE;});},
        get_objects_for_uid_finish(uid){if(fail)throw new Error('family unavailable');return [true,families[uid]];}
    });
    const f=new CalendarFeed();const entry={uid:'calendar',name:'Test',color:'#123456',client:c};f._watchEntry(entry);f._entries=[entry];
    try{
        const range=[Date.UTC(2026,9,1),Date.UTC(2026,9,4)];const events=await f.query(...range);
        equal(peak,2);equal(fetches.sort(),['a','b','c']);equal(events.length,8);
        assert(!events.some(e=>e.uid==='outside'||e.uid==='a'&&e.start===Date.UTC(2026,9,2,9)),'out-of-window or old occurrence survived');
        assert(events.some(e=>e.uid==='b'&&e.start===Date.UTC(2026,9,2,12)),'moved occurrence missing');
        await f.query(...range,false);equal(listCalls,1,'clean cache fetched again');
        entry.dirty=true;fail=true;equal(await f.query(...range,false),events,'family failure erased last good cache');assert(entry.dirty);
        equal(await f.query(Date.UTC(2026,10,1),Date.UTC(2026,10,4)),[],'failed new range reused old events');
    }finally{f.destroy();}
});
print('Query tests passed: '+passed);
