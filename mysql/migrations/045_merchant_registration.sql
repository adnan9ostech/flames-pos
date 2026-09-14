-- The company's tax registration, which had no home (14 Sep 2026). Re-runnable.
--
-- The on-screen receipt preview printed "NTN: 1234567-8 | STRN: 1234567890123"
-- as literal text in the component. Those are not this restaurant's numbers and
-- they are not anybody's — they were placeholder digits that reached a screen a
-- cashier shows a customer. There was no column to put the real ones in, which
-- is why they stayed.
--
-- Company level, because a National Tax Number belongs to the company, not to a
-- shop. A branch that registers its own POS separately overrides it through
-- branch_settings.fbr_ntn, which already exists for exactly that.
--
-- Blank is the honest default and the receipt omits the line entirely when it
-- is blank. A tax number is either right or absent; a made-up one on a bill is
-- worse than no line at all.
ALTER TABLE store_settings
  ADD COLUMN merchant_ntn  VARCHAR(32) NOT NULL DEFAULT '',
  ADD COLUMN merchant_strn VARCHAR(32) NOT NULL DEFAULT '';
