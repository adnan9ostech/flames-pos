-- The trading day on a schedule (3 Sep 2026). NOT re-runnable (ALTERs); kept
-- alone, per the rule 010-013 follow.
--
-- Until today the business day ended only when somebody pressed Close. Forget
-- once and the next morning's orders land on yesterday's date, because
-- resolveBusinessDate (src/lib/db/orders.mjs) stamps whatever row is still
-- open. These two columns let an admin say when the day starts and ends, and a
-- worker does the rest.
--
-- BOTH DEFAULT TO NULL, AND NULL MEANS TODAY'S BEHAVIOUR. Applying this
-- migration changes nothing at all until an admin sets the times: the worker
-- refuses to act on a NULL schedule, and Close stays the manual button it is.
--
-- TIME, not DATETIME: this is a wall-clock time of day in Asia/Karachi, and it
-- is the same every day. A trading day that spans midnight is the normal case
-- here (open 11:00, close 05:00), not the edge case — day_end_time earlier than
-- day_start_time is what says so, and the code reads it that way.
ALTER TABLE store_settings
  ADD COLUMN day_start_time TIME NULL,
  ADD COLUMN day_end_time   TIME NULL;

-- Who closed the day, in the sense of what rather than who: `closed_by` holds a
-- user id and must stay NULL for a machine close, so without this column an
-- automatic close is indistinguishable from a close by a deleted user.
ALTER TABLE business_days
  ADD COLUMN close_mode VARCHAR(8) NOT NULL DEFAULT 'manual';
