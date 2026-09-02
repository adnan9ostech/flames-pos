/*
 * The three derived lists behind Posting Health, as plain queries on the
 * pool — relative imports only, so the test suite can assert that a settled
 * bill shows up here until the engine books it and vanishes the moment it
 * does. actions.js wraps these with the permission gate and the row shapes.
 */
import { query } from '../../../lib/db/pool.mjs';
import { ORDER_SOURCE_TYPES } from '../../../lib/accounts/post.mjs';

const START_DATE = '(SELECT start_date FROM gl_settings WHERE id = 1)';

/*
 * 1. Settled bills the ledger has no sale journal for. A bill voided before
 *    it ever posted is not a gap (the engine books nothing for it, on
 *    purpose); a voided bill whose sale DID post but whose reversal has not
 *    is, and says so.
 */
export const unpostedOrders = () => query(
    `SELECT o.id, o.invoice_number, o.order_number, o.order_type, o.table_number,
            o.business_date, o.total, o.payment_mode, o.status, o.paid_at,
            CASE WHEN o.status = 'cancelled' THEN 'void not reversed' ELSE 'no sale journal' END AS gap
       FROM orders o
       LEFT JOIN gl_journals sv ON sv.source_type = ? AND sv.source_id = o.id
       LEFT JOIN gl_journals rv ON rv.source_type = ? AND rv.source_id = o.id
      WHERE o.payment_status = 'paid'
        AND o.invoice_number IS NOT NULL
        AND o.business_date >= ${START_DATE}
        AND ((o.status <> 'cancelled' AND sv.id IS NULL)
          OR (o.status = 'cancelled' AND sv.id IS NOT NULL AND rv.id IS NULL))
      ORDER BY o.business_date, o.paid_at`,
    [ORDER_SOURCE_TYPES.sale, ORDER_SOURCE_TYPES.saleReversal],
);

/* 2. Payments rows (the void's negative ones included) with no settlement journal. */
export const unpostedPayments = () => query(
    `SELECT p.id, p.order_id, p.method, p.amount, p.paid_at,
            o.invoice_number, o.business_date, o.status
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       LEFT JOIN gl_journals j ON j.source_type = ? AND j.source_id = p.id
      WHERE o.invoice_number IS NOT NULL
        AND o.business_date >= ${START_DATE}
        AND j.id IS NULL
      ORDER BY p.paid_at, p.id`,
    [ORDER_SOURCE_TYPES.settlement],
);

/*
 * 4. Expenses typed on the Expenses screen since the ledger began. A row
 *    typed there lowers the drawer's expected cash (paid from the drawer)
 *    but writes no journal — only an expense voucher reaches the ledger —
 *    so GL cash sits above the drawer by exactly these until they are
 *    re-entered as vouchers and deleted here. Listed, not repostable: there
 *    is no account on the row to derive a journal from.
 */
export const legacyExpenses = () => query(
    `SELECT e.id, e.business_date, e.description, e.payee, e.amount, e.paid_from, e.status, e.created_at,
            c.name AS category
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id
      WHERE e.voucher_line_id IS NULL
        AND e.business_date >= ${START_DATE}
      ORDER BY e.business_date, e.id`,
);

/*
 * 3. Journals whose lines and header disagree, or whose header does not
 *    balance. The CHECK makes the last impossible and the poster asserts the
 *    first two, so this list should be empty forever — which is exactly why
 *    it is cheap to keep asking.
 */
export const brokenJournals = () => query(
    `SELECT j.id, j.voucher_no, j.voucher_type, j.business_date, j.description, j.reference,
            j.debit_total, j.credit_total,
            COALESCE(l.debit_sum, 0) AS line_debit, COALESCE(l.credit_sum, 0) AS line_credit,
            COALESCE(l.n, 0) AS line_count
       FROM gl_journals j
       LEFT JOIN (
            SELECT journal_id, SUM(debit) AS debit_sum, SUM(credit) AS credit_sum, COUNT(*) AS n
              FROM gl_journal_lines GROUP BY journal_id
       ) l ON l.journal_id = j.id
      WHERE j.status = 'posted'
        AND (l.journal_id IS NULL
          OR l.debit_sum <> j.debit_total
          OR l.credit_sum <> j.credit_total
          OR j.debit_total <> j.credit_total)
      ORDER BY j.business_date, j.id`,
);
