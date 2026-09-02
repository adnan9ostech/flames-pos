/*
 * The balance queries every statement is built from. A balance is never
 * stored: it is SUM(debit) - SUM(credit) over posted lines, computed on
 * read, so a Trial Balance, an Income Statement and a Balance Sheet drawn
 * from this file cannot disagree with each other or with the ledger.
 *
 * Sign convention is debit-positive throughout, matching ChowPOS's trial
 * balance: an asset or expense carries a positive balance, a liability,
 * income or equity account a negative one. The statement builders below
 * flip the sign where an accountant expects a magnitude (revenue shown as
 * a positive figure), and say so at each place they do.
 *
 * Plain-Node importable, relative imports only, like post.mjs: the export
 * route and the server actions both read from here, and a test can drive
 * it without Next. The few small helpers are restated rather than imported
 * from helpers.mjs for the same reason post.mjs gives — that file is
 * `server-only`.
 */
import { query } from '../db/pool.mjs';
import { GROUPS } from './constants.mjs';
import { money, ymd } from './kit.mjs';

/* Paise-exact. Every figure that reaches a total or an equality check goes
 * through here first: a sum of DECIMALs can carry float dust. */

/* The categories the Income Statement treats specially. Category is free
 * text on the chart, so the match is case-insensitive on the seeded names. */
const CONTRA_REVENUE = 'CONTRA REVENUE';
const COST_OF_SALES = 'COST OF GOODS SOLD';

const GROUP_ORDER = Object.fromEntries(GROUPS.map((g, i) => [g.key, i]));

const accountShape = (r) => ({
    id: Number(r.id),
    account_number: r.account_number,
    name: r.name,
    account_group: r.account_group,
    category: r.category,
    is_active: Boolean(r.is_active),
});

/*
 * Per account: the balance carried in before `from`, the movement inside
 * [from, to], and what that leaves. Only posted journals count — a draft
 * or a voided one is not in the books.
 *
 * One pass over the lines does all three figures; the CASE arms split them
 * by date. An account with no postings still appears (LEFT JOIN) with zeros,
 * so the Trial Balance can list the whole chart and the page can decide
 * whether to hide the quiet rows.
 */
const accountBalances = async ({ from, to }) => {
    const rows = await query(
        `SELECT a.id, a.account_number, a.name, a.account_group, a.category, a.is_active,
                COALESCE(SUM(CASE WHEN j.business_date < ? THEN l.debit - l.credit END), 0) AS opening,
                COALESCE(SUM(CASE WHEN j.business_date >= ? AND j.business_date <= ? THEN l.debit END), 0) AS debit,
                COALESCE(SUM(CASE WHEN j.business_date >= ? AND j.business_date <= ? THEN l.credit END), 0) AS credit
           FROM accounts a
           LEFT JOIN (gl_journal_lines l
                      JOIN gl_journals j ON j.id = l.journal_id AND j.status = 'posted')
             ON l.account_id = a.id
          GROUP BY a.id, a.account_number, a.name, a.account_group, a.category, a.is_active
          ORDER BY a.account_number`,
        [from, from, to, from, to],
    );
    return rows.map((r) => {
        const opening = money(r.opening);
        const debit = money(r.debit);
        const credit = money(r.credit);
        return {
            ...accountShape(r),
            opening,
            debit,
            credit,
            closing: money(opening + debit - credit),
        };
    });
};

/*
 * Closing balances as at a day, debit-positive. The Balance Sheet's query,
 * and the same shape accountBalances gives for `closing`.
 */
const balancesAsAt = async (asAt) => {
    const rows = await query(
        `SELECT a.id, a.account_number, a.name, a.account_group, a.category, a.is_active,
                COALESCE(SUM(CASE WHEN j.business_date <= ? THEN l.debit - l.credit END), 0) AS balance
           FROM accounts a
           LEFT JOIN (gl_journal_lines l
                      JOIN gl_journals j ON j.id = l.journal_id AND j.status = 'posted')
             ON l.account_id = a.id
          GROUP BY a.id, a.account_number, a.name, a.account_group, a.category, a.is_active
          ORDER BY a.account_number`,
        [asAt],
    );
    return rows.map((r) => ({ ...accountShape(r), balance: money(r.balance) }));
};

