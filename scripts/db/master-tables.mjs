/*
 * What travels to a new install, and what must never.
 *
 * `node scripts/db/migrate.mjs` builds 66 empty tables and seeds the reference
 * rows a POS cannot boot without — one branch, the units, the chart of
 * accounts, the expense codes, a service charge. It does NOT carry a menu,
 * because a menu is a business's own work and no migration can invent it.
 *
 * So a first deploy done by migrations alone gives you a working POS with
 * nothing to sell: somebody would retype 135 dishes, 125 recipes and 1,371
 * recipe lines by hand. That is what export-master.mjs exists to prevent.
 *
 * THE SPLIT, AND WHY IT IS DRAWN HERE:
 *
 * SETUP travels. It is what somebody sat and typed: the menu, its prices and
 * sizes, the recipes behind it, the ingredients, the suppliers, the tables,
 * the chart of accounts as edited.
 *
 * TRANSACTIONS do not travel, and this is the important half. Dev holds 56
 * test bills, 53 test payments and 279 test journal lines. Carried across,
 * the first live P&L, the first sales report and the ledger itself would all
 * contain money that was never taken. A new install's books start empty or
 * they are not books.
 *
 * COUNTERS do not travel either, so the first real bill is invoice 1 and token
 * 1 rather than 57. Both rows self-create on first use (orders.mjs INSERTs
 * them), so leaving them out is safe as well as correct — and FBR numbering
 * starting mid-sequence is a conversation nobody wants to have.
 *
 * SYSTEM never travels. schema_migrations belongs to the migrator, which will
 * disagree with a copied one. users is worse: dev passwords are known, and a
 * fresh install seeds its own admin flagged to change it.
 *
 * EVERY table must appear in exactly one list. That is enforced, not assumed —
 * add a table and forget to classify it and the export fails and names it,
 * rather than silently leaving a restaurant's data behind.
 */

/* Typed by a human, and lost forever if a deploy forgets it. */
export const SETUP = [
    'units', 'warehouses', 'branches', 'branch_settings', 'companies',
    'accounts', 'gl_links', 'gl_settings',
    'expense_categories', 'expense_codes',
    'categories', 'menu_items', 'branch_menu_items', 'variation_sets',
    'modifiers', 'deals', 'deal_lines', 'discount_plans',
    'inventory_items', 'recipes', 'recipe_lines', 'sub_recipe_lines',
    'suppliers', 'customers',
    'dining_tables', 'waiters', 'charges', 'sales_channels', 'printers',
    'store_settings',
];

/* Money that moved, or a record of it. Dev's version of this is fiction. */
export const TRANSACTIONS = [
    'orders', 'order_items', 'order_rounds', 'payments', 'fbr_invoices',
    'gl_journals', 'gl_journal_lines',
    'expenses', 'expense_vouchers', 'expense_voucher_lines', 'expense_voucher_payments',
    'stock_docs', 'stock_doc_lines', 'stock_ledger',
    'stock_receivings', 'stock_receiving_lines',
    'purchase_orders', 'purchase_order_lines',
    'waste_docs', 'waste_lines',
    'demand_drafts', 'demand_draft_lines',
    'company_invoices', 'company_receipts', 'supplier_payments',
    'business_days', 'drawer_sessions', 'drawer_movements',
    'audit_log', 'notifications',
];

/* Reset, so the first live document is number one. */
export const COUNTERS = [
    'invoice_counters', 'token_counters',
    'gl_voucher_counters', 'expense_voucher_counters',
];

/* Owned by the migrator and the seeder respectively. */
export const SYSTEM = ['schema_migrations', 'users'];

/*
 * Returns what is wrong, or an empty array. Checked against the live database
 * rather than a hardcoded count, so it keeps being true as the schema grows.
 */
export const classificationProblems = (tablesInDb) => {
    const problems = [];
    const all = [...SETUP, ...TRANSACTIONS, ...COUNTERS, ...SYSTEM];

    const seen = new Set();
    for (const t of all) {
        if (seen.has(t)) problems.push(`'${t}' is classified twice`);
        seen.add(t);
    }
    for (const t of tablesInDb) {
        if (!seen.has(t)) problems.push(`'${t}' is in the database but classified nowhere — add it to SETUP or TRANSACTIONS in scripts/db/master-tables.mjs`);
    }
    for (const t of all) {
        if (!tablesInDb.includes(t)) problems.push(`'${t}' is classified but not in the database — stale entry`);
    }
    return problems;
};

/*
 * Parents before children, so the REPLACE in the dump cannot cascade away a
 * child table that was loaded earlier. Derived from the live foreign keys
 * instead of a hand-kept order, which would drift.
 */
export const parentsFirst = (tables, edges) => {
    const set = new Set(tables);
    const deps = new Map(tables.map((t) => [t, new Set()]));
    for (const { child, parent } of edges) {
        // Self-references (accounts.parent_id) order rows, not tables.
        if (child === parent) continue;
        if (set.has(child) && set.has(parent)) deps.get(child).add(parent);
    }

    const out = [];
    const done = new Set();
    // Cycles are possible in principle (two tables referencing each other);
    // a pass that places nothing means the rest are mutually dependent, and
    // FOREIGN_KEY_CHECKS=0 in the dump covers that case. Emit them and move on.
    while (out.length < tables.length) {
        const ready = tables.filter((t) => !done.has(t) && [...deps.get(t)].every((p) => done.has(p)));
        const batch = ready.length ? ready : tables.filter((t) => !done.has(t));
        for (const t of batch) { out.push(t); done.add(t); }
    }
    return out;
};
