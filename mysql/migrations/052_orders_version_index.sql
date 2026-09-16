-- The index the change token needs (16 Sep 2026). Re-runnable.
--
-- Every screen in the app polls a cheap "has anything changed?" token every
-- four seconds before it decides whether to run the expensive read. The token
-- was `SELECT COUNT(*), MAX(updated_at) FROM orders WHERE branch_id = ?` —
-- which is O(every order the branch has ever taken), forever, on the one query
-- that runs most often.
--
-- Measured on a 20,000-order copy with a realistic status mix:
--   as it shipped   type: ref, key: fk_orders_branch, rows examined 9,901,
--                   0.750 ms average and 13.3 ms at worst
--   with this index
--   and the query
--   bounded to a
--   recent window   type: range, key: idx_orders_branch_updated, rows 110,
--                   Using index — 0.015 ms average, 0.155 ms at worst
--
-- Fifty times cheaper on average, eighty-six times at the tail, and it stops
-- growing with the order count. The optimiser picks it unaided, which the
-- alternatives did not: a (branch_id, status, last_round_at) composite had to
-- be forced, because branch_id samples at cardinality 1 on a single-outlet
-- restaurant and the planner reasonably ignores it.
--
-- NOT ADDED, and worth recording: an index for the kitchen display's own poll.
-- That query was reported as a full scan needing one, and at a realistic status
-- distribution it is already `type: range` on orders_status_idx examining 18
-- rows in 0.028 ms — because only a handful of orders are ever in a live
-- kitchen status. The earlier 10,867-row measurement came from a fixture that
-- made 60% of rows live tickets, which is not a restaurant. Every candidate
-- index examined the same 18 rows and improved nothing, so adding one would
-- have cost disk and slowed every settle for no gain.
SET @add := (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE orders ADD KEY idx_orders_branch_updated (branch_id, updated_at)',
        'SELECT 1')
      FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'orders'
       AND index_name = 'idx_orders_branch_updated'
);
PREPARE s FROM @add; EXECUTE s; DEALLOCATE PREPARE s;

-- The unpaid badge polls on the same timer and counts open tabs, which is a
-- small set that never grows with history. orders_unpaid_idx (payment_status,
-- created_at) already serves it; the branch leads here so one outlet's badge
-- does not read the other's.
SET @add := (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE orders ADD KEY idx_orders_branch_payment (branch_id, payment_status, status)',
        'SELECT 1')
      FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'orders'
       AND index_name = 'idx_orders_branch_payment'
);
PREPARE s FROM @add; EXECUTE s; DEALLOCATE PREPARE s;
