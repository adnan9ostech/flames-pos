-- Merchant phone on the bill, and how many copies a sale prints (10 Sep 2026).
-- NOT re-runnable (plain ADD COLUMNs, like 013/019/020); schema_migrations
-- stops a second application. The UPDATE below is guarded so re-reading the
-- file cannot overwrite a number the owner has since changed on Settings.
--
-- receipt_copies = 2 is the restaurant's standing practice: a CUSTOMER COPY
-- and a RESTAURANT COPY. Each copy is a complete bill ending in its own cut,
-- so the two come off the roll already separated — see renderReceipt.
ALTER TABLE store_settings
  ADD COLUMN merchant_phone VARCHAR(32) NOT NULL DEFAULT '',
  ADD COLUMN receipt_copies TINYINT NOT NULL DEFAULT 2;

-- The number the owner gave. Only fills a blank, never replaces an edit.
UPDATE store_settings
   SET merchant_phone = '0304 5666516'
 WHERE merchant_phone = '';
