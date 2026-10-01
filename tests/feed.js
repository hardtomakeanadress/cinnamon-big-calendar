/* Connection-lifecycle tests for the calendar feed.
 *
 *   cjs -m tests/feed.js
 *
 * What this guards. Connecting to the calendars used to happen once and only
 * once: open() remembered its promise forever, so the second call replayed the
 * first result instead of trying again. A calendar that failed to connect --
 * machine booted before the network, OAuth token not yet renewed, account added
 * after the desklet started -- stayed missing for the whole session, because
 * the periodic refresh only ever re-queried the connections it already had.
 * Nothing on screen said so; the calendar was simply empty.
 *
 * The attempts here are stubbed, so this file needs no account, no server and
 * no network. It self-skips when the calendar libraries are absent, like its
 * neighbours, since importing the module pulls in libecal.
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

async function testAsync(name, fn) {
    try {
        await fn();
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

let CalendarFeed;
let dedupeOccurrences;
try {
    ({ CalendarFeed, dedupeOccurrences } = await import("../lib/calendarSource.js"));
} catch (e) {
    print("");
    print("  Big Calendar desklet -- feed tests");
    print("  " + "=".repeat(46));
    print("");
    print("  SKIPPED: the calendar libraries are not installed here.");
    print("  (" + e.message + ")");
    print("");
    throw new Error("");
}

/** A feed whose connection attempts are scripted, one per open() call. */
function scriptedFeed(attempts) {
    const feed = new CalendarFeed();
    feed.log = [];
    let n = 0;
    feed._openAll = async function () {
        const attempt = attempts[n++] || { entries: [] };
        feed.log.push("attempt " + n);
        for (const entry of attempt.entries) this._entries.push(entry);
        if (attempt.throw) throw attempt.throw;
    };
    return feed;
}

const CAL = (uid) => ({ uid, name: uid, color: "#fff", client: null });

/* ---------------------------------------------------------------- */

await testAsync("open() does not run twice at the same time", async () => {
    const feed = scriptedFeed([{ entries: [CAL("a")] }]);
    const both = await Promise.all([feed.open(), feed.open()]);
    assertEqual(feed.log.length, 1, "one attempt");
    assertEqual(both[0], both[1], "same promise result");
});

await testAsync("open() can be called again once it has finished", async () => {
    // The bug in one line: the second call has to make a second attempt.
    const feed = scriptedFeed([{ entries: [CAL("a")] }, { entries: [CAL("b")] }]);
    await feed.open();
    await feed.open();
    assertEqual(feed.log.length, 2, "two attempts");
    assertEqual(feed.calendars.map(c => c.uid), ["a", "b"], "both connected");
});

await testAsync("a failed connection is retried, and succeeds the second time", async () => {
    const feed = scriptedFeed([
        { throw: new Error("network is down") },
        { entries: [CAL("a")] }
    ]);

    let firstFailed = false;
    try {
        await feed.open();
    } catch (e) {
        firstFailed = true;
    }
    assertEqual(firstFailed, true, "the first attempt reports its failure");
    assertEqual(feed.isOpen, false, "nothing connected yet");

    await feed.open();
    assertEqual(feed.isOpen, true, "connected on the retry");
    assertEqual(feed.calendars.map(c => c.uid), ["a"], "the calendar is there");
});

/** A source list, in the shape _openAll() reads: only get_uid() is used. */
const registryOf = (uids) => ({
    list_sources: () => uids.map(uid => ({ get_uid: () => uid }))
});

await testAsync("a reconnect keeps the calendars that are already up", async () => {
    // The serious one. _openAll() merges; if it replaced instead, then every
    // time the refresh retried one unreachable calendar it would throw away the
    // working connections too, and the desktop would blink empty. A second
    // attempt must add, never re-create. Re-creating is also how you leak
    // connections: the old client is never closed.
    const feed = new CalendarFeed();
    const original = CAL("already-up");
    feed._entries = [original];

    await feed._openAll(registryOf(["already-up"]));

    assertEqual(feed.calendars.map(c => c.uid), ["already-up"], "still connected");
    assertEqual(feed._entries.length, 1, "one entry, not two");
    assertEqual(feed._entries[0], original, "the same entry, not a new one");
});

await testAsync("a calendar whose account was removed is dropped", async () => {
    // Removing the account in Online Accounts should stop the queries, not
    // leave the desklet asking a dead client forever.
    const feed = new CalendarFeed();
    feed._entries = [CAL("still-there"), CAL("removed-in-online-accounts")];

    await feed._openAll(registryOf(["still-there"]));

    assertEqual(feed.calendars.map(c => c.uid), ["still-there"], "only the live one");
});

/* ---------------------------------------------------------------- */

const EV = (uid, start, calendar) => ({
    uid, start, end: start + 3600000, allDay: false,
    summary: "s", color: "#fff", calendar: calendar || "c"
});

test("the same event from two calendars is drawn once", () => {
    // The case that prompted this: one calendar name, one colour, two dots on
    // the same day, because the calendar was subscribed twice.
    const once = dedupeOccurrences([
        EV("holiday-1", 1000, "Holidays"),
        EV("holiday-1", 1000, "Holidays")
    ]);
    assertEqual(once.length, 1, "one dot, not two");
    assertEqual(once[0].uid, "holiday-1", "the surviving one is the event");
});

test("a shared event keeps the calendar it was seen in first", () => {
    const once = dedupeOccurrences([
        EV("standup", 1000, "Work"),
        EV("standup", 1000, "Team")
    ]);
    assertEqual(once.map(e => e.calendar), ["Work"], "first one wins");
});

test("every occurrence of a repeating event survives", () => {
    // Same UID, different starts: these are the series, not copies of it.
    const all = dedupeOccurrences([
        EV("weekly", 1000), EV("weekly", 2000), EV("weekly", 3000)
    ]);
    assertEqual(all.length, 3, "all three occurrences");
});

test("two different events at the same instant both survive", () => {
    const both = dedupeOccurrences([EV("a", 1000), EV("b", 1000)]);
    assertEqual(both.length, 2, "neither is a copy of the other");
});

test("an event with no uid is never treated as a duplicate", () => {
    // Nothing to compare, and dropping one would lose a real event.
    const both = dedupeOccurrences([
        EV(null, 1000), EV(null, 1000), EV(undefined, 1000)
    ]);
    assertEqual(both.length, 3, "all kept");
});

test("input order is otherwise preserved", () => {
    const out = dedupeOccurrences([EV("a", 3), EV("b", 1), EV("a", 3), EV("c", 2)]);
    assertEqual(out.map(e => e.uid), ["a", "b", "c"], "stable, duplicates gone");
});

/* ---------------------------------------------------------------- */

print("");
print("  Big Calendar desklet -- feed tests");
print("  " + "=".repeat(46));
if (failures.length) {
    print("");
    for (const f of failures) print("  FAIL  " + f);
}
print("");
print("  passed: " + passed + "   failed: " + failed);
print("");

if (failed > 0) throw new Error(failed + " test(s) failed");
