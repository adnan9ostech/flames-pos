-- Accounts: a real double-entry general ledger, modelled on the ChowPOS
-- module mapped 1 Sep 2026. Their numbering (1 asset / 2 liability /
-- 3 income / 4 expense / 5 equity) and their link-code mechanism are kept;
-- their Bartlett's-specific accounts, their two category typos and their
-- numbering drift (10010 "Rounding" filed as Income) are not.
--
-- Two things here are load-bearing and easy to undo by accident:
--
--   * Journals are APPEND-ONLY and immutable once posted. A mistake is
--     corrected by a contra journal, never by an UPDATE or a DELETE — which
--     is why gl_journal_lines carries no updated_at and why an account that
--     has ever been posted to cannot be deleted (RESTRICT on the FK). Same
--     rule, same reason, as the menu_items rule in CLAUDE.md.
--   * A balance is SUM(debit) - SUM(credit) computed on read. There is no
--     cached balance column anywhere, so nothing can drift — the same
--     single-version-of-truth shape stock_ledger already uses for stock.
--
-- Sign convention is debit-positive throughout, matching ChowPOS's trial
-- balance: liabilities, income and equity carry credit (negative) balances.
--
-- Same conventions as 001/002: InnoDB/utf8mb4_0900_ai_ci, BIGINT
-- AUTO_INCREMENT for back-office documents, DATETIME(3) UTC, DATE for
-- Karachi business days, VARCHAR + a named <table>_<col>_chk instead of ENUM.

-- ==================== CHART OF ACCOUNTS ====================