/*
 * The Trial Balance: every account with its opening, movement and closing,
 * plus the totals row and the check the whole module rests on. The two
 * movement totals must be equal — every journal is balanced by CHECK
 * constraint — and so must the two closing sides. The page states which.
 */
export const trialBalance = async ({ from, to }) => {
    const accounts = await accountBalances({ from, to });
    const totals = accounts.reduce((t, a) => ({
        opening: money(t.opening + a.opening),
        debit: money(t.debit + a.debit),
        credit: money(t.credit + a.credit),
        closing: money(t.closing + a.closing),
    }), { opening: 0, debit: 0, credit: 0, closing: 0 });
    const difference = money(totals.debit - totals.credit);
    return {
        from,
        to,
        accounts,
        totals,
        balanced: difference === 0 && totals.closing === 0,
        difference,
    };
};

/*
 * Income Statement, ChowPOS's shape exactly: Revenue lines → Sub-Total;
 * Cost of Sales → Sub-Total; Gross Profit; Expenses → Sub-Total; Net Profit.
 *
 * Movement only (within the period), never balances: a P&L is a flow. Signs
 * are presented the way an accountant reads them — income as a positive
 * magnitude (credit − debit), cost and expense as positive magnitudes
 * (debit − credit). The contra-revenue category (Discounts Allowed, a
 * debit-normal income account) is shown as a NEGATIVE line under revenue,
 * so the revenue sub-total is net sales. Accounts with no movement are
 * left out; a statement full of zero lines says nothing.
 */
export const incomeStatement = async ({ from, to }) => {
    const accounts = await accountBalances({ from, to });
    const active = accounts.filter((a) => a.debit !== 0 || a.credit !== 0);
    const isCat = (a, cat) => String(a.category).trim().toUpperCase() === cat;

    const line = (a, amount) => ({
        id: a.id, account_number: a.account_number, name: a.name, category: a.category, amount: money(amount),
    });

    const revenue = active
        .filter((a) => a.account_group === 'income')
        .map((a) => (isCat(a, CONTRA_REVENUE)
            // A discount is a reduction of sales: debit-normal, shown negative.
            ? { ...line(a, -(a.debit - a.credit)), contra: true }
            : line(a, a.credit - a.debit)));
    // Contra lines sit under the sales they reduce.
    revenue.sort((x, y) => Number(Boolean(x.contra)) - Number(Boolean(y.contra)) || x.account_number.localeCompare(y.account_number));

    const costOfSales = active
        .filter((a) => a.account_group === 'expense' && isCat(a, COST_OF_SALES))
        .map((a) => line(a, a.debit - a.credit));
    const expenses = active
        .filter((a) => a.account_group === 'expense' && !isCat(a, COST_OF_SALES))
        .map((a) => line(a, a.debit - a.credit));

    const sum = (xs) => money(xs.reduce((s, l) => s + l.amount, 0));
    const revenueTotal = sum(revenue);
    const costOfSalesTotal = sum(costOfSales);
    const grossProfit = money(revenueTotal - costOfSalesTotal);
    const expensesTotal = sum(expenses);
    const netProfit = money(grossProfit - expensesTotal);

    return {
        from,
        to,
        revenue,
        revenueTotal,
        costOfSales,
        costOfSalesTotal,
        grossProfit,
        expenses,
        expensesTotal,
        netProfit,
    };
};

/* Group a list of {category, ...} lines into [{category, lines, total}] in
 * first-seen order, which is account-number order. */
const byCategory = (lines) => {
    const groups = [];
    const index = new Map();
    for (const l of lines) {
        let g = index.get(l.category);
        if (!g) {
            g = { category: l.category, lines: [], total: 0 };
            index.set(l.category, g);
            groups.push(g);
        }
        g.lines.push(l);
        g.total = money(g.total + l.amount);
    }
    return groups;
};

