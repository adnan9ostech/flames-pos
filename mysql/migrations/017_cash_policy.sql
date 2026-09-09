-- Cash policy the admin sets once (3 Sep 2026). NOT re-runnable (an ALTER),
-- kept apart from anything that is, per the rule 007/008/012/013/014/015/016
-- follow.
--
-- default_opening_float — the till's standing change float, the number the
-- close panel proposes to leave behind and the fallback on the very first
-- morning, when there is no previous close to carry forward from. Zero means
-- "propose nothing"; the cashier still types a figure, so a default of zero
-- changes no behaviour.
--
-- cash_variance_tolerance — how far a count may miss before the close demands
-- a written reason. Default 0.00, so today every difference has to be
-- explained; an owner who decides a rupee or two of change-making dust is not
-- worth a sentence raises it here rather than in the code. It is a
-- REASON threshold, never a permission to hide: the variance is recorded and
-- posted to Cash Over and Short whatever this is set to.
ALTER TABLE store_settings
  ADD COLUMN default_opening_float   DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN cash_variance_tolerance DECIMAL(12,2) NOT NULL DEFAULT 0.00;
