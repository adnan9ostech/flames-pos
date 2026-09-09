-- Paper width (3 Sep 2026). NOT re-runnable (an ALTER), kept apart from
-- anything that is, per the rule 007/008/010/011 follow.
--
-- The receipt was 80mm everywhere: the preview's own width, the print rule,
-- and the @page the printer is handed. That is right for a counter printer and
-- wrong for the 58mm pocket printers, which would either clip the right-hand
-- column or scale the whole bill down until the totals stopped being readable.
--
-- Millimetres rather than an enum: a printer is sold by its paper width, so
-- that is the number on the box and the number the owner will look for.
ALTER TABLE store_settings
  ADD COLUMN receipt_width_mm SMALLINT NOT NULL DEFAULT 80;
