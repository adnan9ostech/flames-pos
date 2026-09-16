-- Which till took the cash (16 Sep 2026). Re-runnable.
--
-- A drawer's expected cash was the sum of EVERY cash payment the branch took
-- since that drawer opened, because a payment row said nothing about which
-- till it came through. On one till that is right by accident. On two — and
-- `cashier` and `frontdesk` both hold `pos` and `drawer`, so two is the normal
-- shape — both drawers claim the same notes: the first to count comes out
-- level and every other one reports a short it cannot explain, made of the
-- other till's takings.
--
-- NULLABLE on purpose, and NULL has a precise meaning: nobody had a drawer
-- open when this money moved. A card sale carries no cash, a city-ledger sale
-- carries none, and a cash sale rung with every drawer closed is real money
-- that belongs to no session — which the close now shows as its own line
-- rather than quietly folding into whichever drawer happened to be open.
--
-- Every existing row stays NULL. Closed sessions froze their expected figure
-- on the row at close, so their history is unaffected; only live sessions
-- compute, and they compute from now on.
ALTER TABLE payments
  ADD COLUMN drawer_session_id BIGINT NULL,
  ADD KEY idx_payments_drawer (drawer_session_id),
  ADD CONSTRAINT fk_payments_drawer FOREIGN KEY (drawer_session_id)
      REFERENCES drawer_sessions (id) ON DELETE SET NULL;
