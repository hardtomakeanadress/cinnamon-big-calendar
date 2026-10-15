/* Actual desklet input/tooltip methods with synthetic actors and windows.
 * No live desktop is modified. Run cjs -m tests/ui.js. */
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
const [,bytes]=Gio.File.new_for_uri(import.meta.url).get_parent().get_parent().get_child('desklet.js').load_contents(null);
const source=new TextDecoder().decode(bytes);
const tracked=new Set(), children=[], workspace={};
let windows=[], logs=0, passed=0;
const main={uiGroup:{get_children:()=>children},layoutManager:{
    isTrackingChrome:a=>tracked.has(a),addChrome:a=>tracked.add(a),untrackChrome:a=>tracked.delete(a),
    monitors:[{x:0,y:0,width:1920,height:1080},{x:1920,y:0,width:1920,height:1080}],
    primaryMonitor:{x:0,y:0,width:1920,height:1080}
}};
const nativeGlobal={workspace_manager:{get_active_workspace:()=>workspace},get_window_actors:()=>windows,log:()=>logs++};
const stub={gi:{GLib,Meta:{WindowType:{DESKTOP:1,DOCK:2}}},mainloop:{},
    gettext:{bindtextdomain(){},dgettext:(_,s)=>s},ui:{tooltips:{},settings:{},main,
    desklet:{Desklet:class{_untrackMouse(){tracked.delete(this.actor);}}}}};
const [DeskletClass,Tip]=new Function('imports','global','logError',source+'\nreturn [BigCalendarDesklet,DayTooltip];')(stub,nativeGlobal,()=>{});
function actor(x=100,y=100,w=500,h=400){return {get_transformed_position:()=>[x,y],get_transformed_size:()=>[w,h]};}
function windowAt(x,y,w,h,options={}){return {meta_window:{minimized:!!options.minimized,get_window_type:()=>options.type||0,
    is_on_all_workspaces:()=>!!options.sticky,get_workspace:()=>options.workspace||workspace,get_frame_rect:()=>({x,y,width:w,height:h})}};}
function desklet(){const d=Object.create(DeskletClass.prototype);d.actor=actor();return d;}
function assert(v,m){if(!v)throw new Error(m);}
function test(name,fn){tracked.clear();windows=[];children.length=0;fn();passed++;print('PASS '+name);}
test('cover/uncover releases and restores input without duplicate tracking',()=>{
    const d=desklet();d._syncInputRegion();assert(tracked.size===1,'not tracked');
    windows=[windowAt(590,100,200,100)];d._syncInputRegion();assert(tracked.size===0,'partial overlap stole window input');
    windows=[];d._syncInputRegion();d._syncInputRegion();assert(tracked.size===1,'input not restored or duplicated');
});
test('minimized and other-workspace windows do not disable the desklet',()=>{
    const d=desklet();windows=[windowAt(100,100,500,400,{minimized:true}),windowAt(100,100,500,400,{workspace:{}})];
    assert(!d._windowOverlaps(),'invisible window interfered');
    windows.push(windowAt(100,100,500,400,{workspace:{},sticky:true}));assert(d._windowOverlaps(),'sticky window not protected');
});
test('desktop and dock layers do not disable the desklet',()=>{
    const d=desklet();windows=[windowAt(0,0,1920,1080,{type:1}),windowAt(100,100,500,400,{type:2})];
    assert(!d._windowOverlaps(),'desktop layer blocked input');
});
test('removed desklet never reacquires chrome',()=>{
    const d=desklet();d._trackMouse();d._destroyed=true;d._syncInputRegion();d._trackMouse();assert(tracked.size===0,'removed actor re-tracked');
});
test('only invisible overlapping flashspots are hidden',()=>{
    const d=desklet();function flash(x,opacity,cls='flashspot'){
        const a={...actor(x,100,100,100),opacity,visible:true,get_style_class_name:()=>cls,hide(){this.visible=false;}};children.push(a);return a;
    }
    const stuck=flash(100,0),running=flash(100,128),other=flash(100,0,'other'),distant=flash(1000,0);
    d._clearStuckFlashspot();assert(!stuck.visible,'stuck input actor remained');
    assert(running.visible&&other.visible&&distant.visible,'unrelated actor changed');assert(logs===1,'recovery not logged');
});
test('tooltip placement follows pointer monitor, not its previous position',()=>{
    const t=Object.create(Tip.prototype);t._pointer=[2100,200];let pos;
    t._actor={get_preferred_width:()=>[200,200],get_preferred_height:()=>[100,100],set_position:(...p)=>pos=p};
    t._place();assert(pos[0]>=1920&&pos[0]+200<=3840,'wrong monitor');
    t._pointer=[3835,1075];t._place();assert(pos[0]+200<=3840&&pos[1]+100<=1080,'tooltip overflow');
});
test('editing highlight does not put a colored fill behind transparent content', () => {
    const d=Object.create(DeskletClass.prototype);
    let contentHighlight=true;
    d.content={change_style_pseudo_class(name,value){assert(name==='highlight');contentHighlight=value;}};
    d.highlight(true);assert(!contentHighlight,'red container highlight retained');
    d.highlight(false);assert(!contentHighlight,'red container highlight remained');
    d._root=null;d.highlight(true);assert(!contentHighlight,'early highlight tinted loading content');
});
test('configurable outline is independent of fill opacity and can be hidden', () => {
    const d=Object.create(DeskletClass.prototype);let css;
    Object.assign(d,{bgColor:'#241f31',bgOpacity:50,cornerRadius:14,outerPadding:16,borderWidth:2,borderColor:'rgba(255,255,255,0.55)'});
    d._basePoints=()=>12;d._root={set_style(value){css=value;}};
    d._applyRootStyle();
    assert(css.includes('rgba(36, 31, 49, 0.50)') && css.includes('box-shadow: 0 0 0 2px rgba(255,255,255,0.55)'), 'fill or outline wrong');
    d.borderWidth=4;d.borderColor='#0088ff';d._applyRootStyle();
    assert(css.includes('box-shadow: 0 0 0 4px #0088ff'), 'outline controls ignored');
    d.borderWidth=0;d._applyRootStyle();assert(!css.includes('box-shadow') && !css.includes(' border:'), 'outline could not be hidden');
});
print('UI tests passed: '+passed);
