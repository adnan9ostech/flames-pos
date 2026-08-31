-- The floor plan. Until now a table was whatever the cashier typed into a
-- text box, so "T7", "t7" and "7" were three different tables to every
-- report that grouped by it. Naming them once makes the till a picker and
-- the reports honest.
--
-- orders.table_number stays TEXT and keeps holding the NAME, not an id: a
-- bill has to survive a table being renamed or retired, exactly as
-- waiter_name is denormalised beside waiter_id.
CREATE TABLE IF NOT EXISTS dining_tables (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(16) NOT NULL,
  seats      INT NULL,
  area       VARCHAR(32) NULL,          -- Indoor, Terrace, Family Hall…
  sort_order INT NOT NULL DEFAULT 0,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY dining_tables_name_uq (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
