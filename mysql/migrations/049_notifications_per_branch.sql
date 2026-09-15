-- A notice belongs to one outlet (14 Sep 2026). Re-runnable.
--
-- `uq_notifications_key (dedupe_key)` is unique across the whole company. That
-- was right while there was one outlet and becomes a data bug the moment there
-- are two: Lahore running out of chicken and Islamabad running out of chicken
-- produce the SAME dedupe key, so the second one does not raise a notice — it
-- silently overwrites the first one's text and the first branch's alert
-- disappears. Whichever outlet scanned last wins, and neither can tell.
--
-- Widened to (branch_id, dedupe_key). Every existing row is branch 1, so the
-- new key holds the same rows and nothing is lost.
--
-- Dropped only if present, so this file is re-runnable on a database that has
-- already had it.
SET @drop := (
    SELECT IF(COUNT(*) > 0,
        'ALTER TABLE notifications DROP INDEX uq_notifications_key',
        'SELECT 1')
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'notifications'
       AND index_name = 'uq_notifications_key'
);
PREPARE stmt FROM @drop; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add := (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE notifications ADD UNIQUE KEY uq_notifications_branch_key (branch_id, dedupe_key)',
        'SELECT 1')
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = 'notifications'
       AND index_name = 'uq_notifications_branch_key'
);
PREPARE stmt FROM @add; EXECUTE stmt; DEALLOCATE PREPARE stmt;
