-- Housekeeping: bring four new tables onto the schema's own collation
-- (11 Sep 2026). Re-runnable — CONVERT TO is idempotent.
--
-- This schema is utf8mb4_0900_ai_ci throughout. Four tables added today
-- (notifications, purchase_orders, purchase_order_lines, sub_recipe_lines)
-- were written with utf8mb4_unicode_ci out of habit. Nothing broke, because
-- every foreign key they carry is over BIGINT — MySQL only refuses a
-- cross-collation key between CHAR columns, which is exactly how it was
-- noticed, when `deals` tried to point at `menu_items`.
--
-- Left alone it is a trap rather than a bug: the first CHAR join or foreign key
-- anyone adds to one of these tables fails with a message that says nothing
-- about collation until you go looking. Cheaper to straighten now, while the
-- tables hold almost nothing.
ALTER TABLE notifications         CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE purchase_orders       CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE purchase_order_lines  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
ALTER TABLE sub_recipe_lines      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
