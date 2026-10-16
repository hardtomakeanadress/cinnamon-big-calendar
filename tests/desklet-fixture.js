// Synthetic St actors; native GLib sources. No running desktop is modified.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as utils from '../lib/calendarUtils.js';
import * as index from '../lib/eventIndex.js';
export {GLib, utils, index};
export const root = Gio.File.new_for_uri(import.meta.url).get_parent().get_parent();
export const read = file => new TextDecoder().decode(file.load_contents(null)[1]);
export function assert(value, message = 'assertion failed') {if (!value) throw new Error(message);}
export function equal(a, b, message = 'values differ') {assert(JSON.stringify(a) === JSON.stringify(b), message + ': ' + JSON.stringify(a));}
export class Actor {
    constructor(props = {}) {Object.assign(this, props);this.children=[];this.classes=new Set();this.clutter_text={};}
    add(a, layout) {this.children.push(a);a.parent=this;a.layout=layout;}
    add_child(a) {this.add(a);}
    set_child(a) {this.add(a);}
    get_children() {return this.children.slice();}
    remove_actor(a) {this.remove_child(a);}
    remove_child(a) {this.children=this.children.filter(c=>c!==a);a.parent=null;}
    destroy() {this.destroyed=true;for (const c of this.children)c.destroy();}
    set_style(s) {this.style=s;}
    set_text(s) {this.text=s;}
    set_width(w) {this.width=w;}
    set_height(h) {this.height=h;}
    set_size(w,h) {this.width=w;this.height=h;}
    has_style_class_name(s) {return this.classes.has(s);}
    add_style_class_name(s) {this.classes.add(s);}
    remove_style_class_name(s) {this.classes.delete(s);}
    get_preferred_width() {return [0, this.parent ? String(this.text||'').length*8 : 500];}
}
export function fixture({fastTimers=false}={}) {
    const ids=new Set(), tracked=new Set(), logs=[], removed=[];
    const main={settingsManager:{uuids:{},unregister:(u,i)=>removed.push([u,i])},
        layoutManager:{isTrackingChrome:a=>tracked.has(a),addChrome:a=>tracked.add(a),untrackChrome:a=>tracked.delete(a)}};
    const add=(ms,cb)=>{const id=GLib.timeout_add(GLib.PRIORITY_DEFAULT,fastTimers?5:ms,cb);ids.add(id);return id;};
    const stub={gi:{Gio,GLib,St:{Label:Actor,Bin:Actor,BoxLayout:Actor,Align:{MIDDLE:1}},
        Clutter:{Settings:{get_default:()=>({font_dpi:96*1024})}},Pango:{EllipsizeMode:{END:1}},Cinnamon:{util_get_week_start:()=>1}},
        mainloop:{timeout_add:add,timeout_add_seconds:(s,cb)=>add(s*1000,cb),source_remove:id=>GLib.source_remove(id)},
        gettext:{bindtextdomain(){},dgettext:(_,s)=>s},ui:{tooltips:{},settings:{},main,desklet:{Desklet:class{_untrackMouse(){tracked.delete(this.actor);}}}}};
    const Klass=new Function('imports','global','logError',read(root.get_child('desklet.js'))+'\nreturn BigCalendarDesklet;')(stub,{},e=>logs.push(e));
    const d=Object.create(Klass.prototype);
    const schema=JSON.parse(read(root.get_child('settings-schema.json')));
    for (const [,key,prop] of read(root.get_child('desklet.js')).matchAll(/s.bind\("([^"]+)", "([^"]+)"/g))d[prop]=schema[key].default;
    Object.assign(d,{metadata:{path:root.get_path(),uuid:'bigCalendar@adis'},instance_id:1,
        _utils:utils,_index:index,_source:null,_view:{year:2026,month:9},_today:new Date(2026,9,16),
        _ready:true,_destroyed:false,_moreWidths:new Map(),_eventIndex:{},_fetchToken:0,
        _dayTimer:0,_eventTimer:0,_eventChangeTimer:0,_inputTimer:0,_inputWatchdog:0,
        _root:new Actor(),_table:new Actor(),actor:new Actor(),_titleLabel:new Actor(),
        _titleButton:new Actor(),_todayButton:new Actor(),_prevButton:new Actor(),_nextButton:new Actor(),
        _titleTip:{set_text(t){this.text=t;},destroy(){this.destroyed=true;}},
        _dayTip:{hide(){},setSurface(){},watch(){},destroy(){this.destroyed=true;}},
        setContent(a){this.content=a;},setHeader(){}});
    return {d,stub,ids,tracked,logs,main,removed,cleanup(){for(const id of ids)if(GLib.MainContext.default().find_source_by_id(id))GLib.source_remove(id);}};
}
export const delay = ms => new Promise(resolve=>GLib.timeout_add(GLib.PRIORITY_DEFAULT,ms,()=>{resolve();return GLib.SOURCE_REMOVE;}));
