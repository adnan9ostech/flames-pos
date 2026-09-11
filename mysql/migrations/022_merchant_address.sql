-- The branch's street address, separate from the city (10 Sep 2026).
-- NOT re-runnable (a plain ADD COLUMN); schema_migrations stops a second pass.
--
-- WHY NOT JUST WIDEN merchant_city: that column is doing three jobs at once.
--   * the receipt header — wants the full "Gulberg Arena Mall, Islamabad"
--   * EMVCo tag 60, Merchant City, on the Raast QR — capped at 15 characters,
--     and emvco.js truncates silently, so a long value corrupts the QR
--   * FBR Digital Invoicing `destinationAddress` — wants an address
-- Putting the mall into merchant_city would have printed correctly and quietly
-- broken the QR. So the address gets its own column; merchant_city stays the
-- plain city ("Islamabad") that EMVCo and FBR want.
--
-- The receipt and the FBR payload prefer this when set and fall back to the
-- city when it is blank, so an install that never fills it behaves as before.
ALTER TABLE store_settings
  ADD COLUMN merchant_address VARCHAR(96) NOT NULL DEFAULT '';

-- Only fills a blank, never replaces an edit made on Settings.
UPDATE store_settings
   SET merchant_address = 'Gulberg Arena Mall, Islamabad'
 WHERE merchant_address = '';
