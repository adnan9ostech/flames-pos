-- Food that was made and then thrown away (11 Sep 2026). NOT re-runnable.
--
-- The stock room could already record waste at the INGREDIENT level: Misc
-- consumption, with a reason, takes five kilos of spoiled chicken off the
-- shelf. What it could not record is the thing that actually happens on a
-- service — a cook drops a plated karahi, a table sends a dish back, a
-- takeaway is never collected. Nobody in that moment knows the recipe; they
-- know the DISH.
--
-- So waste is recorded in dishes and exploded through the recipe (and through
-- sub-recipes) exactly as a sale is, because the food really was cooked and the
-- ingredients really did leave the shelf. It is NOT a sale and NOT a void: a
-- void un-rings something that was never made, and a sale takes money. Waste
-- is stock leaving with no money against it, which is precisely why the reason
-- is compulsory.
--
-- No approval flow and no PIN here, deliberately. Every row carries who posted
-- it and it goes to audit_log; the wrong lever to pull first is one that makes
-- a cook hide a dropped plate rather than record it.
CREATE TABLE IF NOT EXISTS waste_docs (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    branch_id     INT          NOT NULL DEFAULT 1,
    business_date DATE         NOT NULL,
    -- Compulsory, and this is the whole point of the document.
    reason        VARCHAR(191) NOT NULL,
    posted_by     CHAR(36)     NULL,
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_waste_day (branch_id, business_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS waste_lines (
    id           BIGINT        NOT NULL AUTO_INCREMENT,
    waste_doc_id BIGINT        NOT NULL,
    menu_item_id CHAR(36)      NOT NULL,
    -- Which size was wasted, matching how recipe_lines names a size ('' is
    -- the base recipe). A Full karahi is not half a Half one.
    variant_name VARCHAR(64)   NOT NULL DEFAULT '',
    qty          DECIMAL(12,3) NOT NULL,
    -- What the wasted food cost at the moment it was thrown away. Stored
    -- rather than recomputed: it is the loss that was actually taken, and a
    -- later change in ingredient prices must not rewrite it.
    cost         DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    PRIMARY KEY (id),
    KEY idx_waste_lines_doc (waste_doc_id),
    CONSTRAINT fk_waste_lines_doc FOREIGN KEY (waste_doc_id) REFERENCES waste_docs (id) ON DELETE CASCADE,
    CONSTRAINT fk_waste_lines_item FOREIGN KEY (menu_item_id) REFERENCES menu_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
