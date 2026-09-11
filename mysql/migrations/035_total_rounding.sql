-- Rounding the grand total (11 Sep 2026). NOT re-runnable.
--
-- A 16% GST on an odd subtotal lands on totals like 4,948.72, and the counter
-- then hunts for coins that barely circulate. Rounding the grand total to the
-- nearest rupee — or five — is ordinary practice here.
--
-- IT ALWAYS ROUNDS DOWN, and that is a decision rather than a shortcut. A
-- round-up charges the customer money the bill did not say they owed, which is
-- an overcharge however small; a round-down is a discount, which is a thing
-- this system already understands end to end. That one choice is what lets
-- rounding pass through the tax, the reports, the FBR payload and the ledger
-- without any of them learning a new idea: in the journal it joins Discounts
-- Allowed, and the entry balances exactly as it did before.
--
-- Computed LAST, after tax, so nothing is circular: the bill is worked out
-- exactly as it always was and then the tail is shaved off it.
--
-- 'off' by default. A restaurant that has not agreed to give away up to four
-- rupees a bill should not discover it on the day's takings.
ALTER TABLE orders
  ADD COLUMN rounding DECIMAL(12,2) NOT NULL DEFAULT 0.00;

-- 'off' | '1' (nearest rupee) | '5' (nearest five).
ALTER TABLE store_settings
  ADD COLUMN round_total VARCHAR(4) NOT NULL DEFAULT 'off';
