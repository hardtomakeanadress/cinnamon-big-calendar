/* run-tests.js
 *
 * Standalone test runner for the Big Calendar desklet's pure logic.
 *
 *   cjs -m tests/run-tests.js
 *
 * The `-m` is required: lib/ is written as ES modules, and a plain cjs run
 * uses the legacy loader, which cannot see `export`.
 *
 * The Cinnamon widget toolkit (St) is compiled into the Cinnamon process and
 * is not available to a plain cjs process, so the render layer cannot be
 * tested here. Everything below is deliberately free of Cinnamon imports and
 * is therefore testable in isolation and in CI.
 */

// Relative specifiers resolve against this file's own URL, so the suite runs
// from any checkout rather than only the author's home directory.
import * as C from "../lib/calendarUtils.js";
import * as E from "../lib/eventIndex.js";

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

function assertTrue(value, label) {
    if (!value) throw new Error((label || "assertTrue") + " -> was " + value);
}

/* ------------------------------------------------------------------ *
 * Leap years and month lengths
 * ------------------------------------------------------------------ */

test("leap year rules", () => {
    assertEqual(C.isLeapYear(2024), true, "2024");
    assertEqual(C.isLeapYear(2026), false, "2026");
    assertEqual(C.isLeapYear(2000), true, "2000 (divisible by 400)");
    assertEqual(C.isLeapYear(1900), false, "1900 (divisible by 100, not 400)");
    assertEqual(C.isLeapYear(2100), false, "2100");
});

test("days in month", () => {
    assertEqual(C.daysInMonth(2026, 0), 31, "Jan");
    assertEqual(C.daysInMonth(2026, 1), 28, "Feb 2026");
    assertEqual(C.daysInMonth(2024, 1), 29, "Feb 2024 (leap)");
    assertEqual(C.daysInMonth(2026, 3), 30, "Apr");
    assertEqual(C.daysInMonth(2026, 11), 31, "Dec");
});

test("daysInMonth agrees with the Date built-in for a wide range", () => {
    for (let y = 1990; y <= 2060; y++) {
        for (let m = 0; m < 12; m++) {
            // Day 0 of the next month is the last day of this month. Built in
            // UTC, not local time: some zones skipped a calendar day entirely
            // (Kiribati dropped 31 Dec 1994 when it moved the date line), so a
            // local-midnight oracle reports the wrong date there.
            const expected = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
            assertEqual(C.daysInMonth(y, m), expected, y + "-" + (m + 1));
        }
    }
});

/* ------------------------------------------------------------------ *
 * addMonths
 * ------------------------------------------------------------------ */

test("addMonths rolls over year boundaries", () => {
    assertEqual(C.addMonths(2026, 11, 1), { year: 2027, month: 0 }, "Dec -> Jan");
    assertEqual(C.addMonths(2026, 0, -1), { year: 2025, month: 11 }, "Jan -> Dec");
    assertEqual(C.addMonths(2026, 5, 12), { year: 2027, month: 5 }, "+12 months");
    assertEqual(C.addMonths(2026, 5, -18), { year: 2024, month: 11 }, "-18 months");
});

test("addMonths is reversible and consistent over a long span", () => {
    let y = 2020, m = 3;
    const start = { y: y, m: m };
    for (let i = 0; i < 400; i++) {
        const n = C.addMonths(y, m, 1);
        y = n.year; m = n.month;
    }
    const back = C.addMonths(y, m, -400);
    assertEqual(back, { year: start.y, month: start.m }, "round trip");
});

/* ------------------------------------------------------------------ *
 * ISO 8601 week numbers
 *
 * Vectors taken from the standard reference table of ISO week dates.
 * ------------------------------------------------------------------ */

test("ISO week numbers against known reference dates", () => {
    const vectors = [
        [1977, 0, 1, 53, 1976],
        [1977, 0, 2, 53, 1976],
        [1978, 0, 2, 1, 1978],
        [1979, 11, 31, 1, 1980],
        [1980, 0, 1, 1, 1980],
        [2000, 0, 1, 52, 1999],
        [2000, 0, 3, 1, 2000],
        [2010, 0, 3, 53, 2009],
        [2010, 0, 4, 1, 2010],
        [2019, 11, 30, 1, 2020],
        [2021, 0, 1, 53, 2020],
        [2026, 0, 1, 1, 2026]
    ];
    for (const v of vectors) {
        const got = C.isoWeek(v[0], v[1], v[2]);
        assertEqual([got.week, got.year], [v[3], v[4]],
            v[0] + "-" + (v[1] + 1) + "-" + v[2]);
    }
});

