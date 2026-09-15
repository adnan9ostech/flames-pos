-- Which outlet wrote this document (14 Sep 2026). Re-runnable.
--
-- Four document tables had no branch at all. That was not an oversight to the
-- same degree as the rest: orders, payments, the drawer and the day all carried
-- `branch_id` from the first schema, and these four were simply written later,
-- when there was visibly one outlet.
--
-- It stops being survivable now because the LEDGER is filed by branch. Every
-- journal these documents produce has to name an outlet, and with no branch on
-- the document there is no honest answer to give it — the posting engines were
-- answering `1` because a constant told them to, not because it was true.
--
--   company_receipts   a company settles its city-ledger bill, at a counter
--   supplier_payments  money leaves a till to pay a supplier
--   stock_receivings   goods arrive at an outlet's store
--   stock_docs         stock is adjusted or moved
--
-- Every one of those happens SOMEWHERE, and the somewhere is a branch.
--
-- DEFAULT 1 is not a guess here, it is the fact: every existing row was
-- recorded at the only outlet that has ever existed. The default stays on the
-- column so a writer that has not been taught to stamp it files under the
-- single outlet rather than failing — on a one-branch restaurant that is still
-- correct, and it means this migration cannot break a live till.
ALTER TABLE company_receipts
  ADD COLUMN branch_id INT NOT NULL DEFAULT 1,
  ADD KEY idx_company_receipts_branch (branch_id),
  ADD CONSTRAINT fk_company_receipts_branch FOREIGN KEY (branch_id) REFERENCES branches (id);

ALTER TABLE supplier_payments
  ADD COLUMN branch_id INT NOT NULL DEFAULT 1,
  ADD KEY idx_supplier_payments_branch (branch_id),
  ADD CONSTRAINT fk_supplier_payments_branch FOREIGN KEY (branch_id) REFERENCES branches (id);

ALTER TABLE stock_receivings
  ADD COLUMN branch_id INT NOT NULL DEFAULT 1,
  ADD KEY idx_stock_receivings_branch (branch_id),
  ADD CONSTRAINT fk_stock_receivings_branch FOREIGN KEY (branch_id) REFERENCES branches (id);

ALTER TABLE stock_docs
  ADD COLUMN branch_id INT NOT NULL DEFAULT 1,
  ADD KEY idx_stock_docs_branch (branch_id),
  ADD CONSTRAINT fk_stock_docs_branch FOREIGN KEY (branch_id) REFERENCES branches (id);
