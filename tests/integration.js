/* Read-only live EDS smoke check. No event titles, account names or credentials
 * are printed. Synthetic mutation tests belong in isolated-refresh.sh. */
import GLib from 'gi://GLib';
import System from 'system';
import { requireCalendarLibraries } from './require-calendar.js';
await requireCalendarLibraries();
const {listCalendars, CalendarFeed} = await import('../lib/calendarSource.js');
import {buildEventIndex} from '../lib/eventIndex.js';
let errors = 0, skipped = false;
let feed = new CalendarFeed(null, () => errors++);
const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 45, () => {
    printerr('FAIL: live EDS check timed out');
    feed.destroy();
    System.exit(1);
    return GLib.SOURCE_REMOVE;
});
try {
    const calendars = await listCalendars();
    if (!calendars.length) {
        print('SKIP: no calendars configured');
        skipped = true;
    } else {
        await feed.open();
        if (!feed.isOpen) throw new Error('No calendars could be connected');
        const year = new Date().getFullYear();
        const events = await feed.query(Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1));
        if (errors) throw new Error(errors + ' calendars failed to query');
        for (const event of events) {
            if (!Number.isFinite(event.start) || !Number.isFinite(event.end))
                throw new Error('Invalid event timestamp');
        }
        const index = buildEventIndex(events, year + '-01-01', year + '-12-31');
        print(JSON.stringify({calendars: calendars.length, connected: feed.calendars.length,
            year, events: events.length, daysWithEvents: Object.keys(index).length}));
    }
} finally {
    GLib.source_remove(timer);
    feed.destroy();
    feed = null;
    System.gc();
}
// Let native client teardown run before leaving the process. A remaining
// CJS/EDS shutdown crash on this system is documented in audit-report.json;
// do not turn a failing native shutdown into a passing test result.
const loop = new GLib.MainLoop(null, false);
GLib.idle_add(GLib.PRIORITY_DEFAULT, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
loop.run();

if (skipped) System.exit(77);
