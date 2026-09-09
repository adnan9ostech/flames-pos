-- Kitchen ticket mode (3 Sep 2026). NOT re-runnable (an ALTER), kept apart
-- from anything that is, per the rule 007/008/010/011/012 follow.
--
-- v1 printed one slip per CATEGORY in a round — the section gets its whole
-- list on one piece of paper. The owner asked for the other shape: one slip
-- per LINE, so a ticket can travel with the dish it names and be spiked
-- against it. Both are legitimate kitchen practice and neither is a subset of
-- the other, so it is a setting rather than a rewrite.
--
-- VARCHAR rather than an ENUM: adding a third mode (per round, per course)
-- must not need a table rebuild on a shared cPanel box.
--
-- Default 'item' because that is what was asked for; the till reads this
-- column at print time, so switching it back takes effect on the next round
-- with no restart.
ALTER TABLE store_settings
  ADD COLUMN kot_mode VARCHAR(16) NOT NULL DEFAULT 'item';
