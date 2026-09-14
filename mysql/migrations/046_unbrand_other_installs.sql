-- Take one restaurant's logo off another restaurant (14 Sep 2026). Re-runnable.
--
-- 040 filled any blank logo column with this restaurant's SVGs. On a
-- white-labelled install those columns are blank on day one, so the first
-- routine deploy — which re-runs migrations — silently branded somebody else's
-- till as Flames by the Indus. 040 is now guarded by name; this undoes what the
-- unguarded version did.
--
-- Matched on the PATH, not on emptiness: the point is to remove a specific
-- wrong value, and a restaurant that has deliberately uploaded its own logo
-- must not be blanked by a cleanup. An install that really is Flames keeps
-- both, because its name says so.
--
-- Blank is a safe landing place: every surface that draws a logo falls back to
-- drawing the brand name as text, which is a perfectly good wordmark.
UPDATE store_settings
   SET brand_logo_light = ''
 WHERE brand_logo_light = '/flames-by-the-indus-logo.svg'
   AND brand_name <> 'Flames by the Indus'
   AND merchant_name <> 'Flames by the Indus';

UPDATE store_settings
   SET brand_logo_dark = ''
 WHERE brand_logo_dark = '/flames-by-the-indus-logo-dark-ink.svg'
   AND brand_name <> 'Flames by the Indus'
   AND merchant_name <> 'Flames by the Indus';
