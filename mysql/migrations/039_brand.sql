-- The brand, as data (14 Sep 2026). Re-runnable.
--
-- The restaurant's name, its logo and its colour were written into the source:
-- fourteen files, four asset files and a stylesheet. Handing this POS to
-- another restaurant meant editing all of them, which is not a product, it is
-- a fork per customer.
--
-- The deployment model makes this the right shape: one vhost and one database
-- per restaurant (docs/deploy-cpanel.md), so a deployment IS a brand. There is
-- no tenant column here and there should not be; isolation comes from the
-- database being its own, which is stronger than any WHERE clause.
--
-- Only ONE colour is stored. The rest are worked out from it: the light theme
-- needs a darker version of the same hue to stay readable on a white card, and
-- the label on top has to be white or near-black depending on which of the two
-- the colour can carry. Asking an owner for four hexes and hoping they contrast
-- is how a white-labelled app ends up illegible.
ALTER TABLE store_settings
  ADD COLUMN brand_name       VARCHAR(96)  NOT NULL DEFAULT '',
  -- Shown on dark surfaces (the rail) and on light ones. Either may be blank,
  -- and then the name is drawn as text, which is a perfectly good wordmark.
  ADD COLUMN brand_logo_light VARCHAR(255) NOT NULL DEFAULT '',
  ADD COLUMN brand_logo_dark  VARCHAR(255) NOT NULL DEFAULT '',
  -- The one colour. Blank means the built-in flame orange.
  ADD COLUMN brand_colour     VARCHAR(9)   NOT NULL DEFAULT '';

-- This deployment is Flames by the Indus, and says so rather than relying on a
-- fallback buried in a component.
UPDATE store_settings
   SET brand_name = 'Flames by the Indus'
 WHERE brand_name = '';
