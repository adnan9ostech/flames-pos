-- A recipe for an ingredient (11 Sep 2026). NOT re-runnable.
--
-- A kitchen does not cook from raw ingredients alone. It makes a karahi masala
-- in a twenty-kilo batch, a ginger-garlic paste, a yakhni stock, and then
-- twenty dishes call for "80g of masala". Until now the only way to express
-- that was to copy the masala's fifteen spices into all twenty recipes — which
-- prices right once, and is wrong the day the recipe changes and nineteen of
-- them are not updated.
--
-- So an ingredient may have a recipe of its own, and it behaves as a PHANTOM:
-- it is never held as stock and never counted on a shelf. Selling a dish
-- consumes the raw spices its masala is made of, down through however many
-- layers, and the masala's cost is the sum of its parts.
--
-- Why phantom rather than a produced batch with its own stock: a produced
-- batch needs a production document, a yield, and somebody to post it every
-- morning — a whole new daily habit for a kitchen that does not yet have one.
-- Exploding on consumption needs no new habit at all and fixes both costing
-- and the shelf count today. A restaurant that later wants to count its
-- masala tubs can add production on top; nothing here forecloses it.
--
-- No depth column and no cycle constraint, because neither can be expressed
-- here: a masala that contains itself is caught by the expander, which walks
-- with a visited set and refuses to loop.
CREATE TABLE sub_recipe_lines (
    id                BIGINT        NOT NULL AUTO_INCREMENT,
    -- The ingredient being made.
    parent_item_id    BIGINT        NOT NULL,
    -- One thing that goes into it — itself possibly a sub-recipe.
    component_item_id BIGINT        NOT NULL,
    qty               DECIMAL(12,4) NOT NULL,
    created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_sub_recipe_line (parent_item_id, component_item_id),
    KEY idx_sub_recipe_component (component_item_id),
    CONSTRAINT fk_sub_parent FOREIGN KEY (parent_item_id) REFERENCES inventory_items (id) ON DELETE CASCADE,
    CONSTRAINT fk_sub_component FOREIGN KEY (component_item_id) REFERENCES inventory_items (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
