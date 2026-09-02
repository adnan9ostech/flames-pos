-- A starter set of expense categories and codes, mapped onto the seeded chart.
--
-- 006 seeded one expense code per IC_SERVICE_EXPENSE account with the ACCOUNT
-- NUMBER as its code ('41110' -> Electricity) and no category, so the picker
-- had something on day one. This file gives those rows the short codes a
-- person actually types on a voucher (ELEC, GAS, RENT ...) and files each
-- under a category, ChowPOS-style. It RENAMES a 006-shaped row rather than
-- adding a twin beside it: two codes pointing at one account would double
-- every entry in the voucher picker.
--
-- Re-runnable, and safe against an owner who has already edited the list:
--   * a category is inserted only if no category of that NAME exists;
--   * a 006 row is renamed only while its code still equals its account
--     number (an owner-renamed code is left alone) and only if the short
--     code is not already taken;
--   * a short code is inserted only if it does not exist;
--   * a category is filled in only where it is still NULL.
--
-- Account numbers appear here because this is seed SQL — the one place the
-- module allows them. Every id is resolved by number at run time.

DROP TEMPORARY TABLE IF EXISTS seed_expense_categories;
CREATE TEMPORARY TABLE seed_expense_categories (
  code VARCHAR(16) NOT NULL,
  name VARCHAR(64) NOT NULL,
  acct VARCHAR(8) NULL          -- default GL account for codes filed under it
);
INSERT INTO seed_expense_categories (code, name, acct) VALUES
  ('UTIL',  'Utilities',         '41110'),
  ('STAFF', 'Salaries & Staff',  '41000'),
  ('PREM',  'Rent & Premises',   '41100'),
  ('SUPP',  'Supplies',          '41220'),
  ('MKT',   'Marketing',         '41300'),
  ('FIN',   'Finance',           '41500'),
  ('STOCK', 'Stock Adjustments', '42020'),
  ('OTHER', 'Other',             '41900');

INSERT INTO expense_categories (name, code, gl_account_id)
SELECT s.name, s.code, a.id
FROM seed_expense_categories s
LEFT JOIN accounts a ON a.account_number = s.acct
WHERE NOT EXISTS (SELECT 1 FROM expense_categories c WHERE c.name = s.name);

-- A category that existed before 007 added the column gets its code and
-- default account filled in, once.
UPDATE expense_categories c
  JOIN seed_expense_categories s ON s.name = c.name
  LEFT JOIN accounts a ON a.account_number = s.acct
SET c.code = COALESCE(c.code, s.code),
    c.gl_account_id = COALESCE(c.gl_account_id, a.id)
WHERE c.code IS NULL OR c.gl_account_id IS NULL;

DROP TEMPORARY TABLE IF EXISTS seed_expense_codes;
CREATE TEMPORARY TABLE seed_expense_codes (
  code     VARCHAR(16) NOT NULL,
  name     VARCHAR(96) NOT NULL,
  category VARCHAR(64) NOT NULL,
  acct     VARCHAR(8) NOT NULL   -- the account the code debits
);
INSERT INTO seed_expense_codes (code, name, category, acct) VALUES
  ('ELEC',  'Electricity',                 'Utilities',         '41110'),
  ('GAS',   'Gas',                         'Utilities',         '41120'),
  ('WATER', 'Water',                       'Utilities',         '41130'),
  ('NET',   'Internet & Telephone',        'Utilities',         '41140'),
  ('SAL',   'Salaries & Wages',            'Salaries & Staff',  '41000'),
  ('MEALS', 'Staff Meals',                 'Salaries & Staff',  '41010'),
  ('WELF',  'Staff Welfare',               'Salaries & Staff',  '41020'),
  ('RIDER', 'Delivery Rider Cost',         'Salaries & Staff',  '41410'),
  ('RENT',  'Rent',                        'Rent & Premises',   '41100'),
  ('RM',    'Repairs & Maintenance',       'Rent & Premises',   '41200'),
  ('CLEAN', 'Cleaning & Sanitation',       'Rent & Premises',   '41210'),
  ('KIT',   'Kitchen Consumables',         'Supplies',          '41220'),
  ('PACK',  'Packaging & Disposables',     'Supplies',          '41230'),
  ('STAT',  'Printing & Stationery',       'Supplies',          '41310'),
  ('MKT',   'Marketing & Promotion',       'Marketing',         '41300'),
  ('BANK',  'Bank Charges',                'Finance',           '41500'),
  ('CARD',  'Card Processing Fees',        'Finance',           '41510'),
  ('WASTE', 'Wastage',                     'Stock Adjustments', '42000'),
  ('SPOIL', 'Spoilage & Expiry',           'Stock Adjustments', '42010'),
  ('ADJ',   'Inventory Adjustment',        'Stock Adjustments', '42020'),
  ('FUEL',  'Transport & Fuel',            'Other',             '41400'),
  ('LIC',   'Licences & Government Fees',  'Other',             '41600'),
  ('PROF',  'Professional Fees',           'Other',             '41610'),
  ('DEPR',  'Depreciation',                'Other',             '41700'),
  ('MISC',  'Miscellaneous Expense',       'Other',             '41900');

-- 1. Rename 006's number-coded rows to their short code. The self-join on
--    `dup` is what makes this re-runnable and collision-proof: a multi-table
--    UPDATE may join the target table to itself, where a subquery on it may
--    not.
UPDATE expense_codes ec
  JOIN accounts a ON a.id = ec.account_id
  JOIN seed_expense_codes s ON s.acct = a.account_number
  LEFT JOIN expense_codes dup ON dup.code = s.code
  LEFT JOIN expense_categories c ON c.name = s.category
SET ec.code = s.code,
    ec.category_id = COALESCE(ec.category_id, c.id),
    ec.updated_at = UTC_TIMESTAMP(3)
WHERE ec.code = a.account_number
  AND dup.id IS NULL;

-- 2. Insert whatever short code is still missing. Payable side for all of
--    them: Accounts Payable — Sundry.
INSERT INTO expense_codes (code, name, category_id, account_id, payable_account_id)
SELECT s.code, s.name, c.id, a.id, p.id
FROM seed_expense_codes s
JOIN accounts a ON a.account_number = s.acct
JOIN accounts p ON p.account_number = '20100'
LEFT JOIN expense_categories c ON c.name = s.category
WHERE NOT EXISTS (SELECT 1 FROM expense_codes e WHERE e.code = s.code);

-- 3. A short code that exists but was never filed gets its category, once.
UPDATE expense_codes ec
  JOIN seed_expense_codes s ON s.code = ec.code
  JOIN expense_categories c ON c.name = s.category
SET ec.category_id = c.id,
    ec.updated_at = UTC_TIMESTAMP(3)
WHERE ec.category_id IS NULL;

DROP TEMPORARY TABLE IF EXISTS seed_expense_codes;
DROP TEMPORARY TABLE IF EXISTS seed_expense_categories;
