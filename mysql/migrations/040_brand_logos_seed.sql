-- This deployment's own logos, as data (14 Sep 2026). Re-runnable.
--
-- The two SVGs were referenced by path from four components. Moving the paths
-- into the settings row changes nothing about how this restaurant looks and
-- everything about the next one: a new client uploads two files on the Brand
-- screen instead of someone editing components.
--
-- NAMED, not merely guarded on blankness. The first version of this file filled
-- any empty logo column, which is correct on exactly one install and wrong on
-- every other: a freshly provisioned restaurant has blank logos by definition,
-- and the next deploy.sh — which re-runs migrations — handed it Flames' SVGs.
-- Proven by provisioning a probe install and re-running the migrator: it came
-- back branded "Mandi House" carrying flames-by-the-indus-logo.svg.
--
-- So it fills a blank only where the brand IS this restaurant. Somebody else's
-- install never matches and is never touched. See 046, which cleans up any
-- install that already took the old version.
UPDATE store_settings
   SET brand_logo_light = '/flames-by-the-indus-logo.svg'
 WHERE brand_logo_light = ''
   AND (brand_name = 'Flames by the Indus' OR merchant_name = 'Flames by the Indus');

UPDATE store_settings
   SET brand_logo_dark = '/flames-by-the-indus-logo-dark-ink.svg'
 WHERE brand_logo_dark = ''
   AND (brand_name = 'Flames by the Indus' OR merchant_name = 'Flames by the Indus');
