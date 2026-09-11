-- How this store's terminals print (10 Sep 2026). NOT re-runnable (a plain
-- ADD COLUMN, like 013/019); schema_migrations stops a second application.
--
-- 'agent'   — the local print agent writes raw ESC/POS to a thermal printer.
--             Browser printing is then NEVER used as a fallback: the counter
--             printer is a raw ESC/POS device, and a browser job reaches it as
--             PostScript, which it prints as source code. One such fallback
--             cost most of a roll on 10 Sep. A missing agent must therefore
--             fail loudly ("print agent not running"), not quietly.
-- 'browser' — window.print(), for an ordinary page printer or a driver that
--             genuinely rasterises. This was the old behaviour.
--
-- Defaults to 'agent' because that is what this restaurant's hardware is: a
-- POS80 USB thermal printer that only speaks ESC/POS.
ALTER TABLE store_settings
  ADD COLUMN print_transport VARCHAR(8) NOT NULL DEFAULT 'agent';