-- `group` is a MySQL reserved word, hence account_group.
CREATE TABLE IF NOT EXISTS accounts (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  account_number VARCHAR(8) NOT NULL,
  name           VARCHAR(96) NOT NULL,
  account_group  VARCHAR(16) NOT NULL,
  category       VARCHAR(48) NOT NULL,
  -- ChowPOS's Link column: which system events may post to or select this
  -- account. A capability list, not a mapping — the mapping lives in
  -- gl_links. Vocabulary: AR, AR_PAID, AR_TAX, AP, AP_PAID, AP_TAX,
  -- PAYABLE_NT, PAYABLE_T, INVENTORY, INV_GAIN, COGS, IC_ITEM_INCOME,
  -- IC_SERVICE_INCOME, IC_SERVICE_EXPENSE.
  link_codes     JSON NOT NULL DEFAULT ('[]'),
  -- A system account is one the posting engine names in gl_settings or
  -- gl_links. It may be renamed and renumbered, never deactivated.
  is_system      TINYINT(1) NOT NULL DEFAULT 0,
  is_active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY accounts_number_uq (account_number),
  INDEX accounts_group_idx (account_group, account_number),
  CONSTRAINT accounts_group_chk CHECK (account_group IN
    ('asset','liability','income','expense','equity'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ==================== JOURNALS ====================

-- One balanced voucher. source_type/source_id name the business event that
-- produced it — the same two-column shape stock_ledger uses, and like
-- audit_log.order_id deliberately WITHOUT a foreign key: the ledger outlives
-- the document. The UNIQUE on that pair is the whole idempotency story: the
-- post-commit hook IS fired more than once per order (a replayed settle
-- returns the already-paid row and the guard in orderActions fires again),
-- so a double-post has to be structurally impossible, not merely unlikely.
CREATE TABLE IF NOT EXISTS gl_journals (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  branch_id     INT NOT NULL DEFAULT 1,
  business_date DATE NOT NULL,
  voucher_type  VARCHAR(4) NOT NULL,   -- SV sale, SM settlement, EV expense,
                                       -- RV receipt, PV payment, JV manual
  voucher_no    VARCHAR(32) NOT NULL,
  source_type   VARCHAR(24) NOT NULL,
  source_id     VARCHAR(64) NOT NULL,
  description   VARCHAR(191) NOT NULL,
  reference     VARCHAR(64) NULL,      -- invoice_number, cheque no, supplier invoice
  status        VARCHAR(8) NOT NULL DEFAULT 'posted',
  -- Stored so a Trial Balance never has to aggregate lines just to check the
  -- header, and so the CHECK below can enforce the one invariant the whole
  -- module rests on. MySQL 8 CHECK cannot hold a subquery or an aggregate,
  -- so line-vs-header agreement is asserted in the poster and by a test.
  debit_total   DECIMAL(12,2) NOT NULL DEFAULT 0,
  credit_total  DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_by    CHAR(36) NULL,         -- users.id; NULL for machine postings
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY gl_journals_source_uq (source_type, source_id),
  UNIQUE KEY gl_journals_voucher_uq (branch_id, voucher_no),
  INDEX gl_journals_business_date_idx (business_date),
  INDEX gl_journals_type_idx (voucher_type, business_date),
  CONSTRAINT fk_gl_journals_branch FOREIGN KEY (branch_id) REFERENCES branches (id),
  CONSTRAINT gl_journals_status_chk CHECK (status IN ('draft','posted','void')),
  CONSTRAINT gl_journals_type_chk CHECK (voucher_type IN
    ('SV','SM','EV','RV','PV','JV')),
  CONSTRAINT gl_journals_balance_chk CHECK (debit_total = credit_total)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Exactly one side per line, never both, never neither — which also means a
-- zero line is not writable, so the poster skips a zero discount rather than
-- emitting ChowPOS's "Cr Rounding 0". A reversal SWAPS debit and credit
-- rather than storing a negative, so this holds for contra journals too.
CREATE TABLE IF NOT EXISTS gl_journal_lines (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  journal_id BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  debit      DECIMAL(12,2) NOT NULL DEFAULT 0,
  credit     DECIMAL(12,2) NOT NULL DEFAULT 0,
  memo       VARCHAR(191) NULL,
  INDEX gl_journal_lines_account_idx (account_id, journal_id),
  INDEX gl_journal_lines_journal_idx (journal_id),
  CONSTRAINT fk_gl_journal_lines_journal FOREIGN KEY (journal_id)
    REFERENCES gl_journals (id) ON DELETE CASCADE,
  -- RESTRICT (the default): an account with postings against it can never
  -- vanish. Deactivate it instead.
  CONSTRAINT fk_gl_journal_lines_account FOREIGN KEY (account_id)
    REFERENCES accounts (id),
  CONSTRAINT gl_journal_lines_side_chk CHECK
    (debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Voucher numbers, minted exactly like invoice numbers: an upsert that
-- X-locks the counter row until commit is what serializes two same-moment
-- posters. Format <TYPE>-YYMMDD-NNNN.
CREATE TABLE IF NOT EXISTS gl_voucher_counters (
  branch_id    INT NOT NULL,
  day          DATE NOT NULL,
  voucher_type VARCHAR(4) NOT NULL,
  last_no      INT NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, day, voucher_type),
  CONSTRAINT fk_gl_voucher_counters_branch FOREIGN KEY (branch_id)
    REFERENCES branches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ==================== LINKS: business object -> account ====================

-- The concrete mapping the poster reads. One table rather than a nullable
-- gl_account_id on menu_items, charges, companies, suppliers and a literal
-- map in JS — which would have cost five ALTERs on live tables and made this
-- file un-re-runnable. ref_id is text because the things being mapped have
-- three different key types: CHAR(36) uuids (menu items, categories,
-- companies), BIGINT ids as text (charges, suppliers), and literals ('cash').
--
-- charge links are keyed by charge NAME, not id: the order's charges snapshot
-- (orderTotals.mjs:34-40) carries {name, amount, before_tax} and no id, and
-- widening it would fork calcTotals, which CLAUDE.md names as a contract.
CREATE TABLE IF NOT EXISTS gl_links (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  link_type  VARCHAR(24) NOT NULL,
  ref_id     VARCHAR(64) NOT NULL,
  account_id BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY gl_links_uq (link_type, ref_id),
  CONSTRAINT fk_gl_links_account FOREIGN KEY (account_id) REFERENCES accounts (id),
  CONSTRAINT gl_links_type_chk CHECK (link_type IN
    ('menu_item','menu_category','charge','payment_method','receipt_method',
     'expense_paid_from','company','supplier'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ==================== EXPENSE CODES ====================

-- ChowPOS's posting pivot: a voucher line picks a CODE and both sides of the
-- entry come from it. category_id points at the EXISTING expense_categories
-- table (002_features.sql:119) — a second category table would fork the
-- handover report's GROUP BY and orphan every row already there.
CREATE TABLE IF NOT EXISTS expense_codes (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  code               VARCHAR(16) NOT NULL,
  name               VARCHAR(96) NOT NULL,
  category_id        BIGINT NULL,
  account_id         BIGINT NOT NULL,   -- debited
  payable_account_id BIGINT NULL,       -- credited while status = 'payable'
  is_active          TINYINT(1) NOT NULL DEFAULT 1,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY expense_codes_code_uq (code),
  CONSTRAINT fk_expense_codes_category FOREIGN KEY (category_id)
    REFERENCES expense_categories (id),
  CONSTRAINT fk_expense_codes_account FOREIGN KEY (account_id) REFERENCES accounts (id),
  CONSTRAINT fk_expense_codes_payable FOREIGN KEY (payable_account_id)
    REFERENCES accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ==================== MODULE SETTINGS ====================

-- Singleton, holding the accounts the engine names by role rather than by
-- number, so renumbering the chart cannot break posting.
--
-- start_date is the go-live trading day: nothing before it posts. Sales only
-- begin auto-posting now, so retro-posting historical expenses would produce
-- a Trial Balance carrying months of expenses against no revenue. Pre-cutover
-- position comes in as one dated opening JV against 50910.
CREATE TABLE IF NOT EXISTS gl_settings (
  id                          TINYINT NOT NULL PRIMARY KEY,
  start_date                  DATE NOT NULL,
  posting_enabled             TINYINT(1) NOT NULL DEFAULT 1,
  guest_ledger_account_id     BIGINT NOT NULL,
  tax_payable_account_id      BIGINT NOT NULL,
  discount_account_id         BIGINT NOT NULL,
  default_revenue_account_id  BIGINT NOT NULL,
  default_charge_account_id   BIGINT NOT NULL,
  default_expense_account_id  BIGINT NOT NULL,
  cash_over_short_account_id  BIGINT NOT NULL,
  opening_equity_account_id   BIGINT NOT NULL,
  suspense_account_id         BIGINT NOT NULL,
  updated_at                  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT gl_settings_singleton_chk CHECK (id = 1),
  CONSTRAINT fk_gl_settings_guest   FOREIGN KEY (guest_ledger_account_id)    REFERENCES accounts (id),
  CONSTRAINT fk_gl_settings_tax     FOREIGN KEY (tax_payable_account_id)     REFERENCES accounts (id),
  CONSTRAINT fk_gl_settings_disc    FOREIGN KEY (discount_account_id)        REFERENCES accounts (id),
  CONSTRAINT fk_gl_settings_rev     FOREIGN KEY (default_revenue_account_id) REFERENCES accounts (id),
  CONSTRAINT fk_gl_settings_charge  FOREIGN KEY (default_charge_account_id)  REFERENCES accounts (id),
  CONSTRAINT fk_gl_settings_exp     FOREIGN KEY (default_expense_account_id) REFERENCES accounts (id),
  CONSTRAINT fk_gl_settings_cos     FOREIGN KEY (cash_over_short_account_id) REFERENCES accounts (id),
  CONSTRAINT fk_gl_settings_openeq  FOREIGN KEY (opening_equity_account_id)  REFERENCES accounts (id),
  CONSTRAINT fk_gl_settings_susp    FOREIGN KEY (suspense_account_id)        REFERENCES accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
INSERT INTO accounts (account_number, name, account_group, category, link_codes, is_system)
SELECT * FROM (
  -- ---------- 1xxxx ASSET ----------
  SELECT '10100','Cash in Drawer','asset','CURRENT ASSET','["AR_PAID","AP_PAID"]',1 UNION ALL
  SELECT '10110','Cash in Safe','asset','CURRENT ASSET','["AR_PAID","AP_PAID"]',0 UNION ALL
  SELECT '10120','Petty Cash','asset','CURRENT ASSET','["AP_PAID"]',0 UNION ALL
  SELECT '10200','Bank — Current Account','asset','CURRENT ASSET','["AR_PAID","AP_PAID"]',1 UNION ALL
  SELECT '10210','Card Settlement Clearing','asset','CURRENT ASSET','["AR_PAID"]',1 UNION ALL
  SELECT '10300','Prepaid Expenses','asset','CURRENT ASSET','[]',0 UNION ALL
  SELECT '10310','Advances to Staff','asset','CURRENT ASSET','[]',0 UNION ALL
  SELECT '10320','Security Deposits','asset','CURRENT ASSET','[]',0 UNION ALL
  SELECT '11000','Guest Ledger Control','asset','ACCOUNTS RECEIVABLE','["AR"]',1 UNION ALL
  SELECT '11100','Accounts Receivable — City Ledger','asset','ACCOUNTS RECEIVABLE','["AR","AR_PAID"]',1 UNION ALL
  SELECT '11200','Other Receivables','asset','ACCOUNTS RECEIVABLE','["AR"]',0 UNION ALL
  SELECT '12000','Inventory — Food','asset','INVENTORY / STOCK','["INVENTORY"]',0 UNION ALL
  SELECT '12010','Inventory — Beverage','asset','INVENTORY / STOCK','["INVENTORY"]',0 UNION ALL
  SELECT '12020','Inventory — Consumables & Packaging','asset','INVENTORY / STOCK','["INVENTORY"]',0 UNION ALL
  SELECT '13000','Kitchen Equipment','asset','FIXED ASSETS','[]',0 UNION ALL
  SELECT '13010','Furniture & Fixtures','asset','FIXED ASSETS','[]',0 UNION ALL
  SELECT '13020','Leasehold Improvements','asset','FIXED ASSETS','[]',0 UNION ALL
  SELECT '13030','Computers & POS Hardware','asset','FIXED ASSETS','[]',0 UNION ALL
  SELECT '13900','Accumulated Depreciation','asset','FIXED ASSETS','[]',0 UNION ALL
  -- ---------- 2xxxx LIABILITY ----------
  SELECT '20000','Accounts Payable — Suppliers','liability','ACCOUNTS PAYABLE','["AP","PAYABLE_NT"]',1 UNION ALL
  SELECT '20100','Accounts Payable — Sundry','liability','ACCOUNTS PAYABLE','["AP","PAYABLE_NT"]',1 UNION ALL
  SELECT '20200','Accrued Expenses','liability','ACCOUNTS PAYABLE','["PAYABLE_NT"]',0 UNION ALL
  SELECT '21000','GST Payable','liability','CURRENT LIABILITIES','["AR_TAX"]',1 UNION ALL
  SELECT '21010','Withholding Tax Payable','liability','CURRENT LIABILITIES','["AP_TAX"]',0 UNION ALL
  SELECT '21100','Salaries & Wages Payable','liability','CURRENT LIABILITIES','["PAYABLE_NT"]',0 UNION ALL
  SELECT '21200','Advance from Customers','liability','CURRENT LIABILITIES','[]',0 UNION ALL
  SELECT '21300','Tips Payable','liability','CURRENT LIABILITIES','["PAYABLE_NT"]',0 UNION ALL
  SELECT '21900','Suspense — Unmapped Postings','liability','CURRENT LIABILITIES','[]',1 UNION ALL
  -- ---------- 3xxxx INCOME ----------
  SELECT '30000','Restaurant Food Sale','income','FOOD & BEVERAGE DEPARTMENT SALE','["IC_ITEM_INCOME"]',1 UNION ALL
  SELECT '30010','Beverage Sale','income','FOOD & BEVERAGE DEPARTMENT SALE','["IC_ITEM_INCOME"]',0 UNION ALL
  SELECT '30020','Dessert Sale','income','FOOD & BEVERAGE DEPARTMENT SALE','["IC_ITEM_INCOME"]',0 UNION ALL
  SELECT '30030','Delivery & Takeaway Sale','income','FOOD & BEVERAGE DEPARTMENT SALE','["IC_ITEM_INCOME"]',0 UNION ALL
  SELECT '31000','Service Charge Income','income','SERVICE & OTHER INCOME','["IC_SERVICE_INCOME"]',1 UNION ALL
  SELECT '31010','Delivery Fee Income','income','SERVICE & OTHER INCOME','["IC_SERVICE_INCOME"]',0 UNION ALL
  SELECT '31900','Miscellaneous Income','income','SERVICE & OTHER INCOME','["IC_SERVICE_INCOME"]',0 UNION ALL
  SELECT '32000','Discounts Allowed','income','CONTRA REVENUE','[]',1 UNION ALL
  -- ---------- 4xxxx EXPENSE ----------
  SELECT '40000','Cost of Goods Sold — Food','expense','COST OF GOODS SOLD','["COGS"]',0 UNION ALL
  SELECT '40010','Cost of Goods Sold — Beverage','expense','COST OF GOODS SOLD','["COGS"]',0 UNION ALL
  SELECT '41000','Salaries & Wages','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41010','Staff Meals','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41020','Staff Welfare','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41100','Rent','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41110','Electricity','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41120','Gas','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41130','Water','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41140','Internet & Telephone','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41200','Repairs & Maintenance','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41210','Cleaning & Sanitation','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41220','Kitchen Consumables','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41230','Packaging & Disposables','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41300','Marketing & Promotion','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41310','Printing & Stationery','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41400','Transport & Fuel','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41410','Delivery Rider Cost','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41500','Bank Charges','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41510','Card Processing Fees','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41600','Licences & Government Fees','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41610','Professional Fees','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41700','Depreciation','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '41900','Miscellaneous Expense','expense','OPERATION AND GENERAL EXPENSES','["IC_SERVICE_EXPENSE"]',1 UNION ALL
  SELECT '42000','Wastage','expense','WASTAGE, LOSS & INVENTORY ADJUSTMENT','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '42010','Spoilage & Expiry','expense','WASTAGE, LOSS & INVENTORY ADJUSTMENT','["IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '42020','Inventory Adjustment','expense','WASTAGE, LOSS & INVENTORY ADJUSTMENT','["INV_GAIN","IC_SERVICE_EXPENSE"]',0 UNION ALL
  SELECT '42030','Cash Over and Short','expense','WASTAGE, LOSS & INVENTORY ADJUSTMENT','[]',1 UNION ALL
  -- ---------- 5xxxx EQUITY ----------
  SELECT '50000',"Owner's Capital",'equity',"OWNER'S EQUITY",'[]',0 UNION ALL
  SELECT '50010',"Owner's Drawings",'equity',"OWNER'S EQUITY",'[]',0 UNION ALL
  SELECT '50900','Retained Earnings','equity',"OWNER'S EQUITY",'[]',0 UNION ALL
  SELECT '50910','Opening Balance Equity','equity',"OWNER'S EQUITY",'[]',1
) seed
WHERE NOT EXISTS (SELECT 1 FROM accounts);

-- Links the poster reads. Payment methods are the till's three; receipt
-- methods are city ledger's four (note 'cheque', which payments.method does
-- not have); expense sources are expenses.paid_from's three.
INSERT INTO gl_links (link_type, ref_id, account_id)
SELECT s.link_type, s.ref_id, a.id
FROM (
  SELECT 'payment_method'    AS link_type, 'cash'        AS ref_id, '10100' AS acct UNION ALL
  SELECT 'payment_method','card','10210'        UNION ALL
  SELECT 'payment_method','city_ledger','11100' UNION ALL
  SELECT 'receipt_method','cash','10100'        UNION ALL
  SELECT 'receipt_method','card','10210'        UNION ALL
  SELECT 'receipt_method','bank','10200'        UNION ALL
  SELECT 'receipt_method','cheque','10200'      UNION ALL
  SELECT 'expense_paid_from','drawer','10100'   UNION ALL
  SELECT 'expense_paid_from','bank','10200'     UNION ALL
  SELECT 'expense_paid_from','other','21900'
) s
JOIN accounts a ON a.account_number = s.acct
WHERE NOT EXISTS (SELECT 1 FROM gl_links);

-- The singleton. start_date is today's Karachi calendar day: Karachi is a
-- fixed UTC+5 with no DST, so the shift is arithmetic — no CONVERT_TZ, which
-- needs the tz tables loaded on the shared host.
INSERT INTO gl_settings (
  id, start_date, posting_enabled,
  guest_ledger_account_id, tax_payable_account_id, discount_account_id,
  default_revenue_account_id, default_charge_account_id, default_expense_account_id,
  cash_over_short_account_id, opening_equity_account_id, suspense_account_id)
SELECT 1, DATE(UTC_TIMESTAMP() + INTERVAL 5 HOUR), 1,
  (SELECT id FROM accounts WHERE account_number = '11000'),
  (SELECT id FROM accounts WHERE account_number = '21000'),
  (SELECT id FROM accounts WHERE account_number = '32000'),
  (SELECT id FROM accounts WHERE account_number = '30000'),
  (SELECT id FROM accounts WHERE account_number = '31000'),
  (SELECT id FROM accounts WHERE account_number = '41900'),
  (SELECT id FROM accounts WHERE account_number = '42030'),
  (SELECT id FROM accounts WHERE account_number = '50910'),
  (SELECT id FROM accounts WHERE account_number = '21900')
WHERE NOT EXISTS (SELECT 1 FROM gl_settings);

-- One expense code per category the restaurant already uses, so the Expenses
-- screen has something to pick on day one. Codes mirror the account number.
INSERT INTO expense_codes (code, name, category_id, account_id, payable_account_id)
SELECT a.account_number, a.name, NULL, a.id,
       (SELECT id FROM accounts WHERE account_number = '20100')
FROM accounts a
WHERE a.account_group = 'expense'
  AND JSON_CONTAINS(a.link_codes, '"IC_SERVICE_EXPENSE"')
  AND NOT EXISTS (SELECT 1 FROM expense_codes);

-- ==================== EXPENSE VOUCHERS ====================
--
-- ChowPOS's Expense Voucher, which the owner asked for in full: a dated
-- document with many expense lines and many payment lines, DRAFT until it is
-- posted, and a Delete that only a draft may offer.
--
-- The load-bearing decision is that this table is the DOCUMENT and the
-- existing `expenses` table is its PROJECTION. Posting a voucher writes one
-- `expenses` row per line, carrying voucher_line_id back to its origin.
--
-- That is not tidiness. `expenses` is read directly by the drawer's
-- expected-cash figure (src/app/drawer/actions.js:104) and twice by the
-- handover report (src/app/reports/handover/actions.js:116,121). A voucher
-- store that sat beside `expenses` instead of feeding it would mean the money
-- a manager entered on a voucher never reached the cashier's drawer count —
-- two places both claiming to be today's spending, disagreeing silently. So
-- there is exactly one expense ledger, and the voucher is the paperwork above
-- it. Everything already reading `expenses` keeps working untouched.
--
-- A posted voucher is immutable, like a journal. Corrections are a reversing
-- voucher, never an edit, because its projection has already left the drawer
-- and its journal has already reached the ledger.

CREATE TABLE IF NOT EXISTS expense_vouchers (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  branch_id      INT NOT NULL DEFAULT 1,
  voucher_no     VARCHAR(32) NOT NULL,
  business_date  DATE NOT NULL,
  status         VARCHAR(8) NOT NULL DEFAULT 'draft',
  remarks        VARCHAR(191) NULL,
  -- Stored so a list screen never has to aggregate lines to show a total, and
  -- so "what is still owed" is one column rather than a join. paid_total is
  -- the sum of the payment lines; a voucher with payments below its total is
  -- the payable the Expense Payables Report is looking for.
  total          DECIMAL(12,2) NOT NULL DEFAULT 0,
  paid_total     DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_by     CHAR(36) NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  posted_at      DATETIME(3) NULL,
  posted_by      CHAR(36) NULL,
  UNIQUE KEY expense_vouchers_no_uq (branch_id, voucher_no),
  INDEX expense_vouchers_date_idx (business_date, status),
  INDEX expense_vouchers_status_idx (status),
  CONSTRAINT fk_expense_vouchers_branch FOREIGN KEY (branch_id) REFERENCES branches (id),
  CONSTRAINT expense_vouchers_status_chk CHECK (status IN ('draft','posted','void')),
  CONSTRAINT expense_vouchers_total_chk CHECK (total >= 0 AND paid_total >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One expense line: a code, what it was for, how much. The code carries the
-- account to debit and the payable account to credit, so a line needs neither.
CREATE TABLE IF NOT EXISTS expense_voucher_lines (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  voucher_id      BIGINT NOT NULL,
  expense_code_id BIGINT NOT NULL,
  description     VARCHAR(191) NULL,
  amount          DECIMAL(12,2) NOT NULL,
  INDEX expense_voucher_lines_voucher_idx (voucher_id),
  CONSTRAINT fk_evl_voucher FOREIGN KEY (voucher_id)
    REFERENCES expense_vouchers (id) ON DELETE CASCADE,
  CONSTRAINT fk_evl_code FOREIGN KEY (expense_code_id) REFERENCES expense_codes (id),
  CONSTRAINT expense_voucher_lines_amount_chk CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- How it was settled. A voucher with no payment lines is wholly a payable;
-- with some, it is part-paid; the difference is what the payables report owes.
-- account_id is the asset account the money left (drawer, bank) — filtered in
-- the UI to accounts carrying the AP_PAID link code, which is exactly what
-- ChowPOS's "Expense Payment Accounts" multi-select does.
CREATE TABLE IF NOT EXISTS expense_voucher_payments (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  voucher_id  BIGINT NOT NULL,
  account_id  BIGINT NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  paid_on     DATE NOT NULL,
  reference   VARCHAR(64) NULL,     -- cheque number, transfer ref
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX expense_voucher_payments_voucher_idx (voucher_id),
  CONSTRAINT fk_evp_voucher FOREIGN KEY (voucher_id)
    REFERENCES expense_vouchers (id) ON DELETE CASCADE,
  CONSTRAINT fk_evp_account FOREIGN KEY (account_id) REFERENCES accounts (id),
  CONSTRAINT expense_voucher_payments_amount_chk CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS expense_voucher_counters (
  branch_id INT NOT NULL,
  day       DATE NOT NULL,
  last_no   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, day),
  CONSTRAINT fk_evc_branch FOREIGN KEY (branch_id) REFERENCES branches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
