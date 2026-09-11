-- What the customer handed over, and what went back (11 Sep 2026). NOT
-- re-runnable; schema_migrations stops a second application.
--
-- Until now a cash sale recorded the bill and nothing about the tender: a
-- Rs. 4,945 bill paid with a five-thousand note stored 4,945, and the sixty
-- rupees that went back across the counter existed only in the cashier's head.
-- That is the arithmetic a cashier gets wrong at eleven at night with a queue
-- waiting, and it is also the arithmetic a short drawer at day close cannot be
-- explained without.
--
-- So the till asks, and the server keeps both halves. change_due is stored
-- rather than recomputed on the fly because it is a statement about what
-- happened at the counter, not a formula: a later correction to the bill must
-- not silently rewrite how much change the customer was handed.
--
-- Both NULL, always, for anything that was not a cash tender — a card or
-- city-ledger bill has no change, and zero would be a claim rather than an
-- absence.
ALTER TABLE orders
  ADD COLUMN cash_received DECIMAL(12,2) NULL,
  ADD COLUMN change_due    DECIMAL(12,2) NULL;

-- Whether the till asks at all. On, because this restaurant is cash-first;
-- a counter that only ever takes exact card payments can turn it off and get
-- the old one-tap checkout back.
ALTER TABLE store_settings
  ADD COLUMN cash_change TINYINT(1) NOT NULL DEFAULT 1;
