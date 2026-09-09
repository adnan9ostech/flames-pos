-- The accountant's chart of accounts (3 Sep 2026). RE-RUNNABLE: every
-- statement is keyed on an account number and lands on the same result run
-- twice, so a half-applied file can simply be run again.
--
-- WHY THIS EXISTS. The chart seeded by 006 was ChowPOS's, in ChowPOS's
-- numbering: 1 asset, 2 liability, 3 INCOME, 4 EXPENSE, 5 equity. The
-- restaurant's accountant sent his own chart (Flames - Chart of Accounts 2.xlsx,
-- 82 lines) in the standard series every accounting package uses --
-- 1 asset, 2 liability, 3 EQUITY, 4 INCOME, 5+ EXPENSE -- and he is the one who
-- files the statutory accounts. Two charts is not a difference of opinion, it
-- is a reconciliation somebody does by hand every month forever, so the till
-- moves to his. GROUPS in src/lib/accounts/constants.mjs changed with it.
--
-- WHAT IS PRESERVED. Every account keeps its row id, so the 239 journal lines,
-- the 25 expense codes, the 10 gl_links and all nine gl_settings pointers stay
-- attached to the same account through the renumbering. Nothing is deleted:
-- the eight accounts the new chart has no place for are deactivated, and two of
-- them hand their expense codes over first.
--
-- WHAT DIFFERS FROM THE FILE HE SENT, and why -- all of it is written up in
-- docs/chart-of-accounts.md, which is the sheet to send back to him:
--   * His 8 parent accounts (Revenue, Cost of Sales, Labour Expenses, ...)
--     become CATEGORIES here, because this chart is flat. His structure is
--     preserved exactly; it is just held in a column instead of a parent link.
--   * 4090 Discounts sits in category CONTRA REVENUE, not REVENUE. The income
--     statement NEGATES that category (statements.mjs:147). Filed under REVENUE
--     a discount would be ADDED to sales -- the P&L would overstate revenue by
--     twice every discount given.
--   * 4095 Aggregator Commission is renumbered 5085. He typed it Cost of Goods
--     Sold but numbered it in the 4000 income block; the number has to follow
--     the type or it files itself under revenue.
--   * Nine accounts are added that the till cannot post without: they are
--     marked is_system = 1 below where they are, and listed in the doc.

-- ---------------------------------------------------------------- renumber
UPDATE accounts SET account_number = '1000', name = 'Cash in Hand (Till & Safe)', account_group = 'asset',
       category = 'CASH AND BANK', link_codes = '["AR_PAID", "AP_PAID"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '10100';
UPDATE accounts SET account_number = '1005', name = 'Petty Cash', account_group = 'asset',
       category = 'CASH AND BANK', link_codes = '["AP_PAID"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '10120';
UPDATE accounts SET account_number = '1010', name = 'Bank Accounts (Operating)', account_group = 'asset',
       category = 'CASH AND BANK', link_codes = '["AR_PAID", "AP_PAID"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '10200';
UPDATE accounts SET account_number = '1100', name = 'Card and Wallet Receivable (In Transit)', account_group = 'asset',
       category = 'OTHER CURRENT ASSETS', link_codes = '["AR_PAID"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '10210';
UPDATE accounts SET account_number = '1110', name = 'Aggregator Receivable', account_group = 'asset',
       category = 'OTHER CURRENT ASSETS', link_codes = '["AR"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '11200';
UPDATE accounts SET account_number = '1115', name = 'Accounts Receivable — City Ledger', account_group = 'asset',
       category = 'OTHER CURRENT ASSETS', link_codes = '["AR", "AR_PAID"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '11100';
UPDATE accounts SET account_number = '1120', name = 'Vendor Advances and Prepayments', account_group = 'asset',
       category = 'OTHER CURRENT ASSETS', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '10300';
UPDATE accounts SET account_number = '1130', name = 'Guest Ledger (Open Bills)', account_group = 'asset',
       category = 'OTHER CURRENT ASSETS', link_codes = '["AR"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '11000';
UPDATE accounts SET account_number = '1200', name = 'Inventory — Food', account_group = 'asset',
       category = 'INVENTORY', link_codes = '["INVENTORY"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '12000';
