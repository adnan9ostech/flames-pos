-- Menu Management (3 Sep 2026). ALTERs only: MySQL 8 has no ADD COLUMN IF NOT
-- EXISTS, so this file is NOT re-runnable and shares a file with nothing that
-- is — the rule 007 and 008 follow.
--
-- menu_items.is_archived — a dish taken off the menu for good. Distinct from
--   is_available, the kitchen's "sold out today" switch: an archived dish
--   leaves the till and the customer menu entirely. It is never deleted,
--   because order_items.menu_item_id points at it and the bill history goes
--   with the row.
--
-- inventory_items.category — Blink groups its ingredients (Meat, Dairy,
--   Spices…) and the Ingredients screen groups and filters by the same. Free
--   text with a datalist; a table for six words would be ceremony.
--
-- recipe_lines.variant_name — a recipe per SIZE. A Full karahi does not use
--   the chicken a Half does, so costing both at one recipe misprices thirty
--   dishes. '' is the dish's base recipe; a sold line uses its size's lines
--   when the size has any, else the base. The UNIQUE key widens to match so a
--   size can carry its own quantity of an ingredient the base also lists. The
--   new key still leads on menu_item_id, so the FK keeps a usable index while
--   the old one is dropped in the same statement.
ALTER TABLE menu_items ADD COLUMN is_archived TINYINT(1) NOT NULL DEFAULT 0;

ALTER TABLE inventory_items ADD COLUMN category VARCHAR(64) NULL;

ALTER TABLE recipe_lines
  ADD COLUMN variant_name VARCHAR(64) NOT NULL DEFAULT '' AFTER menu_item_id,
  ADD UNIQUE KEY recipe_lines_variant_uq (menu_item_id, variant_name, inventory_item_id),
  DROP INDEX recipe_lines_uq;
