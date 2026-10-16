/* Refresh regression tests; no live account or Cinnamon process required.
 * Run: cjs -m tests/refresh.js */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { requireCalendarLibraries } from './require-calendar.js';
await requireCalendarLibraries();
const { CalendarFeed, calendarCall } = await import('../lib/calendarSource.js');
import * as index from '../lib/eventIndex.js';
import * as utils from '../lib/calendarUtils.js';

let passed = 0;
function assert(value, message) { if (!value) throw new Error(message); }
async function test(name, fn) {
    await fn(); passed++; print('PASS ' + name);
}
await test('a nonresponding service times out and cancels its operation', async () => {
    let child; let rejected=false;
    try { await calendarCall(null, c=>{child=c;}, ()=>{}, 25); }
    catch(e){rejected=/timed out/.test(e.message);}
    assert(rejected && child.is_cancelled(), 'operation or queue stayed stuck');
});
await test('parent cancellation reaches the pending operation', async () => {
    const parent=new Gio.Cancellable();let child,callback;
    const task=calendarCall(parent,(c,cb)=>{child=c;callback=cb;},()=>true,100);
    parent.cancel();assert(child.is_cancelled(),'cancellation not forwarded');
    callback(null,null);await task;
});
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((a,b) => { resolve=a; reject=b; });
    return { promise, resolve, reject };
};
function client() {
    const signals = new Map(); let id = 0;
    return {
        calls: 0, refreshes: 0, fail: false, events: [],
        connect(name, fn) { signals.set(++id, {name, fn}); return id; },
        disconnect(id) { signals.delete(id); },
        emit(name, ...args) { for (const s of signals.values()) if (s.name === name) s.fn(this, ...args); },
        get signalCount() { return signals.size; },
        get_object_list_as_comps(sexp, cancellable, cb) { this.calls++; cb(this, {}); },
        get_object_list_as_comps_finish() { if (this.fail) throw new Error('offline'); return [this.events.length > 0, this.events]; },
        check_refresh_supported() { return true; },
        refresh(cancellable, cb) { this.refreshes++; this.refreshCallback = cb; },
        refresh_finish() { return true; }
    };
}
function feedFixture() {
    const c = client(); let changes=0, errors=0;
    const feed = new CalendarFeed(() => changes++, () => errors++);
    const entry = {uid: 'test', client:c, name:'Test', color:'#fff'};
    feed._watchEntry(entry); feed._entries=[entry];
    feed._collect = components => components;
    feed.open = async () => {};
    return {feed, c, entry, get changes(){return changes;}, get errors(){return errors;}};
}
const event = { uid:'one',start:Date.UTC(2026,9,14),end:Date.UTC(2026,9,15),allDay:true,summary:'test',color:'#fff',calendar:'Test' };
await test('revision invalidates only changed calendar, repeated notifications are harmless', async () => {
    const f=feedFixture(); f.c.events=[event];
    await f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1)); await f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1),false);
    assert(f.c.calls===1,'clean cache should not be read again');
    f.c.emit('backend-property-changed','revision','new');
    assert(f.changes===1 && f.entry.dirty,'notification not delivered');
    await f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1),false);
    assert(f.c.calls===2,'changed cache not read');
    f.c.emit('backend-property-changed','readonly','TRUE');
    assert(f.changes===1,'unrelated property triggered work');
    f.feed.destroy(); assert(f.c.signalCount===0,'signals leaked');
    f.c.emit('backend-property-changed','revision','late');
    assert(f.changes===1,'callback after destruction');
});
await test('temporary failure keeps last successful range and reports error once', async () => {
    const f=feedFixture(); f.c.events=[event];
    await f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1)); f.c.fail=true;
    assert((await f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1))).length===1,'events disappeared');
    await f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1)); assert(f.errors===1,'duplicate log spam');
    assert((await f.feed.query(100,200)).length===0,'wrong month reused');
    f.c.fail=false; f.c.events=[];
    assert((await f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1))).length===0,'real deletion not reflected');
    f.feed.destroy();
});
await test('backend death marks client for reconnect and preserves last events', async () => {
    const f=feedFixture(); f.c.events=[event]; await f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1));
    f.c.emit('backend-died');
    assert(f.entry.dead && f.changes===1,'dead connection retained as healthy');
    assert((await f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1))).length===1,'dead backend erased events'); f.feed.destroy();
});
await test('manual online requests share in-flight work and enforce cooldown', async () => {
    const f=feedFixture();
    const one=f.feed.refreshRemote(), two=f.feed.refreshRemote();
    await Promise.resolve(); await Promise.resolve();
    assert(one===two && f.c.refreshes===1,'duplicate online requests');
    f.c.refreshCallback(f.c,{}); await one;
    await f.feed.refreshRemote(); assert(f.c.refreshes===1,'cooldown missing');
    f.feed.destroy();
});
await test('revision arriving during a query remains dirty for another read', async () => {
    const f=feedFixture(); let finish;
    f.c.get_object_list_as_comps=(s,c,cb)=>{finish=cb;};
    const pending=f.feed.query(Date.UTC(2026,9,1),Date.UTC(2026,10,1));
    f.c.emit('backend-property-changed','revision','next');
    finish(f.c,{}); await pending;
    assert(f.entry.dirty,'concurrent change lost'); f.feed.destroy();
});

