-- A branch price has to name a size (16 Sep 2026). Re-runnable.
--
-- branch_menu_items had one price column and no size dimension, so a branch
-- price could only ever mean "the dish's base price" — and a SIZED dish never
-- charges its base price. The till's tile shows a range built from the sizes
-- (formatPriceRange) and the bill rings the chosen size, so neither the card
-- nor the bill ever consulted the override. It was a setting that silently
-- did nothing: an operator typed 9,895 on the Branch prices screen, the screen
-- accepted it, stored it, displayed it back — and both outlets went on
-- charging 8,995.
--
-- That is 44 of this menu's 137 dishes, and they are the expensive ones — the
-- karahis and the qormas, the dishes an outlet most wants to price differently.
-- The feature was shipped on 14 Sep and verified against the base price field
-- rather than against a variant-priced order, which is how it got through.
--
-- '' MEANS THE DISH'S OWN PRICE, and it is an empty string rather than NULL on
-- purpose: this column joins the PRIMARY KEY, which cannot hold NULL, and a
-- unique index treats two NULLs as distinct anyway — the same trap that made
-- the first notifications dedupe key useless (see migration 024).
--
-- Every existing row keeps its meaning: they were all base-price overrides,
-- and DEFAULT '' says exactly that.
SET @add := (
    SELECT IF(COUNT(*) = 0,
        'ALTER TABLE branch_menu_items ADD COLUMN variant_name VARCHAR(64) NOT NULL DEFAULT ''''',
        'SELECT 1')
      FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'branch_menu_items'
       AND column_name = 'variant_name'
);
PREPARE s FROM @add; EXECUTE s; DEALLOCATE PREPARE s;

-- The key becomes (branch, dish, size). Widened rather than replaced, so a
-- branch can hold a base override and a per-size override at once — which is
-- what a restaurant that reprices only its Full portions actually wants.
SET @pk := (
    SELECT IF(COUNT(*) = 2,
        'ALTER TABLE branch_menu_items DROP PRIMARY KEY, ADD PRIMARY KEY (branch_id, menu_item_id, variant_name)',
        'SELECT 1')
      FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'branch_menu_items'
       AND index_name = 'PRIMARY'
);
PREPARE s FROM @pk; EXECUTE s; DEALLOCATE PREPARE s;