UPDATE accounts SET account_number = '1210', name = 'Inventory — Beverage', account_group = 'asset',
       category = 'INVENTORY', link_codes = '["INVENTORY"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '12010';
UPDATE accounts SET account_number = '1220', name = 'Inventory — Packaging & Disposables', account_group = 'asset',
       category = 'INVENTORY', link_codes = '["INVENTORY"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '12020';
UPDATE accounts SET account_number = '1510', name = 'Leasehold Improvements', account_group = 'asset',
       category = 'FIXED ASSETS', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '13020';
UPDATE accounts SET account_number = '1520', name = 'Kitchen Equipment', account_group = 'asset',
       category = 'FIXED ASSETS', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '13000';
UPDATE accounts SET account_number = '1530', name = 'Furniture and Fixtures', account_group = 'asset',
       category = 'FIXED ASSETS', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '13010';
UPDATE accounts SET account_number = '1540', name = 'POS & Computer Hardware', account_group = 'asset',
       category = 'FIXED ASSETS', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '13030';
UPDATE accounts SET account_number = '1590', name = 'Accumulated Depreciation', account_group = 'asset',
       category = 'FIXED ASSETS', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '13900';
UPDATE accounts SET account_number = '2000', name = 'Accounts Payable', account_group = 'liability',
       category = 'ACCOUNTS PAYABLE', link_codes = '["AP", "PAYABLE_NT"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '20000';
UPDATE accounts SET account_number = '2005', name = 'Accounts Payable — Sundry', account_group = 'liability',
       category = 'ACCOUNTS PAYABLE', link_codes = '["AP", "PAYABLE_NT"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '20100';
UPDATE accounts SET account_number = '2010', name = 'Accrued Expenses', account_group = 'liability',
       category = 'OTHER CURRENT LIABILITIES', link_codes = '["PAYABLE_NT"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '20200';
UPDATE accounts SET account_number = '2020', name = 'Salaries Payable', account_group = 'liability',
       category = 'OTHER CURRENT LIABILITIES', link_codes = '["PAYABLE_NT"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '21100';
UPDATE accounts SET account_number = '2030', name = 'Sales Tax Payable', account_group = 'liability',
       category = 'OTHER CURRENT LIABILITIES', link_codes = '["AR_TAX"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '21000';
UPDATE accounts SET account_number = '2040', name = 'Withholding Tax Payable', account_group = 'liability',
       category = 'OTHER CURRENT LIABILITIES', link_codes = '["AP_TAX"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '21010';
UPDATE accounts SET account_number = '2050', name = 'Advance from Customers (Event Deposits)', account_group = 'liability',
       category = 'OTHER CURRENT LIABILITIES', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '21200';
UPDATE accounts SET account_number = '2090', name = 'Suspense — Unmapped Postings', account_group = 'liability',
       category = 'OTHER CURRENT LIABILITIES', link_codes = '[]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '21900';
UPDATE accounts SET account_number = '3000', name = 'Director''s Current Account', account_group = 'equity',
       category = 'EQUITY', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '50000';
UPDATE accounts SET account_number = '3010', name = 'Director''s Drawings', account_group = 'equity',
       category = 'EQUITY', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '50010';
UPDATE accounts SET account_number = '3100', name = 'Retained Earnings', account_group = 'equity',
       category = 'EQUITY', link_codes = '[]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '50900';
UPDATE accounts SET account_number = '3900', name = 'Opening Balance Equity', account_group = 'equity',
       category = 'EQUITY', link_codes = '[]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '50910';
UPDATE accounts SET account_number = '4010', name = 'Food Revenue — Dine In', account_group = 'income',
       category = 'REVENUE', link_codes = '["IC_ITEM_INCOME"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '30000';
UPDATE accounts SET account_number = '4020', name = 'Food Revenue — Takeaway', account_group = 'income',
       category = 'REVENUE', link_codes = '["IC_ITEM_INCOME"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '30030';
UPDATE accounts SET account_number = '4050', name = 'Beverage Revenue', account_group = 'income',
       category = 'REVENUE', link_codes = '["IC_ITEM_INCOME"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '30010';