// Load the real desklet methods with only Cinnamon UI imports stubbed. Tests
// create no desktop actors and run the actual query/lifecycle implementation.
const [,bytes]=Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('desklet.js').load_contents(null);
const source=new TextDecoder().decode(bytes);
const stubImports={
    gi:{Gio,GLib,Clutter:{EVENT_PROPAGATE:0,EVENT_STOP:1,ScrollDirection:{UP:0,DOWN:1,SMOOTH:2}}}, mainloop:{},
    gettext:{bindtextdomain(){},dgettext(d,t){return t;}},
    ui:{tooltips:{},desklet:{Desklet:class {}},settings:{},main:{}}
};
const DeskletClass=new Function('imports','logError',source+'\nreturn BigCalendarDesklet;')(stubImports,()=>{});
function desklet(feed) {
    const d=Object.create(DeskletClass.prototype);
    Object.assign(d,{_feed:feed,_destroyed:false,showEvents:true,_fetchToken:0,_refreshTask:null,_refreshQueued:false,_refreshForce:false,
        _utils:utils,_index:index,_view:{year:2026,month:9},rows:6,_eventIndex:{},_eventSignature:null,renders:0});
    d._firstDayOfWeek=()=>1; d._render=()=>d.renders++;
    return d;
}
await test('settings upgrades preserve valid numeric endpoints without changing Cinnamon globally', async () => {
    const checked=[];
    class NativeSettings {
        constructor() {
            this.isReady = true;
            for (const type of ['scale','spinbutton']) {
                for (const value of [0,100,50,-1,101,NaN,'100'])
                    checked.push(this._checkSanity(value,{type,min:0,max:100}));
            }
            checked.push(this._checkSanity('dots',{type:'combobox'}));
        }
        _checkSanity(value,setting) { return setting.type==='combobox'; }
        bind() {}
    }
    stubImports.ui.settings.DeskletSettings=NativeSettings;
    const d=desklet(null);d.metadata={uuid:'bigCalendar@adis'};
    d._bindSettings();
    assert(JSON.stringify(checked)===JSON.stringify([true,true,true,false,false,false,false,true,true,true,false,false,false,false,true]),'numeric endpoints lost or invalid values accepted');
    assert(!NativeSettings.prototype._checkSanity(0,{type:'scale'}),'global settings class changed');
});
await test('rapid requests serialize queries and apply only the latest view', async () => {
    const pending=[]; let active=0,maxActive=0;
    const feed={open:async()=>{},query:async()=>{
        active++;maxActive=Math.max(maxActive,active);
        const p=deferred();pending.push(p);const result=await p.promise;active--;return result;
    }};
    const d=desklet(feed);const done=d._refreshEvents();
    await Promise.resolve(); await Promise.resolve();
    assert(pending.length===1,'initial query missing');
    d._view.month=10;d._refreshEvents();d._view.month=9;d._refreshEvents();
    assert(pending.length===1,'overlapping query');pending[0].resolve([event]);
    for(let i=0;i<10 && pending.length<2;i++) await Promise.resolve();
    assert(pending.length===2 && d.renders===0,'stale render or missing trailing request');
    pending[1].resolve([event]);await done;
    assert(maxActive===1 && d.renders===1,'queue did not coalesce');
});
await test('unchanged events do not redraw; edits and deletions do', async () => {
    let events=[event];const d=desklet({open:async()=>{},query:async()=>events});
    await d._refreshEvents(); await d._refreshEvents();assert(d.renders===1,'unchanged redraw');
    events=[{...event,summary:'changed'}];await d._refreshEvents();assert(d.renders===2,'edit missed');
    events=[];await d._refreshEvents();assert(d.renders===3,'deletion missed');
});
await test('disabling or replacing feed ignores pending old responses', async () => {
    const p=deferred();const d=desklet({open:async()=>{},query:()=>p.promise});
    const done=d._refreshEvents();await Promise.resolve();await Promise.resolve();
    d.showEvents=false;p.resolve([event]);await done;
    assert(d.renders===0 && Object.keys(d._eventIndex).length===0,'disabled events resurrected');
    const old=deferred();d.showEvents=true;d._feed={open:async()=>{},query:()=>old.promise};
    const done2=d._refreshEvents();await Promise.resolve();await Promise.resolve();
    d._feed={open:async()=>{},query:async()=>[]};d._refreshEvents();old.resolve([event]);await done2;
    assert(Object.keys(d._eventIndex).length===0,'old feed populated new feed');
});
await test('startup recovery is armed before registry opening and feed is not duplicated', async () => {
    const order=[];let made=0;const d=desklet(null);
    d._source={CalendarFeed:class{constructor(){made++;}}};
    d._startEventTimer=()=>order.push('timer');d._refreshEventsSoon=()=>order.push('open');
    d._openFeed();d._openFeed();assert(made===1 && order.join(',')==='timer,open','startup recovery broken');
});
await test('failed module loading does not arm a timer that dereferences null', async () => {
    const d=desklet(null);d._utils=null;
    d._timerAlive=()=>{throw new Error('timer should not be examined');};
    d._dayTimer=0;
    d._startDayTimer();
    assert(d._dayTimer===0, 'failed bootstrap armed a day timer');
});
await test('smooth touchpad events accumulate while horizontal scrolling propagates', async () => {
    const d=desklet(null);d.mouseWheelNavigation=true;const moved=[];d._shiftMonth=n=>moved.push(n);
    const event={get_scroll_direction:()=>2,get_scroll_delta:()=>[0,0.4]};
    d._onScroll(event);d._onScroll(event);assert(moved.length===0,'touchpad too sensitive');
    d._onScroll(event);assert(moved.join(',')==='1','touchpad did not navigate');
    assert(d._onScroll({get_scroll_direction:()=>2,get_scroll_delta:()=>[1,0]})===0,'horizontal scroll swallowed');
    d.mouseWheelNavigation=false;assert(d._onScroll(event)===0,'disabled navigation consumed scroll');
});
await test('a burst of cache notifications schedules just one update', async () => {
    const d=desklet(null);let callbacks=[],reads=0;
    d._timerAlive=name=>!!d[name];
    stubImports.mainloop.timeout_add=(ms,cb)=>{callbacks.push(cb);return callbacks.length;};
    d._refreshEventsSoon=force=>{assert(force===false,'notification forced all calendars');reads++;};
    for(let i=0;i<100;i++)d._calendarChanged();
    assert(callbacks.length===1,'notification storm scheduled redundant work');
    callbacks[0]();assert(reads===1 && d._eventChangeTimer===0,'batched update missing');
});

