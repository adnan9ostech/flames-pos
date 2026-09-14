import { query } from '@/lib/db/pool.mjs';
import { requirePermission } from '@/lib/db/auth.mjs';
import { requireDate, requireId, businessDate, money, ymd } from '@/lib/accounts/helpers.mjs';
import {
    trialBalance, incomeStatement, balanceSheet, cashAccounts, cashRegister,
} from '@/lib/accounts/statements.mjs';
import {
    trialBalanceRows, incomeStatementRows, balanceSheetRows, cashRegisterRows,
} from '@/app/accounts/reports/statementRows.mjs';
import { sheet, workbook, XLSX_MIME } from '@/lib/reports/xlsx.mjs';

/*
 * GET /api/accounts/export?report=<name>&from=&to=&asAt=&account=
 *
 * Streams one statement as a real .xlsx. A GET rather than a server action
 * returning base64 so the Excel button is a plain link the browser
 * downloads — no Blob juggling, and the file lands with a dated name.
 *
 * Reports: trial-balance | income-statement | balance-sheet | cash-register
 * (from statements.mjs, the same computation the screens show) and
 * expenses | payables (flat rows straight off expense_vouchers, so the
 * expense screens can offer the same button).
 *
 * Reading the books is `accounts`; there is nothing here that writes.
 */
export const dynamic = 'force-dynamic';

const REPORT_TITLES = {
    'trial-balance': 'Trial Balance',
    'income-statement': 'Income Statement',
    'balance-sheet': 'Balance Sheet',
    'cash-register': 'Cash Register',
    expenses: 'Expense Report',
    payables: 'Expense Payables',
};

const range = (sp) => {
    const from = requireDate(sp.get('from'), 'start date');
    const to = requireDate(sp.get('to'), 'end date');
    if (from > to) throw new Error('The start date must be on or before the end date');
    return { from, to };
};

/* A merchant name and a period line above the grid, then a blank row. */
const heading = (merchantName, title, period) => [[merchantName], [title], [period], []];

const expenseRows = async ({ from, to }) => {
    const rows = await query(
        `SELECT v.business_date, v.voucher_no, v.status, v.total, v.paid_total, v.remarks,
                l.description, l.amount, c.code, c.name AS code_name, cat.name AS category
           FROM expense_vouchers v
           JOIN expense_voucher_lines l ON l.voucher_id = v.id
           JOIN expense_codes c ON c.id = l.expense_code_id
           LEFT JOIN expense_categories cat ON cat.id = c.category_id
          WHERE v.status = 'posted' AND v.business_date >= ? AND v.business_date <= ?
          ORDER BY v.business_date, v.voucher_no, l.id`,
        [from, to],
    );
    const grid = [['Date', 'Voucher', 'Code', 'Expense', 'Category', 'Description', 'Amount', 'Voucher Total', 'Paid', 'Remarks']];
    let total = 0;
    for (const r of rows) {
        const amount = money(r.amount);
        total = money(total + amount);
        grid.push([
            ymd(r.business_date), r.voucher_no, r.code, r.code_name, r.category ?? '',
            r.description ?? '', amount, money(r.total), money(r.paid_total), r.remarks ?? '',
        ]);
    }
    grid.push(['Total', '', '', '', '', '', total, '', '', '']);
    return grid;
};

const payableRows = async () => {
    const rows = await query(
        `SELECT v.business_date, v.voucher_no, v.total, v.paid_total, v.remarks,
                GROUP_CONCAT(DISTINCT c.name ORDER BY c.name SEPARATOR ', ') AS codes
           FROM expense_vouchers v
           LEFT JOIN expense_voucher_lines l ON l.voucher_id = v.id
           LEFT JOIN expense_codes c ON c.id = l.expense_code_id
          WHERE v.status = 'posted' AND v.paid_total < v.total
          GROUP BY v.id, v.business_date, v.voucher_no, v.total, v.paid_total, v.remarks
          ORDER BY v.business_date, v.voucher_no`,
    );
    const grid = [['Date', 'Voucher', 'Expenses', 'Total', 'Paid', 'Owed', 'Remarks']];
    let owed = 0;
    for (const r of rows) {
        const due = money(money(r.total) - money(r.paid_total));
        owed = money(owed + due);
        grid.push([ymd(r.business_date), r.voucher_no, r.codes ?? '', money(r.total), money(r.paid_total), due, r.remarks ?? '']);
    }
    grid.push(['Total', '', '', '', '', owed, '']);
    return grid;
};

export async function GET(request) {
    try {
        await requirePermission('accounts');
    } catch (e) {
        return Response.json({ error: e.message }, { status: e.status ?? 401 });
    }

    try {
        const sp = new URL(request.url).searchParams;
        const report = sp.get('report');
        const title = REPORT_TITLES[report];
        if (!title) return Response.json({ error: 'Unknown report' }, { status: 400 });

        const [settings] = await query('SELECT merchant_name, brand_name FROM store_settings LIMIT 1');
        const merchantName = settings?.merchant_name || settings?.brand_name || '';

        let rows;
        let stamp;
        if (report === 'trial-balance') {
            const r = range(sp);
            rows = [...heading(merchantName, title, `${r.from} to ${r.to}`), ...trialBalanceRows(await trialBalance(r), { includeQuiet: sp.get('all') === '1' })];
            stamp = `${r.from}_to_${r.to}`;
        } else if (report === 'income-statement') {
            const r = range(sp);
            rows = [...heading(merchantName, title, `${r.from} to ${r.to}`), ...incomeStatementRows(await incomeStatement(r))];
            stamp = `${r.from}_to_${r.to}`;
        } else if (report === 'balance-sheet') {
            const asAt = sp.get('asAt') ? requireDate(sp.get('asAt'), 'as-at date') : await businessDate();
            rows = [...heading(merchantName, title, `As at ${asAt}`), ...balanceSheetRows(await balanceSheet({ asAt }))];
            stamp = `as-at_${asAt}`;
        } else if (report === 'cash-register') {
            const r = range(sp);
            const offered = await cashAccounts();
            const accountId = sp.get('account') ? requireId(sp.get('account'), 'account') : offered.defaultId;
            if (!accountId || !offered.accounts.some((a) => a.id === accountId)) {
                return Response.json({ error: 'That account is not a cash or bank account' }, { status: 400 });
            }
            const cr = await cashRegister({ accountId, ...r });
            rows = [
                ...heading(merchantName, `${title} · ${cr.account.account_number} ${cr.account.name}`, `${r.from} to ${r.to}`),
                ...cashRegisterRows(cr),
            ];
            stamp = `${cr.account.account_number}_${r.from}_to_${r.to}`;
        } else if (report === 'expenses') {
            const r = range(sp);
            rows = [...heading(merchantName, title, `${r.from} to ${r.to}`), ...await expenseRows(r)];
            stamp = `${r.from}_to_${r.to}`;
        } else {
            const today = await businessDate();
            rows = [...heading(merchantName, title, `Outstanding as at ${today}`), ...await payableRows()];
            stamp = `as-at_${today}`;
        }

        const buffer = workbook([sheet(title, rows)]);
        const filename = `${report}_${stamp}.xlsx`;
        return new Response(buffer, {
            status: 200,
            headers: {
                'Content-Type': XLSX_MIME,
                'Content-Disposition': `attachment; filename="${filename}"`,
                'Content-Length': String(buffer.length),
                'Cache-Control': 'no-store',
            },
        });
    } catch (e) {
        return Response.json({ error: e.message }, { status: 400 });
    }
}
