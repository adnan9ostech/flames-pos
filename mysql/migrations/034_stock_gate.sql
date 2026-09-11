-- Dishes the kitchen has run out of, on the till (11 Sep 2026). NOT re-runnable.
--
-- 'off'  — the till says nothing about stock. The default, and the only safe
--          default: this restaurant has not opened, its shelves hold nothing,
--          and a till that hid every dish whose ingredients read zero would
--          show an empty menu on day one.
-- 'flag' — the tile is marked and still tappable. A cashier can see the
--          kitchen is out and still ring it if the kitchen says otherwise,
--          which on a real service is most of the time.
-- 'hide' — the tile is gone. For a counter that trusts its counts.
--
-- THE RULE THAT MAKES THIS SAFE, and it is a rule about absence rather than
-- about zero: an ingredient with NO stock movements at all is not tracked, and
-- an untracked ingredient can never take a dish off the menu. Only something
-- that has been received, counted or consumed at least once can be run out of.
-- Without that, "we have not started counting flour" and "we are out of flour"
-- would be the same fact, and the second would win.
ALTER TABLE store_settings
  ADD COLUMN stock_gate VARCHAR(8) NOT NULL DEFAULT 'off';
