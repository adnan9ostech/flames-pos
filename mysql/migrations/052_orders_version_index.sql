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
-- growing with the order count.
--
-- The optimiser picks this index unaided AND the read becomes index-only
-- ("Using index"), which the pre-existing orders_updated_at_idx cannot manage:
-- it has no branch_id, so the branch predicate forces a row lookup. At 20,000
-- rows the millisecond difference between the two is inside noise — the WINDOW
-- is what did the work — so this index earns its place on the plan rather than
-- on the clock today, and earns it on the clock as the window fills and as
-- outlets are added.
--
-- A (branch_id, status, last_round_at) composite for the kitchen read had to be
-- FORCED to be used at all, which is why none was added; see below.
--
-- NOT ADDED, and worth recording: an index for the kitchen display's own poll.
-- That query was reported as a full scan needing one, and at a realistic status
-- distribution it is already `type: range` on orders_status_idx examining 18
-- rows in 0.028 ms — because only a handful of orders are ever in a live
-- kitchen status. The earlier 10,867-row measurement came from a fixture that
-- made 60% of rows live tickets, which is not a restaurant. Every candidate
-- index examined the same 18 rows and improved nothing, so adding one would
-- have cost disk and slowed every settle for no gain.
--
-- CORRECTION, from three independent re-measurements on their own fixtures:
-- the 10,867-row plan IS real and reproducible, but not for the reason given
-- above and not fixable by an index. Churn a few thousand orders through the
-- kitchen statuses while any one connection holds a read view open — a service
-- running alongside a long report or a backup — and undo on the status index
-- inflates its range estimate until the planner abandons it, at which point the
-- query costs ~18 ms. Commit the blocking transaction and it is back under a
-- millisecond. The plan is bistable and mid-service is the bad half, so every
-- measurement of it reports whichever half it happened to land on.
--
-- No index fixes that: each candidate was measured in the churned state and
-- every one was still ignored. What does fix it is bounding the query, which is
-- what getKitchenOrders now does on last_round_at — and which also bounds the
-- board's real unbounded growth, since nothing in this app ever clears a live
-- ticket without somebody pressing it.
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