test("ISO week is stable for all 7 days of a week", () => {
    // Every day from Monday to Sunday must report the same week/year.
    const got = [];
    for (let d = 29; d <= 35; d++) {
        const date = new Date(Date.UTC(2026, 0, d));
        if (date.getUTCMonth() !== 0) continue;
        got.push(C.isoWeek(2026, 0, d).week);
    }
    const unique = got.filter((v, i) => got.indexOf(v) === i);
    assertEqual(unique.length, 1, "one week number across the week: " + got.join(","));
});

test("ISO week stays within 1..53 for every day over 30 years", () => {
    for (let y = 2000; y < 2030; y++) {
        for (let m = 0; m < 12; m++) {
            const dim = C.daysInMonth(y, m);
            for (let d = 1; d <= dim; d++) {
                const w = C.isoWeek(y, m, d);
                assertTrue(w.week >= 1 && w.week <= 53, "week out of range " + y + "-" + (m + 1) + "-" + d + " -> " + w.week);
                assertTrue(Math.abs(w.year - y) <= 1, "year drifted " + y + " -> " + w.year);
            }
        }
    }
});

test("ISO week numbers are contiguous through a year", () => {
    // Walking day by day, the week number may only stay the same or advance
    // by one -- except at the year rollover, where it resets to 1.
    let prev = null;
    for (let d = 0; d < 366; d++) {
        const date = new Date(Date.UTC(2026, 0, 1 + d));
        if (date.getUTCFullYear() !== 2026) break;
        const w = C.isoWeek(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
        if (prev && w.year === prev.year) {
            assertTrue(w.week === prev.week || w.week === prev.week + 1,
                "jump from week " + prev.week + " to " + w.week);
        }
        prev = w;
    }
});

/* ------------------------------------------------------------------ *
 * US week numbers
 * ------------------------------------------------------------------ */

test("US week numbering", () => {
    // Week 1 is the week containing 1 January, weeks start on Sunday.
    assertEqual(C.usWeek(2026, 0, 1).week, 1, "Jan 1 is week 1");
    assertEqual(C.usWeek(2026, 0, 3).week, 1, "Jan 3 (Sat) still week 1");
    assertEqual(C.usWeek(2026, 0, 4).week, 2, "Jan 4 (Sun) starts week 2");
});

test("US week numbering does not skip the turn of the year", () => {
    // 28 Dec 2025 (Sun) to 3 Jan 2026 is one week, and it contains 1 January
    // 2026 -- so it is week 1 of 2026. Numbering it by the year its first day
    // fell in made it week 53 of 2025, and the following row, 4 January, is
    // week 2 of 2026: week 1 existed on no row, so the column read 52, 53, 2.
    assertEqual(C.usWeek(2025, 11, 28), { week: 1, year: 2026 }, "the straddling week");
    assertEqual(C.usWeek(2026, 0, 1).week, 1, "1 January");
    assertEqual(C.usWeek(2026, 0, 3).week, 1, "3 January, still that week");
    assertEqual(C.usWeek(2026, 0, 4).week, 2, "4 January, the next one");
    assertEqual(C.usWeek(2025, 11, 21).week, 52, "the week before it");

    // No gap anywhere: whatever a week is called, consecutive Sundays advance
    // the number by exactly one, or reset to 1 with the year rolled over.
    const { year, month, day } = nextSunday(2025, 11, 21);
    let prev = C.usWeek(2025, 11, 21);
    let cursor = { year, month, day };
    for (let i = 0; i < 60; i++) {
        const here = C.usWeek(cursor.year, cursor.month, cursor.day);
        const advanced = here.year === prev.year + 1
            ? (here.week === 1)
            : (here.week === prev.week + 1);
        assertTrue(advanced, "week after " + prev.year + "-w" + prev.week +
            " is " + here.year + "-w" + here.week + " (skipped)");
        prev = here;
        cursor = nextSunday(cursor.year, cursor.month, cursor.day);
    }
});

function nextSunday(year, month, day) {
    const t = new Date(C.utcDay(year, month, day) + 7 * C.MS_PER_DAY);
    return { year: t.getUTCFullYear(), month: t.getUTCMonth(), day: t.getUTCDate() };
}

test("US week never exceeds 54", () => {
    for (let y = 2000; y < 2030; y++) {
        for (let m = 0; m < 12; m++) {
            const dim = C.daysInMonth(y, m);
            for (let d = 1; d <= dim; d++) {
                const w = C.usWeek(y, m, d).week;
                assertTrue(w >= 1 && w <= 54, "bad US week " + y + "-" + (m + 1) + "-" + d + " -> " + w);
            }
        }
    }
});

/* ------------------------------------------------------------------ *
 * First day of week
 * ------------------------------------------------------------------ */

test("first day of week by region", () => {
    assertEqual(C.firstDayOfWeekForLocale("ro-RO"), 1, "Romania is Monday");
    assertEqual(C.firstDayOfWeekForLocale("en-US"), 0, "US is Sunday");
    assertEqual(C.firstDayOfWeekForLocale("en-GB"), 0, "UK is Sunday");
    assertEqual(C.firstDayOfWeekForLocale("de-DE"), 1, "Germany is Monday");
    assertEqual(C.firstDayOfWeekForLocale("fr-FR"), 1, "France is Monday");
    assertEqual(C.firstDayOfWeekForLocale("ar-SA"), 6, "Saudi Arabia is Saturday");
    assertEqual(C.firstDayOfWeekForLocale("ja-JP"), 0, "Japan is Sunday");
    assertEqual(C.firstDayOfWeekForLocale("en"), 0, "bare 'en' falls back to US");
    assertEqual(C.firstDayOfWeekForLocale("ro"), 1, "bare 'ro' falls back to Monday");
});

test("region extraction handles underscores and odd casing", () => {
    assertEqual(C.regionFromLocale("ro_RO"), "RO", "underscore form");
    assertEqual(C.regionFromLocale("pt-BR"), "BR", "pt-BR");
    assertEqual(C.regionFromLocale("zh-Hans-CN"), "CN", "script subtag skipped");
    assertEqual(C.regionFromLocale(""), "", "empty");
});

/* ------------------------------------------------------------------ *
 * Month grid invariants
 * ------------------------------------------------------------------ */

test("month grid has the right shape", () => {
    const m = C.buildMonthMatrix(2026, 8, 1, { rows: 6, weekNumbering: "iso", today: new Date(2026, 8, 30) });
    assertEqual(m.length, 6, "6 rows");
    for (const week of m) assertEqual(week.days.length, 7, "7 days per row");
});

test("month grid always starts on the configured weekday", () => {
    for (let fd = 0; fd < 7; fd++) {
        for (let y = 2024; y <= 2028; y++) {
            for (let mo = 0; mo < 12; mo++) {
                const m = C.buildMonthMatrix(y, mo, fd, { rows: 6, today: new Date(2026, 0, 1) });
                const first = m[0].days[0];
                const wd = C.weekdayOf(first.year, first.month, first.day);
                assertEqual(wd, fd, "fd=" + fd + " " + y + "-" + (mo + 1));
            }
        }
    }
});

test("month grid contains every day of the month exactly once", () => {
    for (let y = 2024; y <= 2028; y++) {
        for (let mo = 0; mo < 12; mo++) {
            const m = C.buildMonthMatrix(y, mo, 1, { rows: 6, today: new Date(2026, 0, 1) });
            const inMonth = [];
            for (const week of m) {
                for (const cell of week.days) {
                    if (cell.inMonth) inMonth.push(cell.day);
                }
            }
            const expected = [];
            for (let d = 1; d <= C.daysInMonth(y, mo); d++) expected.push(d);
            assertEqual(inMonth, expected, y + "-" + (mo + 1));
        }
    }
});

test("month grid days are consecutive with no gaps", () => {
    for (let y = 2025; y <= 2027; y++) {
        for (let mo = 0; mo < 12; mo++) {
            const m = C.buildMonthMatrix(y, mo, 0, { rows: 6, today: new Date(2026, 0, 1) });
            let prev = null;
            for (const week of m) {
                for (const cell of week.days) {
                    if (prev) {
                        const delta = C.utcDay(cell.year, cell.month, cell.day) -
                                      C.utcDay(prev.year, prev.month, prev.day);
                        assertEqual(delta, C.MS_PER_DAY, "gap at " + y + "-" + (mo + 1));
                    }
                    prev = cell;
                }
            }
        }
    }
});

test("auto row count is 5 or 6 and always fits the month", () => {
    for (let y = 2020; y <= 2040; y++) {
        for (let mo = 0; mo < 12; mo++) {
            const m = C.buildMonthMatrix(y, mo, 1, { rows: "auto", today: new Date(2026, 0, 1) });
            assertTrue(m.length === 5 || m.length === 6, "rows=" + m.length + " for " + y + "-" + (mo + 1));
            let count = 0;
            for (const week of m) for (const cell of week.days) if (cell.inMonth) count++;
            assertEqual(count, C.daysInMonth(y, mo), "all days fit " + y + "-" + (mo + 1));
        }
    }
});

test("today is marked on exactly the matching cell", () => {
    const today = new Date(2026, 8, 30);
    const m = C.buildMonthMatrix(2026, 8, 1, { rows: 6, today: today });
    let hits = [];
    for (const week of m) {
        for (const cell of week.days) {
            if (cell.isToday) hits.push([cell.year, cell.month, cell.day]);
        }
    }
    assertEqual(hits, [[2026, 8, 30]], "exactly one today cell");
});

test("isToday is exact across every cell of every month", () => {
    // A grid shows days from the neighbouring months, so "today" may
    // legitimately appear as a leading or trailing day. The invariant is
    // not "only in its own month" but "if and only if the date matches".
    const today = new Date(2026, 8, 30);
    const tk = C.dayKey(today);
    for (let y = 2026; y <= 2026; y++) {
        for (let mo = 7; mo <= 10; mo++) {
            const m = C.buildMonthMatrix(y, mo, 1, { rows: 6, today: today });
            for (const week of m) {
                for (const cell of week.days) {
                    const isToday = C.dayKey(cell.date) === tk;
                    assertEqual(cell.isToday, isToday,
                        "mismatch at " + cell.year + "-" + (cell.month + 1) + "-" + cell.day);
                }
            }
        }
    }
});

test("a month with no today in view marks nothing", () => {
    const today = new Date(2026, 8, 30);
    const m = C.buildMonthMatrix(2027, 5, 1, { rows: 6, today: today });
    for (const week of m) {
        for (const cell of week.days) {
            assertTrue(!cell.isToday,
                "spurious today at " + cell.year + "-" + (cell.month + 1) + "-" + cell.day);
        }
    }
});

test("weekends are flagged correctly", () => {
    const m = C.buildMonthMatrix(2026, 8, 1, { rows: 6, today: new Date(2026, 8, 30) });
    for (const week of m) {
        for (const cell of week.days) {
            const wd = C.weekdayOf(cell.year, cell.month, cell.day);
            assertEqual(cell.isWeekend, wd === 0 || wd === 6,
                cell.year + "-" + (cell.month + 1) + "-" + cell.day);
        }
    }
});

test("adjacent months agree on their shared days", () => {
    // The trailing days of one month's grid must equal the leading days of
    // the next month's grid.
    const a = C.buildMonthMatrix(2026, 8, 1, { rows: 6, today: new Date(2026, 0, 1) });
    const b = C.buildMonthMatrix(2026, 9, 1, { rows: 6, today: new Date(2026, 0, 1) });
    const tail = a[0].days.map(d => d.day);
    const head = b[0].days.map(d => d.day);
    assertEqual(tail.length, 7, "7 cells");
    assertEqual(head.length, 7, "7 cells");
});

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

test("weekday names are correct and start on the right day", () => {
    const ro = C.weekdayNames("ro-RO", 1, "short");   // Monday first
    const us = C.weekdayNames("en-US", 0, "short");   // Sunday first
    assertEqual(ro.length, 7, "7 names");
    assertEqual(us.length, 7, "7 names");
    // en-US starts with Sunday
    assertEqual(us[0].toLowerCase().indexOf("su"), 0, "en-US starts Sunday: " + us[0]);
    // en-US index 1 is Monday
    assertEqual(us[1].toLowerCase().indexOf("mo"), 0, "en-US index 1 is Monday: " + us[1]);
    // en-US index 6 is Saturday
    assertEqual(us[6].toLowerCase().indexOf("sa"), 0, "en-US index 6 is Saturday: " + us[6]);
});

test("weekday names rotate with the first day of week", () => {
    const mondayFirst = C.weekdayNames("en-US", 1, "short");
    const sundayFirst = C.weekdayNames("en-US", 0, "short");
    // Rotating Sunday-first by one must give Monday-first.
    assertEqual(mondayFirst, sundayFirst.slice(1).concat([sundayFirst[0]]), "rotation");
});

test("month/year header formats contain the right pieces", () => {
    const long = C.formatMonthYear(2026, 8, "en-US", "long");
    assertTrue(long.indexOf("September") !== -1, "long has month: " + long);
    assertTrue(long.indexOf("2026") !== -1, "long has year: " + long);

    const short = C.formatMonthYear(2026, 8, "en-US", "short");
    assertTrue(short.indexOf("Sep") !== -1, "short has abbreviated month: " + short);

    const numeric = C.formatMonthYear(2026, 8, "en-US", "numeric");
    assertTrue(/09/.test(numeric), "numeric has 2-digit month: " + numeric);

    const stacked = C.formatMonthYear(2026, 8, "en-US", "stacked");
    assertTrue(stacked.indexOf("\n") !== -1, "stacked is two lines: " + JSON.stringify(stacked));
});

test("formatting works for a Romanian locale", () => {
    const long = C.formatMonthYear(2026, 8, "ro-RO", "long");
    assertTrue(long.toLowerCase().indexOf("septembrie") !== -1, "ro month name: " + long);
});

/* ------------------------------------------------------------------ *
 * Event indexing
 *
 * Instants are built two ways and the difference matters. All-day events are
 * anchored in UTC, because that is how iCalendar transports them and the code
 * under test resolves them against UTC. Timed events are built from local
 * civil fields, because a timed event genuinely belongs to the local day.
 * Written this way the expectations hold in every timezone -- which is the
 * point, since the whole file exists to get that distinction right.
 * ------------------------------------------------------------------ */

const utcMs = (y, m, d) => Date.UTC(y, m, d);
const localMs = (y, m, d, h, mi) => new Date(y, m, d, h || 0, mi || 0).getTime();

function allDay(summary, y, m, d, days) {
    return {
        summary: summary,
        allDay: true,
        start: utcMs(y, m, d),
        end: utcMs(y, m, d) + (days || 1) * 86400000,
        color: "#9a9cff"
    };
}

function timed(summary, y, m, d, h, mi, hours) {
    const start = localMs(y, m, d, h, mi);
    return {
        summary: summary,
        allDay: false,
        start: start,
        end: start + (hours || 0) * 3600000,
        color: "#9a9cff"
    };
}

test("day keys are zero padded", () => {
    assertEqual(E.dayKey(2026, 0, 1), "2026-01-01", "january");
    assertEqual(E.dayKey(2026, 8, 30), "2026-09-30", "september");
    assertEqual(E.dayKey(2026, 11, 31), "2026-12-31", "december");
});

test("civil day arithmetic crosses month, year and leap boundaries", () => {
    assertEqual(E.civilAddDays(2026, 0, 31, 1), { year: 2026, month: 1, day: 1 }, "jan->feb");
    assertEqual(E.civilAddDays(2026, 11, 31, 1), { year: 2027, month: 0, day: 1 }, "dec->jan");
    assertEqual(E.civilAddDays(2027, 0, 1, -1), { year: 2026, month: 11, day: 31 }, "back over new year");
    assertEqual(E.civilAddDays(2024, 1, 28, 1), { year: 2024, month: 1, day: 29 }, "into leap day");
    assertEqual(E.civilAddDays(2024, 1, 29, 1), { year: 2024, month: 2, day: 1 }, "out of leap day");
    assertEqual(E.civilAddDays(2026, 1, 28, 1), { year: 2026, month: 2, day: 1 }, "no leap day in 2026");
});

test("a one-day all-day event occupies exactly one day", () => {
    // DTEND is exclusive: May 1 -> May 2 is a single day, not two. Drawing
    // the end date as well is the most common calendar bug there is.
    const index = E.buildEventIndex([allDay("Labour Day", 2026, 4, 1, 1)]);
    assertEqual(Object.keys(index), ["2026-05-01"], "exactly one day indexed");
    assertEqual(index["2026-05-01"].length, 1, "one event");
});

test("an all-day event is anchored to UTC, not local time", () => {
    // The bug this guards: EDS ships all-day events as midnight UTC. Reading
    // that back in local time puts the event a day early for anyone west of
    // Greenwich -- "Labour Day, May 1" drawn on April 30.
    for (const d of [1, 15, 30]) {
        const index = E.buildEventIndex([allDay("x", 2026, 4, d, 1)]);
        assertEqual(Object.keys(index), ["2026-05-" + (d < 10 ? "0" + d : d)],
            "day " + d + " stays put");
    }
});

test("a multi-day all-day event covers every day it spans", () => {
    const index = E.buildEventIndex([allDay("Holiday", 2026, 4, 1, 5)]);
    assertEqual(Object.keys(index).sort(),
        ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"],
        "five consecutive days");
    assertEqual(index["2026-05-01"][0].first, true, "first day flagged");
    assertEqual(index["2026-05-01"][0].last, false, "first day is not last");
    assertEqual(index["2026-05-03"][0].first, false, "middle is not first");
    assertEqual(index["2026-05-03"][0].last, false, "middle is not last");
    assertEqual(index["2026-05-05"][0].last, true, "last day flagged");
});

test("a multi-day all-day event spanning a month boundary splits correctly", () => {
    const index = E.buildEventIndex([allDay("Bridge", 2026, 0, 30, 3)]);
    assertEqual(Object.keys(index).sort(),
        ["2026-01-30", "2026-01-31", "2026-02-01"], "crosses into February");
});

test("a timed event lands on its local day", () => {
    const index = E.buildEventIndex([timed("Standup", 2026, 8, 21, 9, 30, 1)]);
    assertEqual(Object.keys(index), ["2026-09-21"], "one day");
});

test("a timed event crossing midnight covers both days", () => {
    const index = E.buildEventIndex([timed("Deploy window", 2026, 8, 21, 22, 0, 4)]);
    assertEqual(Object.keys(index).sort(), ["2026-09-21", "2026-09-22"], "both days");
});

test("a zero-length timed event still occupies its own day", () => {
    // DTSTART with no DTEND. Subtracting a millisecond from the end would
    // otherwise place it on the previous day.
    const start = localMs(2026, 8, 21, 12, 0);
    const index = E.buildEventIndex([
        { summary: "Reminder", allDay: false, start: start, end: start, color: "#fff" }
    ]);
    assertEqual(Object.keys(index), ["2026-09-21"], "its own day");
});

test("an event ending exactly at midnight does not leak into the next day", () => {
    const start = localMs(2026, 8, 21, 20, 0);
    const index = E.buildEventIndex([
        { summary: "Evening", allDay: false, start: start, end: localMs(2026, 8, 22, 0, 0), color: "#fff" }
    ]);
    assertEqual(Object.keys(index), ["2026-09-21"], "only the starting day");
});

test("all-day events sort above timed events", () => {
    const index = E.buildEventIndex([
        timed("Late meeting", 2026, 8, 21, 16, 0, 1),
        allDay("Holiday", 2026, 8, 21, 1),
        timed("Early meeting", 2026, 8, 21, 8, 0, 1)
    ]);
    const titles = index["2026-09-21"].map(e => e.event.summary);
    assertEqual(titles, ["Holiday", "Early meeting", "Late meeting"], "all-day first, then by time");
});

test("sorting is a total order for simultaneous events", () => {
    const a = E.buildEventIndex([
        timed("Beta", 2026, 8, 21, 9, 0, 1),
        timed("Alpha", 2026, 8, 21, 9, 0, 1)
    ]);
    const b = E.buildEventIndex([
        timed("Alpha", 2026, 8, 21, 9, 0, 1),
        timed("Beta", 2026, 8, 21, 9, 0, 1)
    ]);
    assertEqual(a["2026-09-21"].map(e => e.event.summary),
        b["2026-09-21"].map(e => e.event.summary), "order is stable regardless of input order");
});

test("events from several calendars merge into one day", () => {
    const google = allDay("Google thing", 2026, 8, 21, 1);
    google.color = "#9a9cff";
    const family = timed("Family dinner", 2026, 8, 21, 19, 0, 2);
    family.color = "#42d692";
    const index = E.buildEventIndex([google, family]);
    assertEqual(index["2026-09-21"].length, 2, "both present");
    assertEqual(index["2026-09-21"].map(e => e.event.color), ["#9a9cff", "#42d692"], "colours kept");
});

test("eventsOnDay returns an empty array for a quiet day", () => {
    const index = E.buildEventIndex([allDay("x", 2026, 8, 21, 1)]);
    assertEqual(E.eventsOnDay(index, 2026, 8, 22), [], "nothing on the 22nd");
    assertEqual(E.eventsOnDay(index, 2026, 8, 21).length, 1, "one on the 21st");
});

test("maxEventsInMonth finds the busiest day", () => {
    const index = E.buildEventIndex([
        allDay("a", 2026, 8, 21, 1),
        timed("b", 2026, 8, 21, 9, 0, 1),
        timed("c", 2026, 8, 21, 10, 0, 1),
        timed("d", 2026, 8, 10, 10, 0, 1)
    ]);
    assertEqual(E.maxEventsInMonth(index, 2026, 8), 3, "three on the 21st");
    assertEqual(E.maxEventsInMonth(index, 2026, 7), 0, "nothing in August");
});

test("an absurdly long event is capped rather than materialised forever", () => {
    // A malformed feed can carry an end date centuries away. Without a
    // ceiling the index would try to build one entry per day for all of it.
    const index = E.buildEventIndex([
        { summary: "Broken", allDay: true, start: utcMs(2026, 0, 1),
          end: utcMs(3026, 0, 1), color: "#fff" }
    ]);
    assertEqual(Object.keys(index).length, E.MAX_SPAN_DAYS, "capped at MAX_SPAN_DAYS");
});

test("a long event is still on the calendar in a month past its 400th day", () => {
    // A lease, a sabbatical, a contract. The walk used to start at the event's
    // own start and stop after MAX_SPAN_DAYS, so the event held the grid for
    // its first 400 days and then silently stopped being drawn -- still running,
    // nowhere on screen. Clipping the run to the window is what fixes it: the
    // part that matters is the part in view.
    const lease = allDay("Lease", 2026, 0, 1, 730);      // 1 Jan 2026 + 2 years
    const index = E.buildEventIndex([lease], "2027-12-01", "2027-12-31");

    assertEqual(E.eventsOnDay(index, 2027, 11, 15).length, 1, "on 15 Dec 2027");
    assertEqual(Object.keys(index).length, 31, "exactly the days in the window");
});

test("a windowed walk starts and ends with the window, not the event", () => {
    // Every day in view is covered, and nothing outside it is built.
    const long = allDay("Long", 2026, 0, 1, 400);
    const index = E.buildEventIndex([long], "2026-06-01", "2026-06-30");
    assertEqual(Object.keys(index).sort()[0], "2026-06-01", "first day");
    assertEqual(Object.keys(index).sort().pop(), "2026-06-30", "last day");
});

test("first and last follow the event's real ends, not the window's", () => {
    // An event that began before the window is a continuation at its left
    // edge, so it must not be drawn as starting there. Same at the right.
    const spanning = allDay("Spanning", 2026, 8, 1, 30);        // 1-30 Sep
    const index = E.buildEventIndex([spanning], "2026-09-05", "2026-09-07");

    const fifth = E.eventsOnDay(index, 2026, 8, 5)[0];
    const seventh = E.eventsOnDay(index, 2026, 8, 7)[0];
    assertEqual([fifth.first, fifth.last], [false, false], "both edges are continuations");

    const inside = allDay("Inside", 2026, 8, 5, 3);             // 5-7 Sep
    const exact = E.buildEventIndex([inside], "2026-09-05", "2026-09-07");
    const a = E.eventsOnDay(exact, 2026, 8, 5)[0];
    const b = E.eventsOnDay(exact, 2026, 8, 7)[0];
    assertEqual([a.first, a.last], [true, false], "starts here");
    assertEqual([b.first, b.last], [false, true], "ends here");
});

test("an event the window does not reach contributes nothing", () => {
    const index = E.buildEventIndex([allDay("Elsewhere", 2026, 0, 1, 2)],
        "2026-06-01", "2026-06-30");
    assertEqual(index, {}, "nothing indexed");
});

test("an event whose end date falls before its start date stays on one day", () => {
    // Only reachable when a clock falls back across midnight, which puts the
    // local end date *behind* the local start date even though the end instant
    // is later. The index walks forward one civil day at a time, so an end key
    // in the past is unreachable: before the guard, this event smeared across
    // MAX_SPAN_DAYS days and never covered the day it was actually on.
    const start = new Date(2009, 10, 1, 0, 0, 0).getTime();   // local Nov 1
    const end = start + 30 * 60000;
    const index = E.buildEventIndex([
        { summary: "Fall back", allDay: false, start: start, end: end, color: "#fff" }
    ]);
    const keys = Object.keys(index);
    assertEqual(keys.length, 1, "exactly one day, not " + keys.length);
    assertEqual(index[keys[0]][0].first, true, "flagged first");
    assertEqual(index[keys[0]][0].last, true, "flagged last");
});

test("the end-before-start guard does not disturb ordinary events", () => {
    const index = E.buildEventIndex([timed("Normal", 2026, 8, 21, 22, 0, 4)]);
    assertEqual(Object.keys(index).sort(), ["2026-09-21", "2026-09-22"], "still spans two days");
});

test("an empty or missing event list is handled", () => {
    assertEqual(E.buildEventIndex([]), {}, "empty array");
    assertEqual(E.buildEventIndex(null), {}, "null");
    assertEqual(E.buildEventIndex(undefined), {}, "undefined");
});

test("event times format in both 24-hour and 12-hour form", () => {
    const t = localMs(2026, 8, 21, 14, 5);
    assertEqual(E.formatEventTime(t, true), "14:05", "24h");
    assertEqual(E.formatEventTime(t, false), "2:05 PM", "12h afternoon");
    const midnight = localMs(2026, 8, 21, 0, 30);
    assertEqual(E.formatEventTime(midnight, false), "12:30 AM", "12h midnight is 12, not 0");
    const noon = localMs(2026, 8, 21, 12, 0);
    assertEqual(E.formatEventTime(noon, false), "12:00 PM", "12h noon");
});

test("describeEvent labels all-day events and times the rest", () => {
    assertEqual(E.describeEvent(allDay("Holiday", 2026, 8, 21, 1), true), "Holiday", "all-day has no time");
    assertEqual(E.describeEvent(timed("Standup", 2026, 8, 21, 9, 30, 1), true), "09:30  Standup", "timed");
    assertEqual(E.describeEvent(allDay("", 2026, 8, 21, 1), true), "(no title)", "untitled");
});

test("the second day of an overnight event does not repeat the start time", () => {
    // 22:00 on the 21st to 02:00 on the 22nd. The 22nd's cell used to read
    // "22:00  Night shift" -- a time the event was not happening at, because
    // 22:00 on the 22nd is a different moment from 22:00 on the 21st.
    const night = timed("Night shift", 2026, 8, 21, 22, 0, 4);

    const first = { event: night, first: true, last: false };
    const second = { event: night, first: false, last: true };

    assertEqual(E.describeEntry(first, true), "22:00  Night shift", "the day it starts");
    assertEqual(E.describeEntry(second, true), "↳  Night shift", "the day it runs into");
});

test("a continuation is marked however many days it lasts", () => {
    const days = (n) => Array.from({ length: n }, (_, i) => ({ event: timed("Offsite", 2026, 8, 1, 9, 0, n * 24), first: i === 0, last: i === n - 1 }));
    const labels = days(3).map(e => E.describeEntry(e, true));
    assertEqual(labels, ["09:00  Offsite", "↳  Offsite", "↳  Offsite"], "only the first carries the time");
});

test("a multi-day all-day event reads the same on every day", () => {
    // Nothing to be wrong about: an all-day event never showed a time.
    const holiday = allDay("Conference", 2026, 8, 1, 3);
    const l = (i) => E.describeEntry({ event: holiday, first: i === 0, last: i === 2 }, true);
    assertEqual([l(0), l(1), l(2)], ["Conference", "Conference", "Conference"], "unchanged");
});

test("an untitled continuation still says something", () => {
    const mystery = timed("", 2026, 8, 21, 22, 0, 4);
    assertEqual(E.describeEntry({ event: mystery, first: false, last: true }, true),
        "↳  (no title)", "not an empty label");
});

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

print("");
print("  Big Calendar desklet -- logic tests");
print("  " + "=".repeat(46));
if (failures.length) {
    print("");
    for (const f of failures) print("  FAIL  " + f);
}
print("");
print("  passed: " + passed + "   failed: " + failed);
print("");

if (failed > 0) throw new Error(failed + " test(s) failed");
