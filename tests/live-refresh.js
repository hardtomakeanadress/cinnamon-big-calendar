import GLib from 'gi://GLib';
import ECal from 'gi://ECal?version=2.0';
import ICal from 'gi://ICalGLib?version=3.0';
import System from 'system';
import {CalendarFeed} from '../lib/calendarSource.js';
if (GLib.getenv('BIG_CALENDAR_ISOLATED_TEST') !== '1') throw new Error('Run through tests/isolated-refresh.sh');
const uidFixture=GLib.uuid_string_random();
const sleep=ms=>new Promise(resolve=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
let signals=0, ticks=0, maxGap=0, last=GLib.get_monotonic_time();
const timer=GLib.timeout_add(GLib.PRIORITY_DEFAULT,10,()=>{let n=GLib.get_monotonic_time();maxGap=Math.max(maxGap,(n-last)/1000);last=n;ticks++;return GLib.SOURCE_CONTINUE;});
let feed=new CalendarFeed(()=>signals++,e=>printerr(e.message));
try {
await feed.open();
const entry=feed._entries.find(e=>e.uid==='system-calendar');
if(!entry)throw new Error('Private local calendar not found');
let c=entry.client;
const call=(name,args)=>new Promise((resolve,reject)=>c[name](...args,null,(client,res)=>{try{resolve(client[name+'_finish'](res));}catch(e){reject(e);}}));
const start=Date.UTC(2026,9,1),end=Date.UTC(2026,10,1);
const component=summary=>ICal.Component.new_from_string('BEGIN:VEVENT\r\nUID:'+uidFixture+'\r\nDTSTART:20261014T090000Z\r\nDTEND:20261014T100000Z\r\nSUMMARY:'+summary+'\r\nEND:VEVENT\r\n');
await feed.query(start,end);signals=0;
async function waitForChange(before,expected){
 const begin=GLib.get_monotonic_time();
 for(let i=0;i<100;i++){
  if(signals>before){const events=await feed.query(start,end,false);if(expected(events)){print('change visible after '+((GLib.get_monotonic_time()-begin)/1000).toFixed(1)+' ms');return;}}
  await sleep(25);
 }
 throw new Error('Change notification or query failed');
}
let before=signals;
const created=await call('create_object',[component('fixture'),ECal.OperationFlags.NONE]);
const uid=created[1];
await waitForChange(before,events=>events.some(e=>e.summary==='fixture'));
before=signals;
await call('modify_object',[component('edited fixture'),ECal.ObjModType.ALL,ECal.OperationFlags.NONE]);
await waitForChange(before,events=>events.some(e=>e.summary==='edited fixture'));
before=signals;
await call('remove_object',[uid,null,ECal.ObjModType.ALL,ECal.OperationFlags.NONE]);
await waitForChange(before,events=>events.length===0);
// Moving a recurring occurrence outside the queried month must remove its old slot.
const seriesUid=GLib.uuid_string_random();
const series=ICal.Component.new_from_string('BEGIN:VEVENT\r\nUID:'+seriesUid+'\r\nDTSTART:20261001T090000Z\r\nDTEND:20261001T100000Z\r\nRRULE:FREQ=WEEKLY;COUNT=5\r\nSUMMARY:series fixture\r\nEND:VEVENT\r\n');
await call('create_object',[series,ECal.OperationFlags.NONE]);
const moved=ICal.Component.new_from_string('BEGIN:VEVENT\r\nUID:'+seriesUid+'\r\nRECURRENCE-ID:20261015T090000Z\r\nDTSTART:20261215T090000Z\r\nDTEND:20261215T100000Z\r\nSUMMARY:moved fixture\r\nEND:VEVENT\r\n');
await call('modify_object',[moved,ECal.ObjModType.THIS,ECal.OperationFlags.NONE]);
const october=await feed.query(start,end);
print('Recurring events after moving one outside October: '+october.length+' (expected 4)');
if(october.length!==4) { print(JSON.stringify(october)); const family=await call('get_objects_for_uid',[seriesUid]);for(const item of family[1])print(item.get_as_string());throw new Error('Moved recurrence remains in original month'); }
await call('remove_object',[seriesUid,null,ECal.ObjModType.ALL,ECal.OperationFlags.NONE]);
c=null;
print(JSON.stringify({signals,ticks,maxGapMs:maxGap}));
} finally {
    feed.destroy();feed=null;GLib.source_remove(timer);System.gc();
    await sleep(150);
}
