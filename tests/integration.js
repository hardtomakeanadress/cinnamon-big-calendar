/* Live integration test: reads the real evolution-data-server on this
 * machine. Run with:  cjs -m tests/integration.js
 *
 * Skips cleanly (rather than failing) when EDS has no calendars configured,
 * so it is safe in CI.
 */
import GLib from 'gi://GLib';
import { listCalendars, CalendarFeed } from '../lib/calendarSource.js';
import { buildEventIndex, eventsOnDay, describeEvent } from '../lib/eventIndex.js';

const loop = new GLib.MainLoop(null, false);
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => { print("TIMEOUT"); loop.quit(); return GLib.SOURCE_REMOVE; });

try {
    const calendars = await listCalendars();
    print("calendars found: " + calendars.length);
    for (const c of calendars) print("   " + c.name.padEnd(30) + " " + c.color);

    const feed = new CalendarFeed();
    await feed.open();
    print("\nconnected: " + feed.calendars.length + " / " + calendars.length);

    // Whole of 2026, wide enough to include the holiday calendar.
    const events = await feed.query(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1));
    print("events in 2026: " + events.length);

    const allDay = events.filter(e => e.allDay).length;
    print("   all-day: " + allDay + "   timed: " + (events.length - allDay));

    const index = buildEventIndex(events);
    print("   days with events: " + Object.keys(index).length);

    // Orthodox Easter 2026 is 12 April; verify it lands on the right day and
    // that an all-day event did not drift a day in either direction.
    const easter = events.find(e => /Orthodox Easter$/i.test(e.summary));
    if (easter) {
        const d = new Date(easter.start);
        const civil = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
        print("   Orthodox Easter: " + civil + "  (expected 2026-04-12)  " +
              (civil === "2026-04-12" ? "OK" : "MISMATCH"));
        print("   indexed under   : " + Object.keys(index).filter(k => index[k].some(x => x.event === easter)).join(", "));
    } else {
        print("   (no Orthodox Easter in feed; holiday calendar not subscribed)");
    }

    print("\nsample day 2026-09-21:");
    for (const entry of eventsOnDay(index, 2026, 8, 21)) {
        print("   " + describeEvent(entry.event, true) + "   [" + entry.event.calendar + "]");
    }

    feed.destroy();
    print("\ndestroy() ok, isOpen=" + feed.isOpen);
} catch (e) {
    print("FAILED: " + e.message + "\n" + (e.stack || ""));
}
loop.run();
