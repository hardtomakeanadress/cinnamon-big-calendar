/* Recurrence tests for the event reader.
 *
 *   cjs -m tests/recurrence.js
 *
 * A recurring event arrives from evolution-data-server as *one* component
 * carrying its RRULE, not as one component per occurrence. Drawing its DTSTART
 * therefore puts a weekly meeting on the day the series began and never again,
 * and hides a yearly event entirely -- its only date is in the past, off
 * screen. These tests expand hand-written components through the desklet's own
 * code and check the occurrences that come out.
 *
 * Neat sibling of timezone.js, and separate from run-tests.js for the same
 * reason: it needs libecal, which run-tests.js deliberately avoids so it runs
 * anywhere. It skips cleanly when the calendar libraries are absent.
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
    print("  Big Calendar desklet -- recurrence tests");
    print("  " + "=".repeat(46));
    print("");
    print("  SKIPPED: the calendar libraries are not installed here.");
    print("  (" + e.message + ")");
    print("");
    throw new Error("");
}

const feed = new CalendarFeed();
const ENTRY = { uid: "cal-1", name: "Test", color: "#9a9cff" };

function component(...lines) {
    return ECal.Component.new_from_string(
        ["BEGIN:VEVENT", "UID:series@example.com", "SUMMARY:Series"]
            .concat(lines, ["END:VEVENT"]).join("\r\n"));
}

/** The events one component contributes, as "YYYY-MM-DD" strings. */
function daysOf(lines, startMs, endMs) {
    return feed._toEvents(component(...lines), ENTRY, startMs, endMs, new Map())
        .map(e => new Date(e.start).toISOString().slice(0, 10))
        .sort();
}

const SEPTEMBER = [Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)];
const days = (lines) => daysOf(lines, ...SEPTEMBER);

/* ---------------------------------------------------------------- *
 * The bug this file exists for
 * ---------------------------------------------------------------- */

