/*
 * The trading day's date arithmetic.
 *
 * A restaurant day SPANS MIDNIGHT — open 11:00, close 05:00 — so after midnight
 * the calendar date has moved on while the business date has not. Every helper
 * here exists because of that, and the day-close action and its screen both
 * import them: these assertions guard what production runs.
 *
 * They did not always. Until 9 Sep this file tested src/lib/day/rollover.mjs, a
 * module extracted for a scheduled-close worker that was never written, while
 * the live day close ran its own copy of the same arithmetic a few directories
 * away. Eleven tests passed against code the application never executed. The
 * owner settled it — the day closes on the button, never on a schedule — so the
 * scheduling predicate and the untested transaction verbs went, and what stayed
 * was wired into the caller that had been duplicating it.
 *
 * No database and no suite lock: a pure module, like the permissions suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    nextCalendarDay, ymd, karachiDay, karachiTime,
} from '../../src/lib/day/karachi.mjs';

test('nextCalendarDay crosses months, years and a leap day', () => {
    assert.equal(nextCalendarDay('2026-09-03'), '2026-09-04');
    assert.equal(nextCalendarDay('2026-09-30'), '2026-10-01');
    assert.equal(nextCalendarDay('2026-12-31'), '2027-01-01');
    assert.equal(nextCalendarDay('2028-02-28'), '2028-02-29');
});

test('the Karachi helpers read a real instant, not the box timezone', () => {
    // 00:30 UTC on 4 Sept is 05:30 Karachi on the same date.
    const instant = new Date('2026-09-04T00:30:00Z');
    assert.equal(karachiDay(instant), '2026-09-04');
    assert.equal(karachiTime(instant), '05:30');
    // 21:00 UTC on 3 Sept is 02:00 Karachi on the 4th — the after-midnight case.
    const late = new Date('2026-09-03T21:00:00Z');
    assert.equal(karachiDay(late), '2026-09-04');
    assert.equal(karachiTime(late), '02:00');
});

test('ymd takes both shapes a business_date arrives in', () => {
    assert.equal(ymd(new Date('2026-09-03T00:00:00Z')), '2026-09-03');
    assert.equal(ymd('2026-09-03'), '2026-09-03');
    assert.equal(ymd('2026-09-03T00:00:00.000Z'), '2026-09-03');
});
