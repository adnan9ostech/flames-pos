-- More than one outlet (14 Sep 2026). Re-runnable.
--
-- Fifteen tables have carried `branch_id` since the first schema, all of them
-- writing the constant 1. That was the right call: the column costs nothing
-- and retrofitting one into orders, payments and the ledger later would have
-- been a migration nobody wants to run on live money. This turns that
-- groundwork on.
--
-- WHAT IS SHARED AND WHAT IS NOT, because the answer is not "everything":
--
--   per branch   orders, payments, the ledger, the day, the drawer, tables,
--                waiters, printers, stock. A branch counts its own cash and
--                its own shelf.
--   shared       the menu, categories, recipes, charges, discounts, companies,
--                customers, the chart of accounts. One company, one menu, one
--                customer book.
--
-- The menu is shared BUT NOT IDENTICAL, which is the owner's own requirement:
-- a dish may be off at one branch, and may cost more there. That is an
-- override per branch rather than a second menu — see branch_menu_items, which
-- holds only the differences, so a dish that is the same everywhere has no row
-- at all and cannot drift.
ALTER TABLE branches
  ADD COLUMN code       VARCHAR(16)  NOT NULL DEFAULT '',
  ADD COLUMN address    VARCHAR(191) NOT NULL DEFAULT '',
  ADD COLUMN phone      VARCHAR(32)  NOT NULL DEFAULT '',
  ADD COLUMN is_active  TINYINT(1)   NOT NULL DEFAULT 1,
  ADD COLUMN sort_order INT          NOT NULL DEFAULT 0;

-- Which branch a person works at. NULL means every branch, which is how an
-- owner and an accountant see the whole company.
ALTER TABLE users
  ADD COLUMN branch_id INT NULL,
  ADD KEY idx_users_branch (branch_id),
  ADD CONSTRAINT fk_users_branch FOREIGN KEY (branch_id) REFERENCES branches (id);

/*
 * Only the DIFFERENCES. No row means "exactly what the menu says", so a dish
 * priced once stays priced once and cannot drift out of step branch by branch.
 */
CREATE TABLE IF NOT EXISTS branch_menu_items (
    branch_id    INT           NOT NULL,
    menu_item_id CHAR(36)      NOT NULL,
    -- 0 takes the dish off this branch's till. It stays on every other.
    is_available TINYINT(1)    NOT NULL DEFAULT 1,
    -- NULL means the menu's own price. A number overrides it here only.
    price        DECIMAL(10,2) NULL,
    updated_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (branch_id, menu_item_id),
    KEY idx_bmi_item (menu_item_id),
    CONSTRAINT fk_bmi_branch FOREIGN KEY (branch_id) REFERENCES branches (id) ON DELETE CASCADE,
    CONSTRAINT fk_bmi_item FOREIGN KEY (menu_item_id) REFERENCES menu_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Printers belong to a branch: the same two roles exist at every outlet.
ALTER TABLE printers
  ADD COLUMN branch_id INT NOT NULL DEFAULT 1,
  DROP INDEX uq_printer_role,
  ADD UNIQUE KEY uq_printer_branch_role (branch_id, role);

-- The outlet that already exists gets a name it can be called by on a switcher.
UPDATE branches SET code = 'MAIN' WHERE id = 1 AND code = '';