test("a weekly series appears every week, not once", () => {
    assertEqual(days(["DTSTART:20260901T090000Z", "DTEND:20260901T100000Z",
        "RRULE:FREQ=WEEKLY;COUNT=4"]),
    ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"], "four Tuesdays");
});

test("a yearly series appears in the window even though it began years ago", () => {
    // The case that hid: a birthday first entered in 2024, viewed in 2026. Only
    // its RRULE and its original date are stored, and that date is never on
    // screen, so before expansion it was invisible on every day of every month.
    assertEqual(daysOf(["DTSTART:20241015T000000Z", "DTEND:20241016T000000Z",
        "RRULE:FREQ=YEARLY"], Date.UTC(2026, 8, 1), Date.UTC(2026, 11, 1)),
    ["2026-10-15"], "the 2026 occurrence");
});

test("a weekly series is expanded across a month boundary", () => {
    assertEqual(daysOf(["DTSTART:20260825T090000Z", "DTEND:20260825T100000Z",
        "RRULE:FREQ=WEEKLY;COUNT=6"], Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1)),
    ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22", "2026-09-29"], "in September only");
});

/* ---------------------------------------------------------------- *
 * Bounds
 * ---------------------------------------------------------------- */

test("UNTIL is honoured", () => {
    assertEqual(days(["DTSTART:20260901T090000Z", "DTEND:20260901T100000Z",
        "RRULE:FREQ=DAILY;UNTIL=20260905T090000Z"]),
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"], "five days");
});

test("an occurrence outside the window is not returned", () => {
    // 30 September 23:00Z ends at 00:00 on 1 October, which is past the month's
    // end, but its start is inside -- so it belongs to September and only once.
    const late = daysOf(["DTSTART:20260930T230000Z", "DTEND:20261001T000000Z",
        "RRULE:FREQ=DAILY;COUNT=3"], Date.UTC(2026, 8, 1), Date.UTC(2026, 9, 1));
    assertEqual(late, ["2026-09-30"], "clipped to the window");
});

test("a series with no end does not run away", () => {
    // FREQ=DAILY with no COUNT or UNTIL generates forever. The window has to
    // stop it; the backstop cap only matters if the window never does.
    const all = days(["DTSTART:20260901T090000Z", "DTEND:20260901T100000Z", "RRULE:FREQ=DAILY"]);
    assertEqual(all.length, 30, "every day of September");
});

/* ---------------------------------------------------------------- *
 * Exceptions and overrides
 * ---------------------------------------------------------------- */

test("EXDATE removes the occurrence it names", () => {
    assertEqual(days(["DTSTART:20260901T090000Z", "DTEND:20260901T100000Z",
        "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE:20260915T090000Z"]),
    ["2026-09-01", "2026-09-08", "2026-09-22"], "the 15th is gone");
});

test("EXDATE naming several dates removes all of them", () => {
    assertEqual(days(["DTSTART:20260901T090000Z", "DTEND:20260901T100000Z",
        "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE:20260908T090000Z,20260922T090000Z"]),
    ["2026-09-01", "2026-09-15"], "the 8th and 22nd are gone");
});

test("a detached occurrence is drawn once, at its own time", () => {
    // What Google sends when one occurrence of a series is moved: its own
    // component, with RECURRENCE-ID naming where it used to be.
    assertEqual(days(["DTSTART:20260903T140000Z", "DTEND:20260903T150000Z",
        "RECURRENCE-ID:20260903T090000Z"]),
    ["2026-09-03"], "one event, not an expansion");
});

test("a moved occurrence is not also drawn at its old time", () => {
    // The master would otherwise generate the 3rd at 09:00 as well, and the
    // day would show the same meeting twice.
    const master = component("DTSTART:20260901T090000Z", "DTEND:20260901T100000Z",
        "RRULE:FREQ=WEEKLY;COUNT=4");
    const moved = ECal.Component.new_from_string([
        "BEGIN:VEVENT", "UID:series@example.com", "SUMMARY:Series",
        "DTSTART:20260903T140000Z", "DTEND:20260903T150000Z",
        "RECURRENCE-ID:20260901T090000Z", "END:VEVENT"].join("\r\n"));

    const events = feed._collect([master, moved], ENTRY, ...SEPTEMBER);
    const onTheThird = events.filter(e => new Date(e.start).toISOString().slice(0, 10) === "2026-09-03");
    assertEqual(onTheThird.length, 1, "one event on the 3rd");
    assertEqual(new Date(onTheThird[0].start).toISOString(), "2026-09-03T14:00:00.000Z", "at the new time");
});

/* ---------------------------------------------------------------- *
 * Shapes the expansion has to preserve
 * ---------------------------------------------------------------- */

test("every occurrence keeps the master's duration", () => {
    const events = feed._toEvents(
        component("DTSTART:20260901T090000Z", "DTEND:20260901T103000Z", "RRULE:FREQ=WEEKLY;COUNT=3"),
        ENTRY, ...SEPTEMBER, new Map());
    assertEqual(events.map(e => (e.end - e.start) / 60000), [90, 90, 90], "90 minutes each");
});

test("an all-day series stays all-day on every occurrence", () => {
    const events = feed._toEvents(
        component("DTSTART;VALUE=DATE:20260901", "DTEND;VALUE=DATE:20260902", "RRULE:FREQ=WEEKLY;COUNT=3"),
        ENTRY, ...SEPTEMBER, new Map());
    assertEqual(events.map(e => e.allDay), [true, true, true], "all day");
    assertEqual(events.map(e => new Date(e.start).toISOString().slice(0, 10)),
        ["2026-09-01", "2026-09-08", "2026-09-15"], "civil dates, unshifted");
});

test("a zoned series keeps its wall-clock time across a DST change", () => {
    // 09:00 Bucharest on the five Mondays of March 2026. The clocks go forward
    // on Sunday the 29th, so the last one is an hour earlier in UTC than the
    // four before it. Expanding with a fixed offset from the master's start --
    // which is what adding a duration each week amounts to -- would shift
    // either the four before or the one after.
    //
    // Asserted as instants rather than converted back to wall clock, so the
    // test does not re-derive the offset it is checking: 09:00 EET (UTC+2)
    // through the 23rd, 09:00 EEST (UTC+3) on the 30th.
    const events = feed._toEvents(
        component("DTSTART;TZID=Europe/Bucharest:20260302T090000",
            "DTEND;TZID=Europe/Bucharest:20260302T100000", "RRULE:FREQ=WEEKLY;COUNT=5"),
        ENTRY, Date.UTC(2026, 2, 1), Date.UTC(2026, 3, 1), new Map());

    assertEqual(events.map(e => new Date(e.start).toISOString()), [
        "2026-03-02T07:00:00.000Z",
        "2026-03-09T07:00:00.000Z",
        "2026-03-16T07:00:00.000Z",
        "2026-03-23T07:00:00.000Z",
        "2026-03-30T06:00:00.000Z"
    ], "09:00 local every week");
});

/* ---------------------------------------------------------------- *
 * What must not change
 * ---------------------------------------------------------------- */

test("a component with no rule is still one event", () => {
    assertEqual(days(["DTSTART:20260915T090000Z", "DTEND:20260915T100000Z"]),
        ["2026-09-15"], "single");
});

test("a cancelled series contributes nothing", () => {
    assertEqual(days(["DTSTART:20260901T090000Z", "DTEND:20260901T100000Z",
        "RRULE:FREQ=WEEKLY;COUNT=4", "STATUS:CANCELLED"]), [], "cancelled");
});

test("an unreadable rule falls back to the single stored date", () => {
    // Better to draw the series once, where it used to be, than to lose it.
    assertEqual(days(["DTSTART:20260901T090000Z", "DTEND:20260901T100000Z",
        "RRULE:FREQ=NOTAREALFREQUENCY"]), ["2026-09-01"], "drawn at its start");
});

/* ---------------------------------------------------------------- */

print("");
print("  Big Calendar desklet -- recurrence tests");
print("  " + "=".repeat(46));
if (failures.length) {
    print("");
    for (const f of failures) print("  FAIL  " + f);
}
print("");
print("  passed: " + passed + "   failed: " + failed);
print("");

if (failed > 0) throw new Error(failed + " test(s) failed");
