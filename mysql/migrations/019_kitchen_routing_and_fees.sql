-- Kitchen ticket routing, KDS auto-print, void PIN, and two standing fees
-- (9 Sep 2026). The ALTER is NOT re-runnable (a plain ADD COLUMN, like 013);
-- the runner records the file only on success and schema_migrations stops a
-- re-run, so the seeds below stay idempotent for the times the file IS re-read.
--
-- kot_route decides WHICH machine prints the kitchen ticket:
--   'kds'  — the till prints only the customer receipt; the kitchen display
--            auto-prints each new round on ITS own printer. This is what the
--            owner asked for: the receipt printer and the kitchen printer are
--            different devices, so the two can never fight over one spool.
--   'till' — the pre-9-Sep behaviour: the till prints the slips itself, the
--            KDS does not. Kept for a single-printer counter with no kitchen
--            screen.
-- kds_auto_print lets the kitchen pause its own auto-print (a jam, an empty
-- roll) without touching the till; the KDS reprint button is unaffected.
-- void_requires_pin makes removing a line from the cart demand a manager PIN.
ALTER TABLE store_settings
  ADD COLUMN kot_route VARCHAR(8) NOT NULL DEFAULT 'kds',
  ADD COLUMN kds_auto_print TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN void_requires_pin TINYINT(1) NOT NULL DEFAULT 0;

-- Delivery fee: flat, delivery orders only, after tax (a pass-through cost,
-- not part of the taxable food base). The amount here is a placeholder the
-- Charges screen edits — every restaurant's delivery fee is its own number.
INSERT INTO charges (name, value_type, value, order_types, before_tax, auto_apply, is_active)
SELECT 'Delivery Charge', 'fixed', 150.00, '["delivery"]', 0, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM charges WHERE name = 'Delivery Charge');

-- The FBR POS service fee: Re. 1 per invoice on every order type, after tax.
-- Empty order_types means "all types". A fixed rupee, not a percent, because
-- it is a flat statutory fee and not a share of the bill.
INSERT INTO charges (name, value_type, value, order_types, before_tax, auto_apply, is_active)
SELECT 'POS Fee', 'fixed', 1.00, '[]', 0, 1, 1
WHERE NOT EXISTS (SELECT 1 FROM charges WHERE name = 'POS Fee');
