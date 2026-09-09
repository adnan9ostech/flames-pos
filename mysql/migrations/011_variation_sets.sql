-- Shared variation sets (3 Sep 2026). NOT re-runnable (the ALTERs); kept apart
-- from anything that is, per the rule 007/008/010 follow.
--
-- Blink and ChowPOS both model sizes as SHARED objects — "Half / Full" is one
-- thing linked to many dishes, not a string retyped on each — with the PRICE
-- staying per dish. Ours stayed per-dish JSON, and the 44 sized dishes already
-- show the cost of that: four distinct size vocabularies, and nothing stopping
-- a forty-fifth from being spelled "half" or "Full Plate".
--
-- The set owns the option NAMES and their order (smallest first, which is what
-- the till's modal defaults to). The dish still owns the prices, and
-- menu_items.variants stays the denormalised truth the till reads — so the POS,
-- the KDS and the customer menu need no change at all, and a dish may still
-- carry custom sizes with no set behind them.
CREATE TABLE IF NOT EXISTS variation_sets (
  id         BIGINT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(64) NOT NULL,
  -- ["Half","Full"] — ordered smallest to largest, the order a dish's prices
  -- must ascend in.
  options    JSON NOT NULL,
  is_active  TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY variation_sets_name_uq (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- variation_set_id — the set a dish's sizes come from; NULL means the dish
--   types its own (or has none). ON DELETE SET NULL is not offered: a set in
--   use cannot be deleted, only deactivated, so the link never dangles.
-- sort_order — where a dish sits on the till grid inside its category. Every
--   dish defaults to 0 and the name breaks the tie, which is exactly today's
--   ordering, so nothing moves until someone deliberately moves it.
ALTER TABLE menu_items
  ADD COLUMN variation_set_id BIGINT NULL,
  ADD COLUMN sort_order INT NOT NULL DEFAULT 0,
  ADD CONSTRAINT fk_menu_items_variation_set FOREIGN KEY (variation_set_id)
    REFERENCES variation_sets (id);

-- The four vocabularies the imported menu already speaks. Seeded rather than
-- derived: JSON_ARRAYAGG has no ordering guarantee, and a size list in the
-- wrong order would reprice a karahi.
INSERT INTO variation_sets (name, options)
SELECT * FROM (
            SELECT 'Half / Full'   AS name, CAST('["Half","Full"]' AS JSON)             AS options
  UNION ALL SELECT '8 / 16 pieces',         CAST('["8 pieces","16 pieces"]' AS JSON)
  UNION ALL SELECT '6 / 12 pieces',         CAST('["6 pieces","12 pieces"]' AS JSON)
  UNION ALL SELECT '2 / 4 pieces',          CAST('["2 pieces","4 pieces"]' AS JSON)
) seed
WHERE NOT EXISTS (SELECT 1 FROM variation_sets);

-- Link every dish whose sizes already match a set, position for position.
-- Every sized dish in the imported menu carries exactly two sizes; one that
-- matches no set keeps variation_set_id NULL and goes on working as custom.
UPDATE menu_items m
  JOIN variation_sets v
    ON JSON_LENGTH(v.options) = JSON_LENGTH(m.variants)
   AND JSON_EXTRACT(v.options, '$[0]') = JSON_EXTRACT(m.variants, '$[0].name')
   AND JSON_EXTRACT(v.options, '$[1]') = JSON_EXTRACT(m.variants, '$[1].name')
   SET m.variation_set_id = v.id
 WHERE JSON_LENGTH(m.variants) = 2 AND m.variation_set_id IS NULL;
