-- What was ordered from a supplier, before it arrives (11 Sep 2026).
-- NOT re-runnable.
--
-- The stock room already had both ends of this: a demand draft (the kitchen's
-- shopping list) and a receiving (goods in, costed, ledgered). Between them sat
-- the thing the supplier is actually held to — the order placed, at the price
-- agreed, for the date promised — and it existed only as a phone call.
--
-- That gap is what makes a short delivery unarguable-with. Without a PO the
-- only record of "twelve kilos at 1,180" is the delivery that turned up with
-- ten at 1,240, and the conversation is one person's memory against another's.
--
-- Kept deliberately thin: a header, its lines, and a status that moves one
-- way. No partial-receipt accounting, no three-way match. A restaurant with
-- one stock room orders, the goods come, the GRN closes it — and where they
-- come short, the GRN records what actually arrived while the PO keeps what
-- was promised, which is the whole point of having both.
CREATE TABLE purchase_orders (
    id           BIGINT       NOT NULL AUTO_INCREMENT,
    po_number    VARCHAR(24)  NOT NULL,
    supplier_id  BIGINT       NOT NULL,
    warehouse_id BIGINT       NOT NULL,
    -- 'open' — placed, waiting. 'received' — a GRN answered it.
    -- 'cancelled' — it never will be. One way out of open, and no way back:
    -- a PO that could be reopened is a PO whose history cannot be trusted.
    status       VARCHAR(12)  NOT NULL DEFAULT 'open',
    expected_on  DATE         NULL,
    notes        VARCHAR(191) NULL,
    total        DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    created_by   CHAR(36)     NULL,
    created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    closed_at    DATETIME(3)  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_po_number (po_number),
    KEY idx_po_supplier (supplier_id, status),
    CONSTRAINT fk_po_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id),
    CONSTRAINT fk_po_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE purchase_order_lines (
    id                BIGINT        NOT NULL AUTO_INCREMENT,
    purchase_order_id BIGINT        NOT NULL,
    inventory_item_id BIGINT        NOT NULL,
    qty               DECIMAL(12,3) NOT NULL,
    -- The price AGREED, which is the number worth keeping: the receiving
    -- stores what was actually charged, and the difference between the two is
    -- the conversation to have with the supplier.
    unit_cost         DECIMAL(12,4) NOT NULL,
    PRIMARY KEY (id),
    KEY idx_pol_po (purchase_order_id),
    CONSTRAINT fk_pol_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders (id) ON DELETE CASCADE,
    CONSTRAINT fk_pol_item FOREIGN KEY (inventory_item_id) REFERENCES inventory_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Which order this delivery answered, where it answered one. Nullable, because
-- a delivery that nobody raised a PO for is still a delivery and must still be
-- receivable — the stock room cannot stop because the paperwork did.
ALTER TABLE stock_receivings
  ADD COLUMN purchase_order_id BIGINT NULL,
  ADD KEY idx_receiving_po (purchase_order_id),
  ADD CONSTRAINT fk_receiving_po FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders (id);