UPDATE accounts SET account_number = '4070', name = 'Service Charge Income', account_group = 'income',
       category = 'REVENUE', link_codes = '["IC_SERVICE_INCOME"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '31000';
UPDATE accounts SET account_number = '4075', name = 'Delivery Fee Income', account_group = 'income',
       category = 'REVENUE', link_codes = '["IC_SERVICE_INCOME"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '31010';
UPDATE accounts SET account_number = '4090', name = 'Discounts, Comps and Promotions', account_group = 'income',
       category = 'CONTRA REVENUE', link_codes = '[]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '32000';
UPDATE accounts SET account_number = '4900', name = 'Other Income', account_group = 'income',
       category = 'REVENUE', link_codes = '["IC_SERVICE_INCOME"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '31900';
UPDATE accounts SET account_number = '5000', name = 'Cost of Sales', account_group = 'expense',
       category = 'COST OF GOODS SOLD', link_codes = '["COGS", "IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '40000';
UPDATE accounts SET account_number = '5090', name = 'Packaging and Disposables', account_group = 'expense',
       category = 'COST OF GOODS SOLD', link_codes = '["COGS", "IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41230';
UPDATE accounts SET account_number = '5099', name = 'Inventory Variance and Wastage', account_group = 'expense',
       category = 'COST OF GOODS SOLD', link_codes = '["INV_GAIN", "IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '42020';
UPDATE accounts SET account_number = '6010', name = 'Kitchen Salaries and Wages', account_group = 'expense',
       category = 'LABOUR EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41000';
UPDATE accounts SET account_number = '6050', name = 'Staff Meals', account_group = 'expense',
       category = 'LABOUR EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41010';
UPDATE accounts SET account_number = '6070', name = 'Staff Welfare, Uniform and Training', account_group = 'expense',
       category = 'LABOUR EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41020';
UPDATE accounts SET account_number = '7010', name = 'Electricity', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41110';
UPDATE accounts SET account_number = '7020', name = 'Gas', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41120';
UPDATE accounts SET account_number = '7030', name = 'Water', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41130';
UPDATE accounts SET account_number = '7040', name = 'Internet and Telephone', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41140';
UPDATE accounts SET account_number = '7050', name = 'Cleaning and Sanitation', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41210';
UPDATE accounts SET account_number = '7080', name = 'Repairs and Maintenance — Kitchen Equipment', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41200';
UPDATE accounts SET account_number = '7090', name = 'Generator Fuel and Maintenance', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41400';
UPDATE accounts SET account_number = '7095', name = 'Smallwares and Breakage', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41220';
UPDATE accounts SET account_number = '7098', name = 'Delivery Rider Cost', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41410';
UPDATE accounts SET account_number = '7099', name = 'Cash Over and Short', account_group = 'expense',
       category = 'DIRECT OPERATING EXPENSES', link_codes = '[]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '42030';
UPDATE accounts SET account_number = '7510', name = 'Digital Ads', account_group = 'expense',
       category = 'SALES AND MARKETING', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41300';
UPDATE accounts SET account_number = '7530', name = 'Printing and Marketing Materials', account_group = 'expense',
       category = 'SALES AND MARKETING', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41310';
UPDATE accounts SET account_number = '8010', name = 'Rent', account_group = 'expense',
       category = 'OCCUPANCY AND ADMINISTRATION', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41100';
UPDATE accounts SET account_number = '8030', name = 'Licences and Permits', account_group = 'expense',
       category = 'OCCUPANCY AND ADMINISTRATION', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41600';
UPDATE accounts SET account_number = '8050', name = 'Professional and Audit Fees', account_group = 'expense',
       category = 'OCCUPANCY AND ADMINISTRATION', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41610';
UPDATE accounts SET account_number = '8060', name = 'Bank Charges', account_group = 'expense',
       category = 'OCCUPANCY AND ADMINISTRATION', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41500';
UPDATE accounts SET account_number = '8065', name = 'Card Processing Fees', account_group = 'expense',
       category = 'OCCUPANCY AND ADMINISTRATION', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41510';
UPDATE accounts SET account_number = '8090', name = 'Sundry Expenses', account_group = 'expense',
       category = 'OCCUPANCY AND ADMINISTRATION', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 1, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41900';
