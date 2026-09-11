-- Deals: a set of dishes sold together for one price (11 Sep 2026).
-- Re-runnable (CREATE TABLE IF NOT EXISTS), because the first attempt at this
-- file half-applied: DDL commits implicitly, so `deals` was created and then
-- `deal_lines` was rejected for a collation mismatch. The tables here carry
-- utf8mb4_0900_ai_ci to match menu_items — MySQL refuses a foreign key between
-- CHAR columns whose collations differ, and the rest of this schema is 0900.
--
-- HOW A DEAL REACHES A BILL, because this is the decision the whole feature
-- turns on. A deal does NOT become a mysterious single line priced at 3,995.
-- Tapping it puts its dishes into the cart at their ordinary menu prices and
-- puts the difference into the order's discount, reasoned "Deal: Family
-- Platter".
--
-- That choice buys three things at once, and the alternatives buy none of
-- them: the kitchen gets real tickets for real dishes; the stock room consumes
-- each dish's recipe exactly as if it had been sold on its own; and the money
-- math needs no new concept, because a discount is something calcTotals, the
-- reports and the FBR payload already understand. The customer also gets to
-- see what they saved, which is the point of ordering a deal.
--
-- What it costs: the saving lands in the same discount field a manual discount
-- uses, so two deals and a manual discount on one bill sum into one number
-- with a composed reason. That is visible and explainable, which is the test
-- that matters — and it is the honest shape until a bill needs per-line
-- discounts for their own sake.
CREATE TABLE IF NOT EXISTS deals (
    id          CHAR(36)      NOT NULL,
    name        VARCHAR(191)  NOT NULL,
    description VARCHAR(512)  NULL,
    -- What the set sells for. The saving is this against the sum of the
    -- components' menu prices, worked out live — so a deal does not quietly
    -- drift as the dishes in it are repriced.
    price       DECIMAL(10,2) NOT NULL,
    -- Empty means every order type; otherwise a JSON array, the same shape and
    -- the same meaning as `charges.order_types`.
    order_types JSON          NOT NULL,
    is_active   TINYINT(1)    NOT NULL DEFAULT 1,
    sort_order  INT           NOT NULL DEFAULT 0,
    created_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at  DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_deal_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS deal_lines (
    id           BIGINT      NOT NULL AUTO_INCREMENT,
    deal_id      CHAR(36)    NOT NULL,
    menu_item_id CHAR(36)    NOT NULL,
    -- Which size, where the dish has them. '' is the dish's base price, and
    -- matches how recipe_lines names the base recipe.
    variant_name VARCHAR(64) NOT NULL DEFAULT '',
    qty          INT         NOT NULL DEFAULT 1,
    PRIMARY KEY (id),
    KEY idx_deal_lines_deal (deal_id),
    CONSTRAINT fk_deal_lines_deal FOREIGN KEY (deal_id) REFERENCES deals (id) ON DELETE CASCADE,
    -- No ON DELETE on the dish: a menu_items row is never deleted here (order
    -- history points at it), so a deal cannot be orphaned by one vanishing.
    CONSTRAINT fk_deal_lines_item FOREIGN KEY (menu_item_id) REFERENCES menu_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
