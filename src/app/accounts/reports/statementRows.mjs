/*
 * Each statement as a flat grid of rows — the shape a CSV and an .xlsx both
 * want. Pure functions over the objects statements.mjs returns, importable
 * by the browser (the CSV button) and by the export route (the Excel
 * button) alike, so the two files a person downloads can never disagree
 * about a column.
 *
 * Numbers stay numbers: the xlsx writer makes numeric cells of them and
 * the CSV builder formats them itself. Nothing here touches a locale.
 */

export const trialBalanceRows = (tb, { includeQuiet = false } = {}) => {
    const rows = [['Account', 'Account #', 'Opening', 'Debit', 'Credit', 'Closing']];
    for (const a of tb.accounts) {
        if (!includeQuiet && a.opening === 0 && a.debit === 0 && a.credit === 0) continue;
        rows.push([a.name, a.account_number, a.opening, a.debit, a.credit, a.closing]);
    }
    rows.push(['Total', '', tb.totals.opening, tb.totals.debit, tb.totals.credit, tb.totals.closing]);
    return rows;
};

export const incomeStatementRows = (is) => {
    const rows = [['Section', 'Account', 'Account #', 'Amount']];
    rows.push(['Revenue / Income', '', '', '']);
    for (const l of is.revenue) rows.push(['', l.name, l.account_number, l.amount]);
    rows.push(['', 'Sub-Total', '', is.revenueTotal]);
    rows.push(['Cost of Sales', '', '', '']);
    for (const l of is.costOfSales) rows.push(['', l.name, l.account_number, l.amount]);
    rows.push(['', 'Sub-Total', '', is.costOfSalesTotal]);
    rows.push(['Gross Profit', '', '', is.grossProfit]);
    rows.push(['Expenses', '', '', '']);
    for (const l of is.expenses) rows.push(['', l.name, l.account_number, l.amount]);
    rows.push(['', 'Sub-Total', '', is.expensesTotal]);
    rows.push(['Net Profit', '', '', is.netProfit]);
    return rows;
};

export const balanceSheetRows = (bs) => {
    const rows = [['Section', 'Category', 'Account', 'Account #', 'Amount']];
    const section = (title, groups, total, extra = []) => {
        rows.push([title, '', '', '', '']);
        for (const g of groups) {
            for (const l of g.lines) rows.push(['', g.category, l.name, l.account_number, l.amount]);
            rows.push(['', g.category, 'Total', '', g.total]);
        }
        for (const l of extra) rows.push(['', '', l.name, '', l.amount]);
        rows.push([`Total ${title}`, '', '', '', total]);
    };
    section('Assets', bs.assets, bs.assetsTotal);
    section('Liabilities', bs.liabilities, bs.liabilitiesTotal);
    section('Equity', bs.equity, bs.equityTotal, bs.equityComputed);
    rows.push(['Total Liabilities and Equity', '', '', '', bs.liabilitiesAndEquity]);
    rows.push(['Assets − (Liabilities + Equity)', '', '', '', bs.difference]);
    return rows;
};

export const cashRegisterRows = (cr) => {
    const rows = [['Date', 'Voucher', 'Description', 'Reference', 'Money In', 'Money Out', 'Balance']];
    rows.push([cr.from, '', 'Opening balance', '', '', '', cr.opening]);
    for (const r of cr.rows) {
        rows.push([
            r.business_date, r.voucher_no, r.memo ? `${r.description} · ${r.memo}` : r.description,
            r.reference ?? '', r.money_in || '', r.money_out || '', r.balance,
        ]);
    }
    rows.push([cr.to, '', 'Closing balance', '', cr.moneyIn, cr.moneyOut, cr.closing]);
    return rows;
};
