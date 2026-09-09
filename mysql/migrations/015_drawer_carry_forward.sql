-- What the drawer holds after the count (3 Sep 2026). NOT re-runnable (an
-- ALTER), kept apart from anything that is, per the rule 007/008/012/013/014
-- follow.
--
-- Until now a close recorded one number: what was counted. That answers "did
-- it balance" and nothing else. The two questions a restaurant actually asks
-- at the end of the night are "how much did I take out" and "how much is
-- sitting in the till for tomorrow" — and the second one IS tomorrow's
-- opening float, so leaving it uncounted meant every morning started with a
-- guess typed by hand.
--
--   counted_amount = carry_forward + handover_amount, always.
--
-- carry_forward stays in the drawer and becomes the next session's opening
-- float. handover_amount is the cash that physically left — to the owner, to
-- the safe, to the bank. Both are NULL on the sessions closed before this
-- migration, which is honest: nobody recorded the split, so the column does
-- not pretend otherwise.
--
-- denominations is the note-by-note count (JSON, {"5000":3,"1000":12,...}).
-- Counting by denomination is the difference between a count that is right
-- and a count that is a round number somebody wanted to be right; keeping the
-- breakdown means a short drawer can be recounted against what was declared
-- rather than argued about. JSON because the note set is Pakistan's today and
-- a currency reform must not need a table rebuild on a shared cPanel box.
ALTER TABLE drawer_sessions
  ADD COLUMN carry_forward   DECIMAL(12,2) NULL AFTER variance,
  ADD COLUMN handover_amount DECIMAL(12,2) NULL AFTER carry_forward,
  ADD COLUMN denominations   JSON          NULL AFTER notes;
