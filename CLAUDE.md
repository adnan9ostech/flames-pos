# Flames by the Indus POS — session bootstrap

**Read `docs/STATUS.md` FIRST in every new session** — it is the living
status board (done / in-progress / pending) and names the current branch,
commands, and credentials locations. Keep it updated whenever work lands;
that file is how context survives session ends.

Hard rules for this codebase:

- Branch `mysql-migration`; push to `origin` = github.com/adnan9ostech/flames-pos.
- Error strings in `src/lib/db/orders.mjs` and money math in
  `src/lib/orderTotals.mjs` are cross-checked contracts (till string-matches;
  tests assert). Never reword or fork them.
- Server actions return `{data}|{error}` envelopes, never throw to the client.
- Keep `DB_NAME=flames_pos_test node --test 'tests/mysql/*.test.mjs'` green
  (17 tests incl. concurrency races) before any commit touching money paths.
- The deploy target is a shared cPanel box with ~150 tenant sites: nothing
  global, per-vhost only — `docs/deploy-cpanel.md` is the runbook.
- Never commit `.env*`; FBR token and SESSION_SECRET are server-env only.
- Deleting a `menu_items` row is never cleanup (order history FKs it).
