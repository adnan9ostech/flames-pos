-- The two ALTERs the Accounts module needs, kept apart from 006: MySQL 8 has
-- no ADD COLUMN IF NOT EXISTS, so this file is NOT re-runnable and must not be
-- allowed to strand the chart of accounts if it half-applies.
--
-- expense_code_id  — an expense row keeps working with this NULL; the poster
--                    then falls back to the category link, then to
--                    gl_settings.default_expense_account_id.
-- voucher_line_id  — set on the `expenses` rows a posted voucher projects, so
--                    a projected row can be traced back to its paperwork and
--                    can never be edited or deleted from the /expenses screen
--                    independently of the document that created it.

ALTER TABLE expenses
  ADD COLUMN expense_code_id BIGINT NULL,
  ADD COLUMN voucher_line_id BIGINT NULL,
  ADD CONSTRAINT fk_expenses_code FOREIGN KEY (expense_code_id)
    REFERENCES expense_codes (id),
  ADD CONSTRAINT fk_expenses_voucher_line FOREIGN KEY (voucher_line_id)
    REFERENCES expense_voucher_lines (id);

-- One projected row per voucher line, enforced by the database rather than by
-- the poster remembering: re-posting a voucher can never double the drawer's
-- expected-cash figure.
CREATE UNIQUE INDEX expenses_voucher_line_uq ON expenses (voucher_line_id);

-- ChowPOS's Expense Category carries a code alongside its name; ours did not.
ALTER TABLE expense_categories
  ADD COLUMN code VARCHAR(16) NULL,
  ADD COLUMN gl_account_id BIGINT NULL,
  ADD CONSTRAINT fk_expense_categories_account FOREIGN KEY (gl_account_id)
    REFERENCES accounts (id);
