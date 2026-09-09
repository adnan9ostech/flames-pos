/*
 * The nav search palette's ranking, tested against the REAL index rather than
 * a fixture — the point of most of these cases is not the algorithm but the
 * vocabulary. "z report" finding the Handover Report is a fact about the
 * keywords on that row, and if someone tidies those keywords away the palette
 * silently stops answering the question the accountant actually asks.
 *
 * No database: this file sits beside the MySQL suite because that is where
 * `permissions.test.mjs` already put its pure-logic tests, and because
 * CLAUDE.md's one test command globs this directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NAV_INDEX, searchableNav, primaryNav, backOfficeNav } from '../../src/lib/navIndex.mjs';
import { searchNav } from '../../src/lib/navSearch.mjs';

const ALL = NAV_INDEX;
const top = (q) => searchNav(ALL, q)[0]?.href;
const hrefs = (q) => searchNav(ALL, q).map((e) => e.href);

test('1. the words a restaurant actually uses reach the right screen', () => {
    // Each of these is a phrase someone says out loud, not a route name.
    const vocabulary = [
        ['z report', '/reports/handover'],
        ['shift report', '/reports/handover'],
        ['best sellers', '/reports/menu-analytics'],
        ['product mix', '/reports/menu-analytics'],
        ['margin', '/reports/gross-profit'],
        ['food cost', '/reports/gross-profit'],
        ['peak', '/reports/hourly'],
        ['grn', '/inventory/receiving'],
        ['goods received', '/inventory/receiving'],
        ['vendors', '/inventory/suppliers'],
        ['fbr', '/settings/tax'],
        ['gst', '/settings/tax'],
        ['end of day', '/dayclose'],
        ['float', '/drawer'],
        ['btc', '/cityledger'],
        ['payables', '/accounts/reports/payables'],
        ['expense voucher', '/accounts/expense-vouchers'],
        ['balance sheet', '/accounts/reports/balance-sheet'],
        ['cash register', '/accounts/reports/cash-register'],
        ['change password', '/profile'],
        // Kitchen slang: 86 means sold out, and that is done on the till.
        ['86', '/pos'],
    ];
    for (const [query, expected] of vocabulary) {
        assert.equal(top(query), expected, `"${query}" should open ${expected}`);
    }
});

test('2. an exact label beats a keyword mention of the same word', () => {
    // "Reports" the section index must outrank the six reports that mention it.
    assert.equal(top('reports'), '/reports');
    // ...but the others are still offered.
    assert.ok(hrefs('report').includes('/reports/handover'));
});

test('3. initials and abbreviations find their screen', () => {
    assert.equal(top('grpr'), '/reports/gross-profit');
    assert.equal(top('kds'), '/kds');
    assert.equal(top('gp'), '/reports/gross-profit');
    // The accountant's shorthand. "coa" once lost to a three-letter
    // subsequence inside "Companies"; initials now outrank fuzzy hits.
    assert.equal(top('coa'), '/accounts/chart');
    assert.equal(top('tb'), '/accounts/reports/trial-balance');
    assert.equal(top('p&l'), '/accounts/reports/income-statement');
    assert.equal(top('gl'), '/accounts/ledger');
});

test('4. every token must match — a query is AND, not OR', () => {
    // "day" alone hits several screens; "day close" must not simply union them.
    assert.equal(top('day close'), '/dayclose');
    // A second token that matches nothing kills the result entirely.
    assert.deepEqual(searchNav(ALL, 'dayclose zzzz'), []);
});

test('5. nonsense returns nothing rather than a shrug of weak matches', () => {
    for (const q of ['qqqq', 'zzzzzz', '!!!!']) {
        assert.deepEqual(searchNav(ALL, q), [], `"${q}" should find nothing`);
    }
});

test('6. an empty query returns nothing (the palette shows recents instead)', () => {
    assert.deepEqual(searchNav(ALL, ''), []);
    assert.deepEqual(searchNav(ALL, '   '), []);
});

test('7. the weak tail is cut, so a short query stays trustworthy', () => {
    // "grpr" subsequence-matches a third of the app; only the real answer and
    // its near-peers should survive the relevance floor.
    assert.ok(searchNav(ALL, 'grpr').length <= 3);
    assert.ok(searchNav(ALL, 'r').length <= 12);
});

test('8. search can never offer a door the server would slam', () => {
    // A cashier holds pos/orders/kds/drawer and nothing else.
    const cashier = ['pos', 'orders', 'kds', 'drawer'];
    const visible = searchableNav(cashier);

    for (const entry of visible) {
        assert.ok(!entry.perm || cashier.includes(entry.perm),
            `${entry.href} needs "${entry.perm}", which a cashier does not hold`);
    }
    // The screens that would leak money or people are absent by name.
    const forbidden = ['/users', '/reports', '/settings/tax', '/cityledger', '/inventory'];
    for (const href of forbidden) {
        assert.ok(!visible.some((e) => e.href === href), `${href} must not be searchable by a cashier`);
    }
    // And searching for them finds nothing.
    assert.deepEqual(searchNav(visible, 'users'), []);
    assert.equal(searchNav(visible, 'tax').length, 0);
});

test('9. every entry is well formed, so a typo cannot silently unlist a screen', () => {
    const seen = new Set();
    for (const e of ALL) {
        assert.ok(e.href?.startsWith('/'), `bad href: ${e.href}`);
        assert.ok(!seen.has(e.href), `duplicate href: ${e.href}`);
        seen.add(e.href);
        assert.ok(e.label && e.label.length > 1, `bad label on ${e.href}`);
        assert.ok(e.section, `missing section on ${e.href}`);
        assert.ok(typeof e.icon === 'string' && e.icon, `icon must be a name string on ${e.href}`);
        assert.ok(e.keywords && e.keywords.length > 4, `${e.href} needs keywords to be findable`);
        if (e.nav) assert.ok(['primary', 'backoffice'].includes(e.nav), `bad nav rail on ${e.href}`);
    }
});

test('10. the two sidebar rails are drawn from the same index', () => {
    const admin = ['pos', 'orders', 'kds', 'void', 'drawer', 'dayclose', 'reports',
        'expenses', 'cityledger', 'inventory', 'menu', 'settings', 'users'];
    const rails = [...primaryNav(admin), ...backOfficeNav(admin)];

    // Every rail entry is a real index entry, and every rail entry is searchable.
    const searchable = new Set(searchableNav(admin).map((e) => e.href));
    for (const e of rails) {
        assert.ok(searchable.has(e.href), `${e.href} is on a rail but not searchable`);
    }
    // The inner pages are the ones search exists for: reachable, but not on a rail.
    const railHrefs = new Set(rails.map((e) => e.href));
    for (const href of ['/reports/handover', '/menu/recipes', '/settings/tax']) {
        assert.ok(searchable.has(href), `${href} must be searchable`);
        assert.ok(!railHrefs.has(href), `${href} is an inner page and should not be on a rail`);
    }
});