/*
 * Balance Sheet as at a day. Assets are shown debit-positive; liabilities
 * and equity credit-positive (sign flipped), so every section reads as a
 * magnitude and Assets = Liabilities + Equity can be checked by eye.
 *
 * There is no year-end close in this ledger, so the income and expense
 * accounts are never swept to Retained Earnings. Their net — the profit
 * since the ledger began — is shown as one computed equity line,
 * "Current period earnings", which is what makes the two sides agree. If a
 * manual journal was ever dated before gl_settings.start_date and touched a
 * P&L account, its net is shown as a second line rather than silently
 * folded in, so the label on the first stays true.
 */
export const balanceSheet = async ({ asAt }) => {
    const [balances, settingsRows] = await Promise.all([
        balancesAsAt(asAt),
        query('SELECT start_date FROM gl_settings WHERE id = 1'),
    ]);
    const startDate = settingsRows[0] ? ymd(settingsRows[0].start_date) : null;

    const active = balances.filter((a) => a.balance !== 0);
    const line = (a, amount) => ({
        id: a.id, account_number: a.account_number, name: a.name, category: a.category, amount: money(amount),
    });

    const assets = byCategory(active.filter((a) => a.account_group === 'asset').map((a) => line(a, a.balance)));
    const liabilities = byCategory(active.filter((a) => a.account_group === 'liability').map((a) => line(a, -a.balance)));
    const equityLines = active.filter((a) => a.account_group === 'equity').map((a) => line(a, -a.balance));

    // Net profit to date: P&L balances are credit-positive when profitable.
    const plTotal = money(active
        .filter((a) => a.account_group === 'income' || a.account_group === 'expense')
        .reduce((s, a) => s - a.balance, 0));

    let earningsSinceStart = plTotal;
    let priorEarnings = 0;
    if (startDate) {
        const before = await query(
            `SELECT COALESCE(SUM(l.credit - l.debit), 0) AS net
               FROM gl_journal_lines l
               JOIN gl_journals j ON j.id = l.journal_id AND j.status = 'posted'
               JOIN accounts a ON a.id = l.account_id
              WHERE a.account_group IN ('income', 'expense')
                AND j.business_date < ? AND j.business_date <= ?`,
            [startDate, asAt],
        );
        priorEarnings = money(before[0]?.net);
        earningsSinceStart = money(plTotal - priorEarnings);
    }

    const equity = byCategory(equityLines);
    const computed = [];
    if (priorEarnings !== 0) {
        computed.push({ id: null, account_number: '', name: `Earnings before ${startDate}`, amount: priorEarnings, computed: true });
    }
    computed.push({
        id: null,
        account_number: '',
        name: startDate ? `Current period earnings (${startDate} to ${asAt})` : 'Current period earnings',
        amount: earningsSinceStart,
        computed: true,
    });

    const sum = (groups) => money(groups.reduce((s, g) => s + g.total, 0));
    const assetsTotal = sum(assets);
    const liabilitiesTotal = sum(liabilities);
    const equityAccountsTotal = sum(equity);
    const equityTotal = money(equityAccountsTotal + computed.reduce((s, l) => s + l.amount, 0));
    const difference = money(assetsTotal - liabilitiesTotal - equityTotal);

    return {
        asAt,
        startDate,
        assets,
        assetsTotal,
        liabilities,
        liabilitiesTotal,
        equity,
        equityComputed: computed,
        equityTotal,
        liabilitiesAndEquity: money(liabilitiesTotal + equityTotal),
        balanced: difference === 0,
        difference,
    };
};

/*
 * The accounts the Cash Register may show: active assets that can both
 * receive a settlement (AR_PAID) and pay an expense (AP_PAID) — a drawer, a
 * safe, a bank. The default is whatever the till's cash settles into, read
 * from gl_links rather than assumed.
 */
