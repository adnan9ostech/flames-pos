-- Real people instead of two shared logins.
--
-- Until now `users` held exactly one row per role (admin, staff) and the
-- whole restaurant shared them, so nothing a person did could be attributed
-- to them. This gives every person an account with an email AND a username
-- (either one signs them in), a password, a role that grants a sensible set
-- of permissions, and optional per-user overrides on top.
--
-- Existing rows are kept and converted rather than replaced: the current
-- admin keeps working with the same credential through the cutover.

-- One row per role was the whole point before; it is exactly wrong now.
ALTER TABLE users DROP INDEX users_role_uq;

ALTER TABLE users
  ADD COLUMN email VARCHAR(191) NULL AFTER id,
  ADD COLUMN username VARCHAR(64) NULL AFTER email,
  ADD COLUMN full_name VARCHAR(191) NULL AFTER username,
  -- NULL means "whatever this role grants". An object overrides individual
  -- keys, so a cashier can be given reports without becoming a manager.
  ADD COLUMN permissions JSON NULL,
  ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN last_login_at DATETIME(3) NULL;

-- The credential is a password now, not a 6-digit PIN; same bcrypt column,
-- honest name. pin_version keeps its job (bump it and every other device's
-- cookie dies) under a name that says what it actually guards.
ALTER TABLE users
  CHANGE COLUMN pin_hash password_hash VARCHAR(60) NOT NULL,
  CHANGE COLUMN pin_version token_version INT NOT NULL DEFAULT 1;

-- Seed identities for the two shared accounts so nobody is locked out
-- mid-cutover: the admin signs in as "admin" with the password they already
-- use, and is asked to change it. The staff account is retired the moment
-- real people exist (the Users screen offers the delete).
UPDATE users SET username = role, full_name = CONCAT(UPPER(LEFT(role,1)), SUBSTRING(role,2)), must_change_password = 1
WHERE username IS NULL;

UPDATE users SET is_active = 0 WHERE role = 'staff';

ALTER TABLE users
  ADD UNIQUE KEY users_email_uq (email),
  ADD UNIQUE KEY users_username_uq (username);

-- The old two-value check has to go before any of the new roles can exist.
ALTER TABLE users DROP CHECK users_role_chk;
ALTER TABLE users
  ADD CONSTRAINT users_role_chk
  CHECK (role IN ('admin','manager','cashier','frontdesk','kitchen','accountant','staff'));
