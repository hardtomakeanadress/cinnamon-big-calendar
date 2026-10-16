import {fixture, assert, equal, GLib, delay} from './desklet-fixture.js';
let passed=0;
async function test(name,fn){const f=fixture({fastTimers:true});try{await fn(f);passed++;print('PASS '+name);}finally{f.cleanup();}}
await test('detached sources are detected and cancellation clears stale ids',async({d})=>{
    d._startDayTimer();const id=d._dayTimer;assert(d._sourceAlive(id));
    GLib.source_remove(id);assert(!d._timerAlive('_dayTimer'));
    d._startDayTimer();assert(d._dayTimer!==id&&d._timerAlive('_dayTimer'));
    GLib.source_remove(d._dayTimer);d._stopDayTimer();equal(d._dayTimer,0);
});
await test('watchdog restores detached input, day and event sources on the GLib loop',async({d})=>{
    let inputs=0;d._syncInputRegion=()=>inputs++;d._clearStuckFlashspot=()=>{};
    d._feed={};d._requestRemoteRefresh=()=>{};d._startInputTimer();d._startDayTimer();d._startEventTimer();
    const names=['_inputTimer','_dayTimer','_eventTimer'];const old=names.map(k=>d[k]);
    old.forEach(id=>GLib.source_remove(id));
    await delay(30);
    names.forEach((k,i)=>assert(d[k]!==old[i]&&d._timerAlive(k),'watchdog failed: '+k));
    assert(inputs>0,'replacement input source never dispatched');
    const watchdog=d._inputWatchdog;d._startTimerWatchdog();equal(d._inputWatchdog,watchdog,'duplicate watchdog');
    d._stopInputTimer();assert(!d._sourceAlive(watchdog));
});
await test('addition starts input; removal cancels sources and releases owned resources',async({d,tracked,main,removed})=>{
    d.startOnToday=false;d._clearStuckFlashspot=()=>{};d._syncInputRegion=()=>{};
    d.on_desklet_added_to_desktop();d._startDayTimer();
    let closed=0,unbound=[],disconnected=0;d._feed={destroy(){closed++;}};d._startEventTimer();
    d._eventChangeTimer=GLib.timeout_add(GLib.PRIORITY_DEFAULT,1000,()=>GLib.SOURCE_REMOVE);
    const ids=[d._dayTimer,d._eventTimer,d._eventChangeTimer,d._inputTimer,d._inputWatchdog];
    const settings={uuid:'x',instanceId:1,bindings:{a:1,b:2},unbindAll:k=>unbound.push(k),disconnectAll:()=>disconnected++};
    d.settings=settings;main.settingsManager.uuids.x={1:settings};tracked.add(d.actor);
    const day=d._dayTip,title=d._titleTip;d.on_desklet_removed();
    assert(ids.every(id=>!d._sourceAlive(id)),'source leaked');equal(closed,1);equal(unbound,['a','b']);equal(disconnected,1);
    equal(removed,[['x',1]]);assert(day.destroyed&&title.destroyed&&!tracked.size&&!d.actor.reactive&&d._destroyed);
    d._trackMouse();assert(!tracked.size,'late callback reclaimed input');
});
await test('old instance teardown preserves replacement settings registration',async({d,main,removed})=>{
    let disconnected=0;d.settings={uuid:'x',instanceId:1,bindings:{},disconnectAll:()=>disconnected++};
    main.settingsManager.uuids.x={1:{replacement:true}};d.on_desklet_removed();equal(removed,[]);equal(disconnected,1);
});
await test('turning events off cancels queries, timers and cached events',async({d})=>{
    let closed=0;d._feed={destroy(){closed++;}};d._startEventTimer();const id=d._eventTimer;
    d._eventIndex={old:[1]};d.showEvents=false;d._openOrCloseFeed();
    assert(!d._sourceAlive(id));equal(d._eventIndex,{});equal(closed,1);equal(d._feed,null);equal(d._fetchToken,1);
    let opened=0;d._source={};d.showEvents=true;d._openFeed=()=>opened++;d._openOrCloseFeed();equal(opened,1);
});
await test('failed settings initialization shows fallback and starts no timers',async({d,stub,ids,logs})=>{
    stub.ui.settings.DeskletSettings=class{constructor(){this.isReady=false;}bind(){throw new Error('bound unready settings');}};
    d._ready=false;await d._bootstrap();
    equal(d.content.text,'Big Calendar could not start.');assert(!d._ready&&ids.size===0&&logs.length>=1);
    d.startOnToday=false;d._restoreView();d._rememberView(); // Safe after failed initialization.
});
print('Lifecycle tests passed: '+passed);
