/* Timezone regression tests for the event reader.
 *
 *   cjs -m tests/timezone.js
 *
 * These live apart from run-tests.js because they need libecal, and
 * run-tests.js is deliberately free of everything that is not pure logic so it
 * runs anywhere. This file builds real ECal components from iCalendar text --
 * no server, no account, no desktop -- so it runs on any machine with the
 * calendar libraries installed, and skips cleanly if they are missing.
 *
 * What it guards. A time written as
 *
 *     DTSTART;TZID=Europe/Bucharest:20260214T080000
 *
 * arrives from evolution-data-server as a *floating* time with the zone on the
 * wrapper, not on the value. Reading such a value with as_timet() treats its
 * civil fields as UTC, so 08:00 Bucharest was read as 08:00Z -- two hours late,
 * three in summer, and on the wrong day whenever the offset carries it past
 * midnight. It was found by querying the real server: the events in a local
 * calendar came back in exactly this shape while Google's came back already
 * normalised to UTC, which is why it survived every earlier test.
 */

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        failures.push(name + "\n      " + (e && e.message ? e.message : e));
    }
}

function assertEqual(actual, expected, label) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        throw new Error((label || "assertEqual") + "\n      expected: " + b + "\n      actual:   " + a);
    }
}

let ECal, CalendarFeed;
try {
    ECal = (await import("gi://ECal?version=2.0")).default;
    ({ CalendarFeed } = await import("../lib/calendarSource.js"));
} catch (e) {
    print("");
    print("  Big Calendar desklet -- timezone tests");
    print("  " + "=".repeat(46));
    print("");
    print("  SKIPPED: the calendar libraries are not installed here.");
    print("  (" + e.message + ")");
    print("");
    throw new Error("");   // no libecal, no test
}

const feed = new CalendarFeed();
const ENTRY = { uid: "cal-1", name: "Test", color: "#9a9cff" };

/** Every event one VEVENT contributes over a wide window, via the desklet. */
function eventsOf(...lines) {
    const component = ECal.Component.new_from_string(
        ["BEGIN:VEVENT", "UID:tz-test@example.com", "SUMMARY:Test"]
            .concat(lines, ["END:VEVENT"]).join("\r\n"));
    return feed._toEvents(component, ENTRY,
        Date.UTC(2000, 0, 1), Date.UTC(2040, 0, 1), new Map());
}

/** One VEVENT's start instant, as ISO, read through the desklet's own code. */
function startOf(...lines) {
    const events = eventsOf(...lines);
    if (!events.length) throw new Error("no event for: " + lines.join(" "));
    return new Date(events[0].start).toISOString();
}

/* ---------------------------------------------------------------- *
 * The bug this file exists for
 * ---------------------------------------------------------------- */

test("a TZID event is read at its real instant, not as UTC", () => {
    // 08:00 in Bucharest in February is UTC+2, so 06:00Z.
    assertEqual(startOf("DTSTART;TZID=Europe/Bucharest:20260214T080000"),
        "2026-02-14T06:00:00.000Z", "winter, UTC+2");
});

test("a TZID event honours summer time", () => {
    // The same wall clock in July is UTC+3, so 05:00Z. A fixed offset would
    // pass the winter case and fail this one.
    assertEqual(startOf("DTSTART;TZID=Europe/Bucharest:20260714T080000"),
        "2026-07-14T05:00:00.000Z", "summer, UTC+3");
});

test("a TZID event west of UTC is not shifted the wrong way", () => {
    // UTC-5 in January, so 08:00 local is 13:00Z.
    assertEqual(startOf("DTSTART;TZID=America/New_York:20260114T080000"),
        "2026-01-14T13:00:00.000Z", "negative offset");
});

/* ---------------------------------------------------------------- *
 * The shapes that already worked, which must keep working
 * ---------------------------------------------------------------- */

test("an event already in UTC is left alone", () => {
    // What Google's backend returns: normalised, with the zone applied.
    assertEqual(startOf("DTSTART:20260428T114000Z"), "2026-04-28T11:40:00.000Z", "UTC literal");
});

test("an all-day event keeps its civil date", () => {
    // All-day events travel as midnight UTC and are read as a civil date, so
    // converting them through a zone would move them a day for half the world.
    assertEqual(startOf("DTSTART;VALUE=DATE:20241015"), "2024-10-15T00:00:00.000Z", "all-day");
});

test("a long Google-style TZID resolves to its zone", () => {
    assertEqual(startOf("DTSTART;TZID=/freeassociation.sourceforge.net/Tzfile/Europe/Bucharest:20260214T080000"),
        "2026-02-14T06:00:00.000Z", "path-style tzid");
});

test("an unknown TZID falls back instead of throwing", () => {
    // Not right, but not worse than before it was handled at all, and the
    // event still appears on the correct day for any offset under 8 hours.
    assertEqual(startOf("DTSTART;TZID=Mars/Olympus_Mons:20260214T080000"),
        "2026-02-14T08:00:00.000Z", "unknown zone falls back to UTC reading");
});

test("DTEND is converted with the same zone as DTSTART", () => {
    const events = eventsOf("DTSTART;TZID=Europe/Bucharest:20260214T080000",
        "DTEND;TZID=Europe/Bucharest:20260214T093000");
    assertEqual(new Date(events[0].end).toISOString(), "2026-02-14T07:30:00.000Z", "dtend");
});

test("an event crossing midnight lands on the day it starts", () => {
    // 00:30 Bucharest on the 15th is 22:30Z on the 14th. Read as UTC it would
    // be 00:30Z on the 15th -- the same civil day here, but a different
    // instant, and in the other direction it moves a day. This is the case
    // that decides whether the fix is right or merely close.
    assertEqual(startOf("DTSTART;TZID=Europe/Bucharest:20260215T003000"),
        "2026-02-14T22:30:00.000Z", "just after midnight");
});

/* ---------------------------------------------------------------- */

print("");
print("  Big Calendar desklet -- timezone tests");
print("  " + "=".repeat(46));
if (failures.length) {
    print("");
    for (const f of failures) print("  FAIL  " + f);
}
print("");
print("  passed: " + passed + "   failed: " + failed);
print("");

if (failed > 0) throw new Error(failed + " test(s) failed");