await test('hidden event count appears when event-max is below available dot space', async () => {
    class Actor {
        constructor(props={}) {Object.assign(this,props);this.children=[];}
        set_style(s){this.style=s;} set_size(){} add(a){this.children.push(a);} set_text(t){this.text=t;}
    }
    stubImports.gi.St={}; // St is captured at load, so load the renderer afresh.
    stubImports.gi.St={BoxLayout:Actor,Bin:Actor,Label:Actor};
    const Klass=new Function('imports','logError',source+'\nreturn BigCalendarDesklet;')(stubImports,()=>{});
    const d=Object.create(Klass.prototype);
    d.eventStyle='dots';d.eventMax=1;d._entriesFor=()=>Array.from({length:3},()=>({event:{color:'#fff; padding:999px'}}));
    d._emToPx=em=>Math.round(em*20);d._moreLabelWidth=()=>15;
    const area=d._buildEventArea({});
    assert(area.children.length===2 && area.children[1].text==='+2','hidden count missing');
    assert(!area.children[0].style.includes('999px'),'calendar CSS was accepted without validation');
});
await test('removed desklet cannot reclaim input even if a late callback runs', async () => {
    const d=desklet(null);d._destroyed=true;d._windowOverlaps=()=>{throw new Error('dead actor accessed');};
    d._trackMouse();let released=false;d._untrackMouse=()=>{released=true;};d._syncInputRegion();
    assert(released,'dead instance reclaimed input');
});
await test('periodic refresh defaults to 300 seconds and requests online sync', async () => {
    const d=desklet({});let seconds,callback,requests=0;
    d._timerAlive=()=>!!d._eventTimer;
    stubImports.mainloop.timeout_add_seconds=(interval,cb)=>{seconds=interval;callback=cb;return 123;};
    d._requestRemoteRefresh=()=>{requests++;return Promise.resolve();};
    d._startEventTimer();assert(seconds===300,'default is not five minutes');
    d._startEventTimer();assert(d._eventTimer===123,'watchdog replaced the timer');
    assert(callback()===GLib.SOURCE_CONTINUE && requests===1,'timer did not request online sync');
    d._destroyed=true;assert(callback()===GLib.SOURCE_REMOVE && requests===1,'removed desklet requested sync');
});
await test('background refresh honors every preset and bounds invalid intervals', async () => {
    const d=desklet({});let seconds;
    d._timerAlive=()=>false;
    stubImports.mainloop.timeout_add_seconds=interval=>{seconds=interval;return 123;};
    for (const minutes of [1,5,10,15,20,30,60,120,240]) {
        d.eventRefresh=minutes;d._startEventTimer();
        assert(seconds===minutes*60,'wrong timer for '+minutes+' minutes');
    }
    for (const [value,expected] of [[undefined,300],['bad',300],[Infinity,300],[0,300],[-1,300],[0.5,60],[999,14400]]) {
        d.eventRefresh=value;d._startEventTimer();
        assert(seconds===expected,'unsafe timer for '+value);
    }
});
await test('online refresh coalesces callers and rereads local cache once', async () => {
    const pending=deferred();let requests=0,reads=0;
    const d=desklet({refreshRemote(){requests++;return pending.promise;}});
    d._refreshEventsSoon=()=>reads++;
    const task=d._requestRemoteRefresh();await d._requestRemoteRefresh();
    assert(requests===1 && reads===0,'duplicate request or premature cache read');
    pending.resolve({requested:1,failed:0});await task;
    assert(reads===1 && !d._remoteRefreshPending,'cache read missing or pending flag retained');
});
await test('failed online sync still runs the local recovery check', async () => {
    let reads=0;const d=desklet({refreshRemote:async()=>{throw new Error('offline');}});
    d._refreshEventsSoon=()=>reads++;
    await d._requestRemoteRefresh();
    assert(reads===1 && !d._remoteRefreshPending,'offline sync disabled local recovery');
});
print('Refresh tests passed: '+passed);
