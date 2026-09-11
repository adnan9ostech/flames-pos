-- Where an order came from (11 Sep 2026). Re-runnable.
--
-- Today every bill is a walk-in, because a walk-in is all this restaurant
-- takes. The day it lists on Foodpanda that stops being true, and the
-- questions that follow are immediate: what share of tonight came through the
-- app, is the kitchen busier than the dining room says, and — the one that
-- costs money — does the aggregator's statement agree with our own count of
-- their orders.
--
-- None of that can be answered later from data nobody stamped at the time, so
-- the tag goes on now while it is cheap.
--
-- WHAT THIS DELIBERATELY DOES NOT DO: commission, and the receivable that
-- comes with it. A Foodpanda order is paid to Foodpanda, and the money arrives
-- days later minus their cut — which is a receivable, a settlement and a
-- deduction, i.e. exactly the shape the City Ledger already has for companies.
-- Doing it badly here would be worse than not doing it: a commission column
-- nobody posts is a number that lies on a report. This migration tags orders;
-- the money side is its own piece of work.
CREATE TABLE IF NOT EXISTS sales_channels (
    id         BIGINT      NOT NULL AUTO_INCREMENT,
    name       VARCHAR(64) NOT NULL,
    -- The one a new order starts on. Exactly one row should carry it; the
    -- till falls back to the lowest sort_order if none does.
    is_default TINYINT(1)  NOT NULL DEFAULT 0,
    is_active  TINYINT(1)  NOT NULL DEFAULT 1,
    sort_order INT         NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_channel_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Nullable, and that is the honest shape for every bill already in the table:
-- nobody asked where they came from, so nothing should claim they were
-- walk-ins. New orders stamp the default.
ALTER TABLE orders
  ADD COLUMN channel_id BIGINT NULL,
  ADD KEY idx_orders_channel (channel_id),
  ADD CONSTRAINT fk_orders_channel FOREIGN KEY (channel_id) REFERENCES sales_channels (id);

-- The only one that exists until somebody lists the restaurant somewhere.
INSERT INTO sales_channels (name, is_default, is_active, sort_order)
SELECT 'Walk-in', 1, 1, 0
WHERE NOT EXISTS (SELECT 1 FROM sales_channels WHERE name = 'Walk-in');
