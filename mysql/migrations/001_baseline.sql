-- Flames POS baseline schema — MySQL 8.0 (requires >= 8.0.16 for enforced CHECKs).
--
-- This is the whole database: the cutover is a fresh start (orders begin at
-- zero; the menu is imported once from Sanity + Supabase). Ported from the
-- Supabase migrations 01–22 with the plpgsql RPC layer moved into
-- src/lib/db/orders.js; the housekeeping the old schema accumulated is fixed
-- here rather than carried over (duplicate indexes, the never-added 'partial'
-- payment status, the redundant customers phone index).
--
-- Conventions:
--   * InnoDB + utf8mb4 everywhere.
--   * UUID keys are CHAR(36), minted in Node (crypto.randomUUID()) — the verb
--     layer needs ids before INSERT and MySQL's UUID() is v1.
--   * Time is DATETIME(3) in UTC. The pool pins session time_zone = '+00:00';
--     code writes UTC_TIMESTAMP(3) explicitly. DATE columns are calendar days
--     in Asia/Karachi (business days), resolved in Node.
--   * Postgres JSONB and TEXT[] both become JSON.
--   * Statements are re-runnable (IF NOT EXISTS) because MySQL DDL commits
--     implicitly — a half-applied file must be safe to run again.

CREATE TABLE IF NOT EXISTS branches (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(191) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

INSERT INTO branches (id, name)
SELECT 1, 'Flames by the Indus'
WHERE NOT EXISTS (SELECT 1 FROM branches);

-- The trading day, opened and closed explicitly (ChowPOS pattern): a 1am
-- order belongs to tonight's service, not tomorrow's books. Rows are created
-- by day-close (Phase F); until that ships, orders fall back to the Karachi
-- calendar day and this table stays empty.
CREATE TABLE IF NOT EXISTS business_days (
  branch_id     INT NOT NULL,
  business_date DATE NOT NULL,
  opened_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at     DATETIME(3) NULL,
  closed_by     CHAR(36) NULL,
  PRIMARY KEY (branch_id, business_date),
  CONSTRAINT fk_business_days_branch FOREIGN KEY (branch_id) REFERENCES branches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS categories (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  name       VARCHAR(191) NOT NULL,
  icon       VARCHAR(64) NOT NULL DEFAULT 'Utensils',
  sort_order INT NOT NULL DEFAULT 0,
  sanity_id  VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX categories_sanity_id_idx (sanity_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS menu_items (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  category_id  CHAR(36) NULL,
  name         VARCHAR(191) NOT NULL,
  description  TEXT NULL,
  -- For a sized dish this is the LARGEST size (what the grid shows);
  -- Sanity's own price field is the smallest and never lands here directly.
  price        DECIMAL(10,2) NOT NULL,
  unit         VARCHAR(32) NULL,
  image        VARCHAR(255) NULL,           -- root-relative: /menu-images/…
  variants     JSON NOT NULL DEFAULT ('[]'),-- [{name, price}] ascending by price
  modifiers    JSON NOT NULL DEFAULT ('[]'),-- array of modifiers.key strings
  is_available TINYINT(1) NOT NULL DEFAULT 1,
  sanity_id    VARCHAR(64) NULL,            -- deliberately NOT unique: one
                                            -- Sanity dish can be two POS rows
                                            -- (Channay)
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX menu_items_category_idx (category_id),
  INDEX menu_items_sanity_id_idx (sanity_id),
  CONSTRAINT fk_menu_items_category FOREIGN KEY (category_id)
    REFERENCES categories (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- `key` is a MySQL reserved word; every statement touching it must backtick it.
CREATE TABLE IF NOT EXISTS modifiers (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  `key`      VARCHAR(64) NOT NULL,
  name       VARCHAR(191) NOT NULL,
  type       VARCHAR(16) NOT NULL DEFAULT 'select',
  options    JSON NOT NULL DEFAULT ('[]'),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY modifiers_key_uq (`key`),
  CONSTRAINT modifiers_type_chk CHECK (type IN ('select','multiselect'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS waiters (
  id         CHAR(36) NOT NULL PRIMARY KEY,
  name       VARCHAR(191) NOT NULL,
  code       VARCHAR(16) NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY waiters_code_uq (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS customers (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  name         VARCHAR(191) NOT NULL,
  phone        VARCHAR(32) NULL,
  email        VARCHAR(191) NULL,
  address      TEXT NULL,
  total_orders INT NOT NULL DEFAULT 0,
  total_spent  DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY customers_phone_uq (phone)
  -- No separate phone index: the unique constraint already is one.
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Singleton by convention (readers use LIMIT 1), as before.
CREATE TABLE IF NOT EXISTS store_settings (
  id            CHAR(36) NOT NULL PRIMARY KEY,
  merchant_name VARCHAR(191) NULL,
  merchant_city VARCHAR(191) NULL,
  raast_id      VARCHAR(64) NULL,
  jazzcash_id   VARCHAR(64) NULL,
  qr_enabled    TINYINT(1) NOT NULL DEFAULT 1,
  -- Tax is resolved AT SETTLE by payment method (ICT charges card and cash
  -- differently). Unsettled orders display at the cash rate. Both default to
  -- the historic 16% until the card rate is confirmed.
  tax_rate_cash DECIMAL(5,4) NOT NULL DEFAULT 0.1600,
  tax_rate_card DECIMAL(5,4) NOT NULL DEFAULT 0.1600,
  tax_label     VARCHAR(32) NOT NULL DEFAULT 'GST',
  auto_print    TINYINT(1) NOT NULL DEFAULT 1,
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Shared role accounts (admin / staff), PIN as credential. Roles are the
-- identity until P2 brings per-person staff. UNIQUE(role) = one row per role.
CREATE TABLE IF NOT EXISTS users (
  id          CHAR(36) NOT NULL PRIMARY KEY,
  role        VARCHAR(16) NOT NULL,
  pin_hash    VARCHAR(60) NOT NULL,
  pin_version INT NOT NULL DEFAULT 1,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY users_role_uq (role),
  CONSTRAINT users_role_chk CHECK (role IN ('admin','staff'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS orders (
  id                CHAR(36) NOT NULL PRIMARY KEY,
  -- Human-readable id; the client may supply one, otherwise a random 6-digit
  -- string. Deliberately NOT unique — collisions across months are harmless;
  -- invoice_number is the real identity.
  order_number      VARCHAR(32) NOT NULL,
  items             JSON NOT NULL,           -- display snapshot; order_items is canonical
  subtotal          DECIMAL(12,2) NOT NULL DEFAULT 0,
  tax               DECIMAL(12,2) NOT NULL DEFAULT 0,
  total             DECIMAL(12,2) NOT NULL DEFAULT 0,
  status            VARCHAR(16) NOT NULL DEFAULT 'new',
  customer_name     VARCHAR(191) NULL,
  customer_phone    VARCHAR(32) NULL,
  customer_address  TEXT NULL,
  order_type        VARCHAR(16) NOT NULL DEFAULT 'dine-in',
  table_number      VARCHAR(16) NULL,
  notes             TEXT NULL,
  waiter_id         CHAR(36) NULL,
  waiter_name       VARCHAR(191) NULL,       -- denormalised so receipts survive staff deletion
  payment_status    VARCHAR(16) NOT NULL DEFAULT 'unpaid',
  payment_mode      VARCHAR(16) NULL,
  paid_at           DATETIME(3) NULL,
  include_tax       TINYINT(1) NOT NULL DEFAULT 1,
  discount          DECIMAL(12,2) NOT NULL DEFAULT 0,  -- rupees, never a percentage
  discount_reason   VARCHAR(191) NULL,
  round_count       INT NOT NULL DEFAULT 1,
  last_round_at     DATETIME(3) NULL,
  cancelled_at      DATETIME(3) NULL,
  cancel_reason     TEXT NULL,
  cancelled_by      VARCHAR(191) NULL,
  invoice_number    VARCHAR(32) NULL,        -- minted once at settle, never re-minted
  fbr_invoice_number VARCHAR(40) NULL,       -- FBR DI number, backfilled by the worker
  client_request_id CHAR(36) NULL,
  branch_id         INT NOT NULL DEFAULT 1,
  business_date     DATE NOT NULL,           -- the trading day this order belongs to
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY orders_client_request_id_uq (client_request_id),
  INDEX orders_status_idx (status),
  INDEX orders_created_at_idx (created_at DESC),
  INDEX orders_unpaid_idx (payment_status, created_at DESC),
  INDEX orders_kitchen_idx (status, last_round_at),
  INDEX orders_order_number_idx (order_number),
  INDEX orders_customer_phone_idx (customer_phone),
  INDEX orders_updated_at_idx (updated_at),   -- the polling MAX() reads this
  INDEX orders_business_date_idx (business_date),
  CONSTRAINT fk_orders_branch FOREIGN KEY (branch_id) REFERENCES branches (id),
  CONSTRAINT fk_orders_waiter FOREIGN KEY (waiter_id) REFERENCES waiters (id) ON DELETE SET NULL,
  CONSTRAINT orders_status_chk CHECK (status IN ('new','preparing','ready','completed','cancelled')),
  CONSTRAINT orders_order_type_chk CHECK (order_type IN ('dine-in','takeaway','delivery')),
  CONSTRAINT orders_payment_status_chk CHECK (payment_status IN ('unpaid','paid','partial')),
  CONSTRAINT orders_payment_mode_chk CHECK (payment_mode IS NULL OR payment_mode IN ('cash','card','city_ledger'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_rounds (
  id                CHAR(36) NOT NULL PRIMARY KEY,
  order_id          CHAR(36) NOT NULL,
  branch_id         INT NOT NULL DEFAULT 1,
  round_no          INT NOT NULL,
  fired_at          DATETIME(3) NULL,
  client_request_id CHAR(36) NULL,
  UNIQUE KEY order_rounds_order_round_uq (order_id, round_no),
  UNIQUE KEY order_rounds_client_request_id_uq (client_request_id),
  CONSTRAINT fk_order_rounds_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_rounds_branch FOREIGN KEY (branch_id) REFERENCES branches (id),
  CONSTRAINT order_rounds_no_chk CHECK (round_no >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS order_items (
  id           CHAR(36) NOT NULL PRIMARY KEY,
  -- Postgres ordered same-timestamp lines by accident of heap order; seq
  -- makes "the order food was rung in" a real, deterministic thing.
  seq          BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
  order_id     CHAR(36) NOT NULL,
  round_id     CHAR(36) NULL,
  branch_id    INT NOT NULL DEFAULT 1,
  round_no     INT NOT NULL DEFAULT 1,
  menu_item_id CHAR(36) NULL,               -- the bill is the record, the FK a convenience
  name         VARCHAR(191) NOT NULL,
  variant      VARCHAR(64) NULL,
  modifiers    JSON NULL,
  unit_price   DECIMAL(10,2) NOT NULL,
  qty          INT NOT NULL,
  line_total   DECIMAL(12,2) GENERATED ALWAYS AS (unit_price * qty) STORED,
  notes        TEXT NULL,
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX order_items_order_idx (order_id),
  INDEX order_items_menu_item_idx (menu_item_id, created_at),
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_round FOREIGN KEY (round_id) REFERENCES order_rounds (id) ON DELETE SET NULL,
  CONSTRAINT fk_order_items_menu_item FOREIGN KEY (menu_item_id) REFERENCES menu_items (id) ON DELETE SET NULL,
  CONSTRAINT fk_order_items_branch FOREIGN KEY (branch_id) REFERENCES branches (id),
  CONSTRAINT order_items_price_chk CHECK (unit_price >= 0),
  CONSTRAINT order_items_qty_chk CHECK (qty > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS payments (
  id                CHAR(36) NOT NULL PRIMARY KEY,
  order_id          CHAR(36) NOT NULL,
  branch_id         INT NOT NULL DEFAULT 1,
  method            VARCHAR(16) NOT NULL,
  amount            DECIMAL(12,2) NOT NULL,  -- negative rows are void reversals
  paid_at           DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  client_request_id CHAR(36) NULL,
  UNIQUE KEY payments_client_request_id_uq (client_request_id),
  INDEX payments_order_idx (order_id),
  INDEX payments_paid_at_idx (paid_at),
  -- RESTRICT (the default): an order with money against it cannot vanish.
  CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fk_payments_branch FOREIGN KEY (branch_id) REFERENCES branches (id),
  CONSTRAINT payments_method_chk CHECK (method IN ('cash','card','city_ledger')),
  CONSTRAINT payments_amount_chk CHECK (amount <> 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- The sequential-invoice counter. Written only inside settle, under the
-- order's row lock; the ON DUPLICATE KEY upsert X-locks the counter row,
-- which is what serializes two same-moment settles.
CREATE TABLE IF NOT EXISTS invoice_counters (
  branch_id INT NOT NULL,
  day       DATE NOT NULL,                   -- the business day, not calendar UTC
  last_no   INT NOT NULL DEFAULT 0,
  PRIMARY KEY (branch_id, day),
  CONSTRAINT fk_invoice_counters_branch FOREIGN KEY (branch_id) REFERENCES branches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  at            DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  business_date DATE NULL,                  -- the trading day (ChowPOS: both clocks)
  branch_id     INT NOT NULL DEFAULT 1,
  action        VARCHAR(64) NOT NULL,
  order_id      CHAR(36) NULL,              -- deliberately no FK: log outlives data
  staff_id      CHAR(36) NULL,              -- NULL until P2 brings per-person identity
  details       JSON NULL,
  INDEX audit_log_order_idx (order_id),
  INDEX audit_log_at_idx (at DESC),
  CONSTRAINT fk_audit_log_branch FOREIGN KEY (branch_id) REFERENCES branches (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- FBR Digital Invoicing queue. A row is written after every settle commit;
-- the fiscalization POST happens outside the money transaction (an FBR outage
-- must never block taking payment). The fbr-worker retries pending/failed.
CREATE TABLE IF NOT EXISTS fbr_invoices (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id           CHAR(36) NOT NULL,
  usin               VARCHAR(32) NOT NULL,   -- our invoice_number
  payload            JSON NOT NULL,
  status             VARCHAR(16) NOT NULL DEFAULT 'pending',
  fbr_invoice_number VARCHAR(40) NULL,
  attempts           INT NOT NULL DEFAULT 0,
  last_error         TEXT NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at            DATETIME(3) NULL,
  UNIQUE KEY fbr_invoices_order_uq (order_id),
  INDEX fbr_invoices_status_idx (status, created_at),
  CONSTRAINT fk_fbr_invoices_order FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT fbr_invoices_status_chk CHECK (status IN ('pending','sent','failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
