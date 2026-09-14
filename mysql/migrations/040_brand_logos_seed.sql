-- This deployment's own logos, as data (14 Sep 2026). Re-runnable.
--
-- The two SVGs were referenced by path from four components. Moving the paths
-- into the settings row changes nothing about how this restaurant looks and
-- everything about the next one: a new client uploads two files on the Brand
-- screen instead of someone editing components.
--
-- Guarded, so it only ever fills a blank. An owner who has uploaded their own
-- logo does not get this one back on a re-run.
UPDATE store_settings
   SET brand_logo_light = '/flames-by-the-indus-logo.svg'
 WHERE brand_logo_light = '';

UPDATE store_settings
   SET brand_logo_dark = '/flames-by-the-indus-logo-dark-ink.svg'
 WHERE brand_logo_dark = '';
