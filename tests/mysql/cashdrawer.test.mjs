/*
 * The cash drawer's arithmetic.
 *
 * Every number on this screen is somebody's money, and three of them are the
 * kind of mistake that is invisible until the till is short: an empty box read
 * as zero (a drawer closed at nothing), a denomination breakdown that does not
 * add up to its own total (a count that looks precise and is not), and a carry
 * forward larger than what was counted (cash promised to tomorrow that does not
 * exist). Each has its own case below.
 *
 * No database and no suite lock: a pure module, like the permissions and
 * day-rollover suites.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    PKR_DENOMINATIONS, round2, countFromDenominations, cleanDenominations,
    expectedCash, varianceOf, needsReason, cleanAmount, splitCount, suggestedFloat,
} from '../../src/lib/cash/drawer.mjs';

test('the denominations are the notes and coins in circulation, largest first', () => {
    assert.deepEqual(PKR_DENOMINATIONS, [5000, 1000, 500, 100, 50, 20, 10, 5, 2, 1]);
    const descending = [...PKR_DENOMINATIONS].sort((a, b) => b - a);
    assert.deepEqual(PKR_DENOMINATIONS, descending, 'a drawer is counted big notes first');
});

test('a breakdown adds up, whether the counts arrive as numbers or form strings', () => {
    assert.equal(countFromDenominations({ 5000: 2, 1000: 3, 100: 4, 50: 1 }), 13450);
    assert.equal(countFromDenominations({ '5000': '2', '100': '4' }), 10400);
    assert.equal(countFromDenominations({}), 0);
    assert.equal(countFromDenominations(null), 0);
});

test('a key that is not a denomination is ignored, never added at face value', () => {
    // 7000 is not a note. Counting it would invent Rs. 7,000 out of a typo.
    assert.equal(countFromDenominations({ 1000: 1, 7000: 1 }), 1000);
});

test('a count of notes must be whole and not negative', () => {
    assert.throws(() => countFromDenominations({ 500: -1 }), /zero or more/);
    assert.throws(() => countFromDenominations({ 500: 1.5 }), /whole number/);
});

test('cleanDenominations stores only what was actually counted', () => {
    assert.deepEqual(cleanDenominations({ 5000: 2, 1000: 0, 100: '', 50: 3 }), { '5000': 2, '50': 3 });
    assert.equal(cleanDenominations({}), null, 'nothing entered is a lump-sum count');
    assert.equal(cleanDenominations({ 1000: 0 }), null, 'zeroes are not a breakdown');
    assert.equal(cleanDenominations(undefined), null);
});

test('expected cash is the float plus the takings, less what left the drawer', () => {
    assert.equal(expectedCash({
        openingFloat: 5000, cashSales: 18400, paidIn: 500, paidOut: 300, drawerExpenses: 1200,
    }), 22400);
    // A void writes a NEGATIVE payment row: that refund left this drawer, so
    // the sum has to carry it rather than filter it out.
    assert.equal(expectedCash({ openingFloat: 5000, cashSales: -450 }), 4550);
    assert.equal(expectedCash({}), 0);
});

test('variance is counted minus expected — negative is short, positive is over', () => {
    assert.equal(varianceOf(22400, 22400), 0);
    assert.equal(varianceOf(22200, 22400), -200, 'short');
    assert.equal(varianceOf(22600, 22400), 200, 'over');
    // Float dust must not read as a variance: 0.1 + 0.2 is not 0.3 in binary.
    assert.equal(varianceOf(0.1 + 0.2, 0.3), 0);
});

test('a reason is demanded past the tolerance, in both directions', () => {
    assert.equal(needsReason(0, 0), false);
    assert.equal(needsReason(-1, 0), true, 'zero tolerance explains every rupee');
    assert.equal(needsReason(-5, 5), false, 'exactly at the tolerance is inside it');
    assert.equal(needsReason(-6, 5), true);
    assert.equal(needsReason(6, 5), true, 'an over is as much a question as a short');
});

test('an empty amount box is a missing answer, not zero rupees', () => {
    // The bug this exists to stop: Number('') is 0, so a blank count would
    // close the drawer at nothing and read as a catastrophic short.
    assert.throws(() => cleanAmount('', 'Counted amount'), /Counted amount is required/);
    assert.throws(() => cleanAmount(null), /required/);
    assert.throws(() => cleanAmount('  '), /required/);
    assert.throws(() => cleanAmount('abc'), /must be a number/);
    assert.throws(() => cleanAmount(-1), /cannot be negative/);
    assert.equal(cleanAmount('12500'), 12500);
    assert.equal(cleanAmount(0), 0, 'zero typed on purpose is a real answer');
});

test('the count splits exactly: what stays plus what leaves is what was counted', () => {
    const { counted, carry, handover } = splitCount({ counted: '22400', carryForward: '5000' });
    assert.equal(counted, 22400);
    assert.equal(carry, 5000);
    assert.equal(handover, 17400);
    assert.equal(round2(carry + handover), counted);
});

test('nothing left behind, and everything left behind, are both legal', () => {
    assert.deepEqual(splitCount({ counted: 9000, carryForward: 0 }),
        { counted: 9000, carry: 0, handover: 9000 });
    assert.deepEqual(splitCount({ counted: 9000, carryForward: 9000 }),
        { counted: 9000, carry: 9000, handover: 0 });
});

test('you cannot carry forward cash you did not count', () => {
    assert.throws(
        () => splitCount({ counted: 4000, carryForward: 5000 }),
        /cannot leave more in the drawer than you counted/,
    );
});

test('tomorrow opens on last night’s carry forward, not on what was counted', () => {
    // The whole point: the handover has already left the building.
    assert.equal(suggestedFloat({ lastCarryForward: 5000, defaultFloat: 3000 }), 5000);
    assert.equal(suggestedFloat({ lastCarryForward: 0, defaultFloat: 3000 }), 0,
        'a till emptied on purpose opens empty, not on the standing float');
    assert.equal(suggestedFloat({ lastCarryForward: null, defaultFloat: 3000 }), 3000,
        'no previous close to chain from falls back to the standing float');
    assert.equal(suggestedFloat({}), 0);
});
