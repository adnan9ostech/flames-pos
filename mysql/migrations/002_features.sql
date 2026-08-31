-- Phases F–J: day close, expenses & drawer, city ledger, charges & discount
-- plans, inventory. Modeled on the ChowPOS walkthrough (31 Aug 2026), sized
-- for one restaurant. Everything here is additive; the tables the money
-- verbs already write are only extended, never reshaped.
--
-- Same conventions as 001: InnoDB/utf8mb4, CHAR(36) ids minted in Node for
-- rows the till touches, AUTO_INCREMENT for back-office documents, DATETIME(3)
-- UTC, DATE columns are Karachi business days.

-- ==================== CHARGES (auto-applied fees) ====================

-- Service charge on dine-in, delivery fee on delivery. Applied automatically
-- at recompute by order type; a before-tax charge joins the taxable base, an
-- after-tax one rides on top of the taxed total.
CREATE TABLE IF NOT EXISTS charges (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(64) NOT NULL,
  value_type VARCHAR(8) NOT NULL DEFAULT 'percent',
  value      DECIMAL(10,2) NOT NULL,
  -- JSON array of order types this applies to, e.g. ["dine-in"]; empty = all.
  order_types JSON NOT NULL DEFAULT ('[]'),
  before_tax TINYINT(1) NOT NULL DEFAULT 1,
  auto_apply TINYINT(1) NOT NULL DEFAULT 1,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT charges_value_type_chk CHECK (value_type IN ('percent','fixed')),
  CONSTRAINT charges_value_chk CHECK (value >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- What recompute applied, snapshotted on the order like every other money
-- fact: [{name, amount, before_tax}]. charges_total is the sum, kept as a
-- column so reports never re-parse JSON.
ALTER TABLE orders
  ADD COLUMN charges JSON NOT NULL DEFAULT ('[]'),
  ADD COLUMN charges_total DECIMAL(12,2) NOT NULL DEFAULT 0;

-- ==================== DISCOUNT PLANS ====================

-- Scheduled, scoped discounts the till offers as one tap. The plan is the
-- input; what lands on the order is still the plain rupee `discount` the
-- money math already knows — a plan never re-prices a stored bill.
CREATE TABLE IF NOT EXISTS discount_plans (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(64) NOT NULL,
  value_type VARCHAR(8) NOT NULL DEFAULT 'percent',
  value      DECIMAL(10,2) NOT NULL,
  starts_on  DATE NULL,
  ends_on    DATE NULL,
  start_time TIME NULL,
  end_time   TIME NULL,
  -- ISO weekday numbers 1(Mon)–7(Sun); empty = every day.
  days       JSON NOT NULL DEFAULT ('[]'),
  -- 'order' discounts the bill; 'category'/'item' discount matching lines.
  scope      VARCHAR(16) NOT NULL DEFAULT 'order',
  category_ids JSON NOT NULL DEFAULT ('[]'),
  item_ids   JSON NOT NULL DEFAULT ('[]'),
  min_qty    INT NOT NULL DEFAULT 0,
  max_value  DECIMAL(12,2) NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT discount_plans_value_type_chk CHECK (value_type IN ('percent','fixed')),
  CONSTRAINT discount_plans_scope_chk CHECK (scope IN ('order','category','item'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ==================== CITY LEDGER ====================

CREATE TABLE IF NOT EXISTS companies (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  name       VARCHAR(191) NOT NULL,
  contact    VARCHAR(191) NULL,
  phone      VARCHAR(32) NULL,
  ntn        VARCHAR(16) NULL,
  address    TEXT NULL,
  credit_limit DECIMAL(12,2) NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A city-ledger settle writes a payments row exactly like cash/card — the
-- drawer math and void reversal stay uniform — but carries the company, and
-- later the invoice that billed it.
CREATE TABLE IF NOT EXISTS company_invoices (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  invoice_no VARCHAR(32) NOT NULL UNIQUE,
  company_id CHAR(36) NOT NULL,
  period_from DATE NOT NULL,
  period_to  DATE NOT NULL,
  total      DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_company_invoices_company FOREIGN KEY (company_id) REFERENCES companies (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS company_receipts (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  company_id CHAR(36) NOT NULL,
  invoice_id BIGINT NULL,
  amount     DECIMAL(12,2) NOT NULL,
  method     VARCHAR(16) NOT NULL DEFAULT 'bank',
  reference  VARCHAR(64) NULL,
  memo       VARCHAR(191) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_company_receipts_company FOREIGN KEY (company_id) REFERENCES companies (id),
  CONSTRAINT fk_company_receipts_invoice FOREIGN KEY (invoice_id) REFERENCES company_invoices (id),
  CONSTRAINT company_receipts_method_chk CHECK (method IN ('cash','card','bank','cheque')),
  CONSTRAINT company_receipts_amount_chk CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

ALTER TABLE payments
  ADD COLUMN company_id CHAR(36) NULL,
  ADD COLUMN invoice_id BIGINT NULL,
  ADD CONSTRAINT fk_payments_company FOREIGN KEY (company_id) REFERENCES companies (id),
  ADD CONSTRAINT fk_payments_invoice FOREIGN KEY (invoice_id) REFERENCES company_invoices (id);

-- ==================== EXPENSES ====================

CREATE TABLE IF NOT EXISTS expense_categories (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(64) NOT NULL UNIQUE,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A voucher is the paper trail for money leaving that is not a refund:
-- vegetables bought cash at the mandi, a generator repair, a payable to
-- clear later. 'drawer' expenses come out of that day's cash and show up in
-- the drawer session's expected balance.
CREATE TABLE IF NOT EXISTS expenses (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  business_date DATE NOT NULL,
  category_id   BIGINT NULL,
  description   VARCHAR(191) NOT NULL,
  payee         VARCHAR(191) NULL,
  amount        DECIMAL(12,2) NOT NULL,
  paid_from     VARCHAR(16) NOT NULL DEFAULT 'drawer',
  status        VARCHAR(16) NOT NULL DEFAULT 'paid',
  created_by    VARCHAR(16) NOT NULL DEFAULT 'admin',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at       DATETIME(3) NULL,
  INDEX expenses_business_date_idx (business_date),
  INDEX expenses_status_idx (status),
  CONSTRAINT fk_expenses_category FOREIGN KEY (category_id) REFERENCES expense_categories (id),
  CONSTRAINT expenses_amount_chk CHECK (amount > 0),
  CONSTRAINT expenses_paid_from_chk CHECK (paid_from IN ('drawer','bank','other')),
  CONSTRAINT expenses_status_chk CHECK (status IN ('paid','payable'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ==================== DRAWER SESSIONS ====================

-- One cashier's cash custody for one stretch of service: opening float in,
-- cash sales and paid-ins/outs through it, a counted amount at close, and
-- the variance that has to be explained the morning after.
CREATE TABLE IF NOT EXISTS drawer_sessions (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  branch_id     INT NOT NULL DEFAULT 1,
  business_date DATE NOT NULL,
  cashier_role  VARCHAR(16) NOT NULL,
  opening_float DECIMAL(12,2) NOT NULL DEFAULT 0,
  opened_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at     DATETIME(3) NULL,
  expected_amount DECIMAL(12,2) NULL,   -- computed at close, then frozen
  counted_amount  DECIMAL(12,2) NULL,
  variance        DECIMAL(12,2) NULL,
  notes         VARCHAR(191) NULL,
  INDEX drawer_sessions_date_idx (business_date),
  CONSTRAINT fk_drawer_sessions_branch FOREIGN KEY (branch_id) REFERENCES branches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS drawer_movements (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  session_id BIGINT NOT NULL,
  type       VARCHAR(8) NOT NULL,
  amount     DECIMAL(12,2) NOT NULL,
  reason     VARCHAR(191) NOT NULL,
  at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_drawer_movements_session FOREIGN KEY (session_id) REFERENCES drawer_sessions (id),
  CONSTRAINT drawer_movements_type_chk CHECK (type IN ('paid_in','paid_out')),
  CONSTRAINT drawer_movements_amount_chk CHECK (amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ==================== INVENTORY ====================

CREATE TABLE IF NOT EXISTS units (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(32) NOT NULL UNIQUE,   -- Kilogram, Litre, Piece
  abbrev     VARCHAR(8) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO units (name, abbrev)
SELECT * FROM (SELECT 'Kilogram','kg' UNION ALL SELECT 'Gram','g'
               UNION ALL SELECT 'Litre','L' UNION ALL SELECT 'Millilitre','ml'
               UNION ALL SELECT 'Piece','pc' UNION ALL SELECT 'Dozen','dz') seed
WHERE NOT EXISTS (SELECT 1 FROM units);

CREATE TABLE IF NOT EXISTS suppliers (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(191) NOT NULL,
  phone      VARCHAR(32) NULL,
  ntn        VARCHAR(16) NULL,
  address    TEXT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS warehouses (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(64) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO warehouses (name)
SELECT 'Main Store' WHERE NOT EXISTS (SELECT 1 FROM warehouses);

-- Stock items are ingredients, not dishes: chicken, oil, naan flour.
CREATE TABLE IF NOT EXISTS inventory_items (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(191) NOT NULL UNIQUE,
  unit_id       BIGINT NOT NULL,
  -- Moving-average cost per unit, updated at every receiving. What recipes
  -- and COGS price against.
  avg_cost      DECIMAL(12,4) NOT NULL DEFAULT 0,
  reorder_level DECIMAL(12,3) NOT NULL DEFAULT 0,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_inventory_items_unit FOREIGN KEY (unit_id) REFERENCES units (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- One recipe per dish (per variant later if ever needed): what one sold
-- portion consumes. Recipe cost = Σ qty × item avg_cost; that number feeds
-- gross-profit-per-item and the handover's COGS line.
CREATE TABLE IF NOT EXISTS recipes (
  menu_item_id CHAR(36) NOT NULL PRIMARY KEY,
  notes        VARCHAR(191) NULL,
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_recipes_menu_item FOREIGN KEY (menu_item_id) REFERENCES menu_items (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS recipe_lines (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  menu_item_id CHAR(36) NOT NULL,
  inventory_item_id BIGINT NOT NULL,
  qty          DECIMAL(12,4) NOT NULL,
  UNIQUE KEY recipe_lines_uq (menu_item_id, inventory_item_id),
  CONSTRAINT fk_recipe_lines_recipe FOREIGN KEY (menu_item_id) REFERENCES recipes (menu_item_id) ON DELETE CASCADE,
  CONSTRAINT fk_recipe_lines_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id),
  CONSTRAINT recipe_lines_qty_chk CHECK (qty > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Every stock movement lands here, append-only, signed. Current stock is
-- SUM(delta) per item per warehouse; every document below writes its lines
-- through this one ledger so there is exactly one version of the truth.
CREATE TABLE IF NOT EXISTS stock_ledger (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  inventory_item_id BIGINT NOT NULL,
  warehouse_id BIGINT NOT NULL,
  delta        DECIMAL(12,4) NOT NULL,
  unit_cost    DECIMAL(12,4) NULL,     -- set on receipts; null on consumption
  source_type  VARCHAR(24) NOT NULL,   -- receiving|transfer|adjustment|count|misc|sale|void
  source_id    VARCHAR(40) NOT NULL,
  business_date DATE NOT NULL,
  at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX stock_ledger_item_idx (inventory_item_id, warehouse_id),
  INDEX stock_ledger_date_idx (business_date),
  CONSTRAINT fk_stock_ledger_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id),
  CONSTRAINT fk_stock_ledger_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Purchase requisition: what the kitchen asks for, before money moves.
CREATE TABLE IF NOT EXISTS demand_drafts (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  status     VARCHAR(16) NOT NULL DEFAULT 'open',
  notes      VARCHAR(191) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT demand_drafts_status_chk CHECK (status IN ('open','fulfilled','cancelled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS demand_draft_lines (
  id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  draft_id BIGINT NOT NULL,
  inventory_item_id BIGINT NOT NULL,
  qty      DECIMAL(12,3) NOT NULL,
  CONSTRAINT fk_dd_lines_draft FOREIGN KEY (draft_id) REFERENCES demand_drafts (id) ON DELETE CASCADE,
  CONSTRAINT fk_dd_lines_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Goods received: the document that moves stock IN, sets the moving-average
-- cost, and creates the supplier payable.
CREATE TABLE IF NOT EXISTS stock_receivings (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  supplier_id  BIGINT NOT NULL,
  warehouse_id BIGINT NOT NULL,
  draft_id     BIGINT NULL,
  supplier_invoice VARCHAR(64) NULL,
  business_date DATE NOT NULL,
  total        DECIMAL(12,2) NOT NULL DEFAULT 0,
  notes        VARCHAR(191) NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_receivings_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
  CONSTRAINT fk_receivings_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_receivings_draft FOREIGN KEY (draft_id) REFERENCES demand_drafts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS stock_receiving_lines (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  receiving_id BIGINT NOT NULL,
  inventory_item_id BIGINT NOT NULL,
  qty          DECIMAL(12,3) NOT NULL,
  unit_cost    DECIMAL(12,4) NOT NULL,
  CONSTRAINT fk_recv_lines_recv FOREIGN KEY (receiving_id) REFERENCES stock_receivings (id) ON DELETE CASCADE,
  CONSTRAINT fk_recv_lines_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id),
  CONSTRAINT recv_lines_qty_chk CHECK (qty > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS supplier_payments (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  supplier_id BIGINT NOT NULL,
  amount      DECIMAL(12,2) NOT NULL,
  method      VARCHAR(16) NOT NULL DEFAULT 'cash',
  reference   VARCHAR(64) NULL,
  paid_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_supplier_payments_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
  CONSTRAINT supplier_payments_amount_chk CHECK (amount > 0),
  CONSTRAINT supplier_payments_method_chk CHECK (method IN ('cash','bank','cheque'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Transfers, adjustments, misc consumption, and counts share one header
-- shape; their lines all write stock_ledger rows.
CREATE TABLE IF NOT EXISTS stock_docs (
  id           BIGINT AUTO_INCREMENT PRIMARY KEY,
  doc_type     VARCHAR(16) NOT NULL,  -- transfer|adjustment|misc|count
  warehouse_id BIGINT NOT NULL,
  to_warehouse_id BIGINT NULL,        -- transfers only
  business_date DATE NOT NULL,
  reason       VARCHAR(191) NULL,
  posted       TINYINT(1) NOT NULL DEFAULT 1,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_stock_docs_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT fk_stock_docs_to_wh FOREIGN KEY (to_warehouse_id) REFERENCES warehouses (id),
  CONSTRAINT stock_docs_type_chk CHECK (doc_type IN ('transfer','adjustment','misc','count'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS stock_doc_lines (
  id       BIGINT AUTO_INCREMENT PRIMARY KEY,
  doc_id   BIGINT NOT NULL,
  inventory_item_id BIGINT NOT NULL,
  -- transfer/misc: qty moved/consumed. adjustment: signed delta.
  -- count: the counted quantity; the ledger row is counted − system.
  qty      DECIMAL(12,4) NOT NULL,
  CONSTRAINT fk_stock_doc_lines_doc FOREIGN KEY (doc_id) REFERENCES stock_docs (id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_doc_lines_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
