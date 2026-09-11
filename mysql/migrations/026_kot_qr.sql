-- A QR on the kitchen ticket (11 Sep 2026). NOT re-runnable.
--
-- What it is for: a runner or a manager holding a slip can scan it and pull
-- the order up on a phone instead of squinting at a number and typing it into
-- the Orders screen. It encodes the order number and nothing else — a URL
-- would break the moment the till's address changes, and a slip is not a
-- place to print one.
--
-- OFF by default, deliberately. It costs roughly a centimetre of roll on every
-- ticket, and it earns nothing at all until somebody is actually scanning
-- them. Blink ships it on; this ships it available.
ALTER TABLE store_settings
  ADD COLUMN kot_qr TINYINT(1) NOT NULL DEFAULT 0;
