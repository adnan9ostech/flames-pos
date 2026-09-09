/*
 * When is the trading day over?
 *
 * This is the one piece of the schedule that is pure arithmetic, and it is the
 * piece that decides whether a worker closes the day at the right moment or a
 * whole night's takings land on the wrong date. A restaurant day normally SPANS
 * MIDNIGHT — open 11:00, close 05:00 — so for most of the evening the clock
 * reads a time *before* the end time, and after midnight the calendar date has
 * moved on while the business date has not. Comparing times alone is wrong
 * twice a night, which is why these cases are spelled out.
 *
 * No database and no suite lock: a pure module, like the permissions suite.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    dueToClose, minutesOfDay, nextCalendarDay, ymd, karachiDay, karachiTime,
} from '../../src/lib/day/rollover.mjs';

/* A real instant, expressed as Karachi wall-clock time (UTC+5, no DST). */
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:00`);

test('minutesOfDay accepts what MySQL and a form each hand over', () => {
    assert.equal(minutesOfDay('05:00:00'), 300);   // a TIME column
    assert.equal(minutesOfDay('05:00'), 300);      // an <input type=time>
    assert.equal(minutesOfDay('23:59'), 1439);
    assert.equal(minutesOfDay('00:00'), 0);
    for (const bad of ['', null, undefined, 'nonsense', '24:00', '12:60', '5']) {
        assert.equal(minutesOfDay(bad), null, `${JSON.stringify(bad)} is not a time`);
    }
});

test('nextCalendarDay crosses months, years and a leap day', () => {
    assert.equal(nextCalendarDay('2026-09-03'), '2026-09-04');
    assert.equal(nextCalendarDay('2026-09-30'), '2026-10-01');
    assert.equal(nextCalendarDay('2026-12-31'), '2027-01-01');
    assert.equal(nextCalendarDay('2028-02-28'), '2028-02-29');
});

test('no schedule set means the day is never due — the manual button still rules', () => {
    const openDate = '2026-09-03';
    assert.equal(dueToClose({ dayEndTime: null, openDate, now: at('2026-09-04', '09:00') }), false);
    assert.equal(dueToClose({ dayEndTime: '', openDate, now: at('2026-09-04', '09:00') }), false);
    assert.equal(dueToClose({ dayEndTime: '05:00', openDate: null, now: at('2026-09-04', '09:00') }), false);
});

test('a day that spans midnight ends on the FOLLOWING date', () => {
    // Trading 11:00 -> 05:00. The day of 3 Sept ends at 05:00 on 4 Sept.
    const s = { dayStartTime: '11:00', dayEndTime: '05:00', openDate: '2026-09-03' };

    // Mid-service on its own date: the clock says 23:30, which is "past 05:00"
    // if you only compare times. It must NOT be due.
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '23:30') }), false, 'not due at 23:30 on its own date');
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '12:00') }), false, 'not due at noon');

    // After midnight but before the end: still trading.
    assert.equal(dueToClose({ ...s, now: at('2026-09-04', '02:00') }), false, 'not due at 02:00');
    assert.equal(dueToClose({ ...s, now: at('2026-09-04', '04:59') }), false, 'not due one minute early');

    // The moment itself, and after.
    assert.equal(dueToClose({ ...s, now: at('2026-09-04', '05:00') }), true, 'due at exactly 05:00');
    assert.equal(dueToClose({ ...s, now: at('2026-09-04', '05:01') }), true);
    assert.equal(dueToClose({ ...s, now: at('2026-09-04', '11:00') }), true);
});

test('an ordinary daytime shift ends on its own date', () => {
    // Trading 09:00 -> 22:00, no midnight crossing.
    const s = { dayStartTime: '09:00', dayEndTime: '22:00', openDate: '2026-09-03' };
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '08:00') }), false);
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '21:59') }), false);
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '22:00') }), true);
    assert.equal(dueToClose({ ...s, now: at('2026-09-04', '00:30') }), true, 'still due the next morning');
});

test('a day left open for days is due, whatever the clock says', () => {
    // The failure this whole feature exists to prevent: nobody pressed Close.
    const s = { dayStartTime: '11:00', dayEndTime: '05:00', openDate: '2026-09-01' };
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '13:00') }), true);
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '02:00') }), true);
});

test('a day opened ahead of today is not due yet', () => {
    // A close opens tomorrow's row; tomorrow must not immediately close itself.
    const s = { dayStartTime: '11:00', dayEndTime: '05:00', openDate: '2026-09-04' };
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '23:00') }), false);
    assert.equal(dueToClose({ ...s, now: at('2026-09-04', '23:00') }), false);
    assert.equal(dueToClose({ ...s, now: at('2026-09-05', '05:00') }), true);
});

test('with no start time the end time is read as belonging to the next day', () => {
    // The conservative reading: never close a day early on a half-set schedule.
    const s = { dayStartTime: null, dayEndTime: '05:00', openDate: '2026-09-03' };
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '06:00') }), false);
    assert.equal(dueToClose({ ...s, now: at('2026-09-04', '05:00') }), true);
});

test('a start and end at the same time is read as a full 24 hours', () => {
    const s = { dayStartTime: '06:00', dayEndTime: '06:00', openDate: '2026-09-03' };
    assert.equal(dueToClose({ ...s, now: at('2026-09-03', '23:00') }), false);
    assert.equal(dueToClose({ ...s, now: at('2026-09-04', '06:00') }), true);
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
