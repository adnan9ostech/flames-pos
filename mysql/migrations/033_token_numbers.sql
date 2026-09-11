-- Token numbers for counter orders (11 Sep 2026). NOT re-runnable.
--
-- A dine-in bill has a table to call it by. A takeaway has nothing: the
-- counter shouts "chicken karahi?" across a room and hopes. A token is the
-- small number the customer is given and the number the counter calls when the
-- food is up — short enough to shout, restarted every trading day so it never
-- becomes the six-digit order number nobody can hear.
--
-- Minted for takeaway and delivery only, and only where the customer waits:
-- a dine-in order already has a table, and printing a token on it would put two
-- different names for the same bill on the same slip.
--
-- OFF by default, and this matters more than it sounds: a restaurant that does
-- not call tokens but prints them has taught its customers a number nobody
-- will ever shout, which is worse than no number at all.
ALTER TABLE orders
  ADD COLUMN token_no INT NULL;

ALTER TABLE store_settings
  ADD COLUMN token_mode VARCHAR(8) NOT NULL DEFAULT 'off';

-- Its own counter, per branch per trading day — the same shape and the same
-- locking story as invoice_counters: the upsert X-locks the row until commit,
-- so two tills ringing at the same moment queue rather than both taking 12.
CREATE TABLE IF NOT EXISTS token_counters (
    branch_id INT  NOT NULL,
    day       DATE NOT NULL,
    last_no   INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (branch_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