UPDATE accounts SET account_number = '9010', name = 'Depreciation', account_group = 'expense',
       category = 'NON-OPERATING EXPENSES', link_codes = '["IC_SERVICE_EXPENSE"]', is_system = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '41700';

-- --------------------------------------------------- hand the codes over first
-- WASTE and SPOIL pointed at two accounts the new chart folds into one. Moved
-- BEFORE their old accounts are deactivated, so no expense code is ever left
-- pointing at a dead account.
UPDATE expense_codes SET account_id = (SELECT id FROM accounts WHERE account_number = '5099')
 WHERE code IN ('WASTE', 'SPOIL');

-- --------------------------------------------------------------- deactivate
-- Renumbered as well as switched off. A retired account keeps its history and
-- its balance, so it still appears on a trial balance covering the days it was
-- posted to -- and a five-digit number in a four-digit chart would be the one
-- row on that report nobody could explain. The IN (old, new) is what keeps
-- these re-runnable.
-- Cash in Safe — merged into 1000 Cash in Hand (Till & Safe)
UPDATE accounts SET account_number = '1001', is_active = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number IN ('10110', '1001');
-- Advances to Staff — not in the accountant's chart
UPDATE accounts SET account_number = '1125', is_active = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number IN ('10310', '1125');
-- Security Deposits — not in the accountant's chart
UPDATE accounts SET account_number = '1126', is_active = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number IN ('10320', '1126');
-- Tips Payable — the till has no tips feature
UPDATE accounts SET account_number = '2060', is_active = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number IN ('21300', '2060');
-- Dessert Sale — the accountant's revenue splits by channel, not course
UPDATE accounts SET account_number = '4055', is_active = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number IN ('30020', '4055');
-- Cost of Goods Sold — Beverage — cost splits by ingredient, not by sale
UPDATE accounts SET account_number = '5001', is_active = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number IN ('40010', '5001');
-- Wastage — merged into 5099 Inventory Variance and Wastage
UPDATE accounts SET account_number = '5097', is_active = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number IN ('42000', '5097');
-- Spoilage & Expiry — merged into 5099 Inventory Variance and Wastage
UPDATE accounts SET account_number = '5098', is_active = 0, updated_at = UTC_TIMESTAMP(3)
 WHERE account_number IN ('42010', '5098');

