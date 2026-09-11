-- The notice board (11 Sep 2026). NOT re-runnable; schema_migrations stops a
-- second application.
--
-- What this is FOR, because "notifications" can mean almost anything: the
-- things a till already knows are wrong but currently tells nobody. A receipt
-- that did not print, a day left open overnight, an FBR invoice the queue gave
-- up on, a table sitting unpaid for hours, an ingredient under its reorder
-- level. Each of those is visible today only to whoever happened to be looking
-- at the right screen at the right second.
--
-- TWO KINDS OF ROW, and the difference is who clears them:
--
--   DERIVED   — recomputed from live data every time the bell is read
--               (low stock, a day still open, failed FBR rows, a stale tab).
--               The scanner raises them when the condition is true and RESOLVES
--               them when it stops being true, so the bell empties by itself.
--               Nobody has to tidy up after a problem that fixed itself.
--   RAISED    — an event that happened once and has no live condition to test
--               (a print that failed). Those are dismissed by hand, and the
--               scanner clears whatever is left of them at the end of the
--               business day so yesterday's paper jam is not still shouting.
--
-- dedupe_key is the whole idempotency story: "low_stock:17" is one notice
-- however many times the scanner runs, and re-raising it touches the row it
-- already has. ONE ROW PER KEY, FOR GOOD — a problem that clears and comes
-- back reopens the same row (and un-reads it, so it alerts again) rather than
-- leaving a pile behind. The keys carry a date where recurrence should mean a
-- NEW line ("print_failed:2026-09-11"), which is the honest way to say it.
--
-- The index is on dedupe_key ALONE, and that is load-bearing. A UNIQUE index
-- over (dedupe_key, resolved_at) looks like it keeps history, but NULL never
-- equals NULL in an index: every open row would be unique from every other
-- open row, ON DUPLICATE KEY would never fire, and each scan would insert a
-- fresh copy of the same notice. What the bell is for is what is wrong NOW;
-- what happened is audit_log's job, and it already does it.
CREATE TABLE notifications (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    branch_id     INT          NOT NULL DEFAULT 1,
    kind          VARCHAR(32)  NOT NULL,
    severity      VARCHAR(8)   NOT NULL DEFAULT 'info',
    title         VARCHAR(191) NOT NULL,
    body          VARCHAR(512) NULL,
    -- Where the fix lives. The bell is a list of links to the screen that can
    -- actually do something about each line, not a list of complaints.
    href          VARCHAR(191) NULL,
    -- The right a user needs to be shown this. A cashier has no business being
    -- told the FBR queue is failing, and a cook cannot act on it either.
    permission    VARCHAR(32)  NULL,
    dedupe_key    VARCHAR(191) NOT NULL,
    business_date DATE         NULL,
    seen_at       DATETIME(3)  NULL,
    resolved_at   DATETIME(3)  NULL,
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_notifications_key (dedupe_key),
    KEY idx_notifications_open (branch_id, resolved_at, severity, created_at),
    KEY idx_notifications_kind (kind, resolved_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
