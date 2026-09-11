-- The Wastage account gets a link code (11 Sep 2026). Re-runnable.
--
-- Link codes are how the posting engine resolves an account by ROLE rather
-- than by number, and 5097 Wastage carried only IC_SERVICE_EXPENSE — an
-- income-statement grouping, not a role. Nothing could find it.
--
-- IT IS STILL NOT WHERE WASTE POSTS TODAY, and that is on purpose. 5097 is
-- switched off in this chart, and the resolver only ever returns an ACTIVE
-- account, so dish waste falls through to 5099 Inventory Variance and Wastage
-- — which is both active and, by its own name, the right drawer for it.
--
-- What this migration buys is the day somebody decides a dropped plate and a
-- short count are different conversations and switches 5097 back on: waste
-- moves there by itself, with no code change and no re-mapping. Until then it
-- is a label on a shelf nobody is using, which costs nothing.
UPDATE accounts
   SET link_codes = JSON_ARRAY_APPEND(link_codes, '$', 'WASTAGE'),
       updated_at = UTC_TIMESTAMP(3)
 WHERE account_number = '5097'
   AND NOT JSON_CONTAINS(link_codes, '"WASTAGE"');