-- ------------------------------------------------------------------- the rest
-- of the accountant's chart, plus the additions the till needs. ON DUPLICATE
-- KEY keeps this file re-runnable: a second run restates the row rather than
-- tripping accounts_number_uq.
INSERT INTO accounts (account_number, name, account_group, category, link_codes, is_system)
VALUES
  ('4030', 'Food Revenue — Delivery (own)', 'income', 'REVENUE', '["IC_ITEM_INCOME"]', 0),
  ('4040', 'Food Revenue — Aggregators (gross)', 'income', 'REVENUE', '["IC_ITEM_INCOME"]', 0),
  ('4060', 'Events, Catering and Private Bookings', 'income', 'REVENUE', '["IC_ITEM_INCOME", "IC_SERVICE_INCOME"]', 0),
  ('5010', 'Meat and Poultry', 'expense', 'COST OF GOODS SOLD', '["COGS", "IC_SERVICE_EXPENSE"]', 0),
  ('5020', 'Seafood', 'expense', 'COST OF GOODS SOLD', '["COGS", "IC_SERVICE_EXPENSE"]', 0),
  ('5030', 'Vegetables and Fruit', 'expense', 'COST OF GOODS SOLD', '["COGS", "IC_SERVICE_EXPENSE"]', 0),
  ('5040', 'Dairy and Eggs', 'expense', 'COST OF GOODS SOLD', '["COGS", "IC_SERVICE_EXPENSE"]', 0),
  ('5050', 'Dry Goods, Grains and Spices', 'expense', 'COST OF GOODS SOLD', '["COGS", "IC_SERVICE_EXPENSE"]', 0),
  ('5060', 'Oils and Ghee', 'expense', 'COST OF GOODS SOLD', '["COGS", "IC_SERVICE_EXPENSE"]', 0),
  ('5070', 'Bakery and Bread', 'expense', 'COST OF GOODS SOLD', '["COGS", "IC_SERVICE_EXPENSE"]', 0),
  ('5080', 'Beverages (non-alcoholic)', 'expense', 'COST OF GOODS SOLD', '["COGS", "IC_SERVICE_EXPENSE"]', 0),
  ('5085', 'Aggregator Commission', 'expense', 'COST OF GOODS SOLD', '["IC_SERVICE_EXPENSE"]', 0),
  ('5095', 'Kitchen Fuel and Charcoal', 'expense', 'COST OF GOODS SOLD', '["COGS", "IC_SERVICE_EXPENSE"]', 0),
  ('6020', 'Service Salaries and Wages', 'expense', 'LABOUR EXPENSES', '["IC_SERVICE_EXPENSE"]', 0),
  ('6030', 'Management Salaries', 'expense', 'LABOUR EXPENSES', '["IC_SERVICE_EXPENSE"]', 0),
  ('6040', 'Overtime', 'expense', 'LABOUR EXPENSES', '["IC_SERVICE_EXPENSE"]', 0),
  ('6060', 'EOBI and Statutory Contributions', 'expense', 'LABOUR EXPENSES', '["IC_SERVICE_EXPENSE"]', 0),
  ('7060', 'Pest Control', 'expense', 'DIRECT OPERATING EXPENSES', '["IC_SERVICE_EXPENSE"]', 0),
  ('7070', 'Laundry and Linen', 'expense', 'DIRECT OPERATING EXPENSES', '["IC_SERVICE_EXPENSE"]', 0),
  ('7085', 'Repairs and Maintenance — Building, HVAC and Ventilation', 'expense', 'DIRECT OPERATING EXPENSES', '["IC_SERVICE_EXPENSE"]', 0),
  ('7520', 'Influencer and PR', 'expense', 'SALES AND MARKETING', '["IC_SERVICE_EXPENSE"]', 0),
  ('7540', 'Photography and Content', 'expense', 'SALES AND MARKETING', '["IC_SERVICE_EXPENSE"]', 0),
  ('7550', 'Loyalty Program Cost', 'expense', 'SALES AND MARKETING', '["IC_SERVICE_EXPENSE"]', 0),
  ('8020', 'Common Area Maintenance (CAM)', 'expense', 'OCCUPANCY AND ADMINISTRATION', '["IC_SERVICE_EXPENSE"]', 0),
  ('8040', 'Insurance', 'expense', 'OCCUPANCY AND ADMINISTRATION', '["IC_SERVICE_EXPENSE"]', 0),
  ('8070', 'POS and Software Subscriptions', 'expense', 'OCCUPANCY AND ADMINISTRATION', '["IC_SERVICE_EXPENSE"]', 0),
  ('8080', 'Security Services', 'expense', 'OCCUPANCY AND ADMINISTRATION', '["IC_SERVICE_EXPENSE"]', 0),
  ('9020', 'Amortisation of Pre-Opening Cost and Leasehold', 'expense', 'NON-OPERATING EXPENSES', '["IC_SERVICE_EXPENSE"]', 0),
  ('9030', 'Finance Cost / Interest Expense', 'expense', 'NON-OPERATING EXPENSES', '["IC_SERVICE_EXPENSE"]', 0),
  ('9040', 'Income Tax Expense', 'expense', 'NON-OPERATING EXPENSES', '["IC_SERVICE_EXPENSE"]', 0)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), account_group = VALUES(account_group),
  category = VALUES(category), link_codes = VALUES(link_codes),
  is_system = VALUES(is_system), is_active = 1, updated_at = UTC_TIMESTAMP(3);

-- ----------------------------------------------------------------- afterwards
-- Nothing to repoint. gl_settings' nine pointers and all ten gl_links rows
-- reference accounts by id, and every id they name was renumbered in place
-- rather than replaced -- which is the whole reason this file updates instead
-- of rebuilding. Verify with:
--
--   SELECT COUNT(*) FROM accounts WHERE is_active = 1;                  -- 90
--   SELECT COUNT(*) FROM accounts WHERE account_number NOT REGEXP '^[0-9]{4}$';  -- 0
--   SELECT e.code FROM expense_codes e JOIN accounts a ON a.id = e.account_id
--    WHERE a.is_active = 0;                                             -- empty