export const cashAccounts = async () => {
    const [rows, links] = await Promise.all([
        query(
            `SELECT id, account_number, name, account_group, category, is_active
               FROM accounts
              WHERE account_group = 'asset' AND is_active = 1
                AND JSON_CONTAINS(link_codes, '"AR_PAID"')
                AND JSON_CONTAINS(link_codes, '"AP_PAID"')
              ORDER BY account_number`,
        ),
        query(`SELECT account_id FROM gl_links WHERE link_type = 'payment_method' AND ref_id = 'cash'`),
    ]);
    const accounts = rows.map(accountShape);
    const cashId = links[0] ? Number(links[0].account_id) : null;
    const defaultId = accounts.some((a) => a.id === cashId) ? cashId : (accounts[0]?.id ?? null);
    return { accounts, defaultId };
};

/*
 * Every posted line on one account inside a date range, with a running
 * balance from the opening figure. Money in is the debit side (an asset
 * grows on debit), money out the credit side.
 *
 * The hourly summary buckets by the journal's creation instant on the
 * Karachi clock: DATETIME(3) is UTC and Karachi is a fixed UTC+5, so the
 * shift is arithmetic — + INTERVAL 5 HOUR, never CONVERT_TZ, which needs
 * the tz tables the shared host may not have.
 */
export const cashRegister = async ({ accountId, from, to }) => {
    const [accountRows, openingRows, lines, hours] = await Promise.all([
        query('SELECT id, account_number, name, account_group, category, is_active FROM accounts WHERE id = ?', [accountId]),
        query(
            `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS opening
               FROM gl_journal_lines l
               JOIN gl_journals j ON j.id = l.journal_id AND j.status = 'posted'
              WHERE l.account_id = ? AND j.business_date < ?`,
            [accountId, from],
        ),
        query(
            `SELECT j.id AS journal_id, j.business_date, j.voucher_type, j.voucher_no, j.description,
                    j.reference, j.created_at, l.id AS line_id, l.debit, l.credit, l.memo
               FROM gl_journal_lines l
               JOIN gl_journals j ON j.id = l.journal_id AND j.status = 'posted'
              WHERE l.account_id = ? AND j.business_date >= ? AND j.business_date <= ?
              ORDER BY j.business_date, j.created_at, j.id, l.id`,
            [accountId, from, to],
        ),
        query(
            `SELECT HOUR(j.created_at + INTERVAL 5 HOUR) AS hour,
                    COALESCE(SUM(l.debit), 0) AS money_in, COALESCE(SUM(l.credit), 0) AS money_out, COUNT(*) AS n
               FROM gl_journal_lines l
               JOIN gl_journals j ON j.id = l.journal_id AND j.status = 'posted'
              WHERE l.account_id = ? AND j.business_date >= ? AND j.business_date <= ?
              GROUP BY HOUR(j.created_at + INTERVAL 5 HOUR)
              ORDER BY hour`,
            [accountId, from, to],
        ),
    ]);
    const account = accountRows[0] ? accountShape(accountRows[0]) : null;
    if (!account) throw new Error('That account no longer exists');

    const opening = money(openingRows[0]?.opening);
    let running = opening;
    let moneyIn = 0;
    let moneyOut = 0;
    const rows = lines.map((l) => {
        const debit = money(l.debit);
        const credit = money(l.credit);
        running = money(running + debit - credit);
        moneyIn = money(moneyIn + debit);
        moneyOut = money(moneyOut + credit);
        return {
            line_id: Number(l.line_id),
            journal_id: Number(l.journal_id),
            business_date: ymd(l.business_date),
            voucher_type: l.voucher_type,
            voucher_no: l.voucher_no,
            description: l.description,
            reference: l.reference,
            memo: l.memo,
            money_in: debit,
            money_out: credit,
            balance: running,
        };
    });

    return {
        account,
        from,
        to,
        opening,
        rows,
        moneyIn,
        moneyOut,
        closing: running,
        byHour: hours.map((h) => ({
            hour: Number(h.hour),
            money_in: money(h.money_in),
            money_out: money(h.money_out),
            count: Number(h.n),
        })),
    };
};

/* Statement order for anything that sorts by group. */
const groupRank = (key) => GROUP_ORDER[key] ?? 99;
