-- A photo of the bill, on the expense (14 Sep 2026). Re-runnable.
--
-- An expense is a line that says money left the drawer. The paper that proves
-- it — the mandi slip, the diesel receipt, the plumber's chit — lives in a
-- shoebox, and by the time anybody asks, it is gone. A phone photo taken at
-- the counter is the difference between a number somebody has to trust and a
-- number somebody can check.
--
-- One column, not a table: an expense has one bill. Where a purchase genuinely
-- has several documents it goes through the expense VOUCHER side of the
-- accounts, which is built for that.
ALTER TABLE expenses
  ADD COLUMN attachment VARCHAR(255) NOT NULL DEFAULT '';
