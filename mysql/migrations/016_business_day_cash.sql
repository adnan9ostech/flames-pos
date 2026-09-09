-- The trading day's cash position (3 Sep 2026). NOT re-runnable (an ALTER),
-- kept apart from anything that is, per the rule 007/008/012/013/014/015
-- follow.
--
-- The cash a day opened and closed on is derivable from drawer_sessions, but
-- deriving it is exactly the wrong choice here: these two figures are the
-- ones a day-end report is signed against, and a report that recomputes
-- itself can change after somebody has signed it. Stamped once, they are what
-- the day actually was.
--
-- opening_cash is written when the day's first drawer opens; closing_cash is
-- written by the last drawer close on that day. Yesterday's closing_cash is
-- today's opening_cash — that chain is the whole point, and a break in it is
-- visible rather than silently smoothed over.
--
-- NULL means "no drawer was opened on this day", not zero. A restaurant that
-- traded card-only, or a day nobody worked, must not read as a till counted
-- down to nothing.
ALTER TABLE business_days
  ADD COLUMN opening_cash DECIMAL(12,2) NULL,
  ADD COLUMN closing_cash DECIMAL(12,2) NULL;
