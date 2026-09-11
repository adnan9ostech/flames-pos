-- The card slip's number, against the sale (11 Sep 2026). NOT re-runnable.
--
-- At close, the card machine's batch total has to agree with what the POS says
-- was taken on card. When it does not — and it will not, sooner or later: a
-- declined retry rung twice, a refund put through the terminal and not the
-- till — the only way to find WHICH sale is to match slips to bills by amount
-- and time, by hand, for an evening's takings.
--
-- One short field ends that: the approval code or the last four digits off the
-- terminal's slip, stored against the payment. It lives on `payments` rather
-- than `orders` because it is a fact about the tender, not the bill — the same
-- order could one day be settled across two cards, and each has its own slip.
ALTER TABLE payments
  ADD COLUMN reference VARCHAR(32) NULL;

-- Whether the till insists. Off by default: a restaurant that has not agreed
-- the habit with its cashiers gets a box nobody fills and a checkout that
-- refuses to close, which is worse than no field at all.
ALTER TABLE store_settings
  ADD COLUMN card_ref_required TINYINT(1) NOT NULL DEFAULT 0;
