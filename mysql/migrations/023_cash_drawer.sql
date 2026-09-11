-- The cash drawer under the counter (11 Sep 2026). NOT re-runnable (plain
-- ADD COLUMNs, like 013/019/020/021); schema_migrations stops a second run.
--
-- A POS cash drawer is not a computer peripheral: it has no cable to the till.
-- It hangs off the PRINTER's RJ11 "DK" port, and the only thing that opens it
-- is a pulse the printer fires when it is told to (ESC p m t1 t2). So the
-- drawer belongs to whichever printer that terminal prints on, and a terminal
-- printing through the browser can never open one — there is no way to put a
-- control code into a rasterised page.
--
-- drawer_kick decides WHEN that pulse is sent:
--   'cash'   — only when money actually changed hands at the counter, i.e. the
--              sale's payment mode is cash. A card or city-ledger bill leaves
--              the drawer shut, which is the point of having one: the till
--              opens when there is cash to put in or change to take out, and
--              at no other moment. This is the default.
--   'always' — every completed sale, whatever the mode. Some counters keep one
--              drawer for everything and would rather it always opened.
--   'never'  — no drawer, or the restaurant opens it by hand.
--
-- drawer_pin is which pin of the RJ11 the pulse goes to. Nearly every drawer
-- sold is wired to pin 2; a few (Epson-style twin-drawer setups) use pin 5.
-- Wrong pin = a printer that clicks and a drawer that stays shut, so it is a
-- setting and not a constant.
ALTER TABLE store_settings
  ADD COLUMN drawer_kick VARCHAR(8) NOT NULL DEFAULT 'cash',
  ADD COLUMN drawer_pin TINYINT NOT NULL DEFAULT 2;
