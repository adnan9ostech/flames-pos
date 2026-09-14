-- The line under the logo, as data (14 Sep 2026). Re-runnable.
--
-- The customer-facing menu printed "Authentic Pakistani Cuisine" as literal
-- text in the component. On this deployment that is true. On a white-labelled
-- one it is a sentence about somebody else's food, on the one screen actual
-- customers read.
--
-- Blank is the default and the line disappears when it is blank — a restaurant
-- that has not written a tagline should show none, not a guess.
ALTER TABLE store_settings
  ADD COLUMN brand_tagline VARCHAR(96) NOT NULL DEFAULT '';

-- This deployment keeps the line it has been showing. Named, not blanket: the
-- same mistake 040 made, and 046 had to undo.
UPDATE store_settings
   SET brand_tagline = 'Authentic Pakistani Cuisine'
 WHERE brand_tagline = ''
   AND (brand_name = 'Flames by the Indus' OR merchant_name = 'Flames by the Indus');
