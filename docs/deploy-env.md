# Which environment variables to set on the box

**17 Sep 2026.** Derived by reading every `process.env` and `env.*` access in
`src/` and `scripts/`, not by copying `.env.local` — which still carries
Supabase, Sanity and printer keys that either belong elsewhere or are dead.

Where they go depends on the method (`docs/deploy-methods.md`):

- **Method 1 (SSH + PM2):** all of them in `~/apps/flames-pos/.env.production`,
  mode `600`, outside every docroot. `next start` loads it natively and the FBR
  worker loads it itself.
- **Method 2 (cPanel Node.js App):** the app's vars go in cPanel's own
  environment-variable UI. The FBR retry worker reads `.env.production`
  directly, so if you ever enable FBR you will need the file **as well**.

---

## Set these seven — the app does not work without them

```
DB_NAME=ostech_flamespos
DB_USER=ostech_flamespos
DB_PASSWORD=<the cPanel MySQL user's password>
DB_SOCKET=/var/lib/mysql/mysql.sock
SESSION_SECRET=<paste: openssl rand -hex 32>
NODE_ENV=production
UPLOAD_DIR=/home/ostech/apps/flames-pos-uploads
```

Why each one, and what happens if you skip it:

| Variable | If unset |
|---|---|
| `DB_NAME` | **No default.** The pool has no database and every page fails. |
| `DB_USER` | Defaults to `root` — wrong on cPanel, and the connection is refused. |
| `DB_PASSWORD` | Defaults to empty, so the connection is refused. |
| `DB_SOCKET` | The pool falls back to TCP on `127.0.0.1:3306`. cPanel's MySQL is reached over the socket; its presence is what switches modes. |
| `SESSION_SECRET` | Nobody can hold a login. Generate it **on the box** — the code checks only its *length*, so a guessable value passes silently. |
| `NODE_ENV` | Session cookies lose their `Secure` flag, because that flag is `NODE_ENV === 'production'` and nothing else. |
| `UPLOAD_DIR` | Defaults to `./uploads` **inside the checkout**, where the next `git pull` can clobber every menu photo. |

**`UPLOAD_DIR` must point outside the git tree** — that is the whole reason
the variable exists (`src/lib/menu/kit.mjs` says so). Note the path has no
slash inside `flames-pos`: it is a sibling of the checkout, not a child.

## Do not set these four

| Variable | Why not |
|---|---|
| `ALLOW_HTTP_COOKIES` | It exists for testing a production build over plain HTTP on the LAN. On the server it **turns off the `Secure` flag on login cookies**. Never set it there. |
| `DB_HOST`, `DB_PORT` | Ignored once `DB_SOCKET` is set. Leaving them in invites someone to "fix" the socket by deleting it. |
| `NEXT_PUBLIC_SITE_URL` | `docs/deploy-cpanel.md` Phase 3.3 lists it. **Nothing in the app reads it** — harmless, but it is not configuration. |

## Leave these out — they are not production variables

- **`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `AUTH_ADMIN_EMAIL`, `AUTH_STAFF_EMAIL`, `ADMIN_PIN`** — read only by
  `scripts/migrate-to-mysql/01-export-supabase.mjs`, the one-time import that
  has already run. `AUTH_STAFF_EMAIL` is read by nothing at all.
- **`NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET`** — read by
  `src/lib/sanityMenu.js`, which **nothing imports**. Dead since the menu
  import.
- **`PRINTER_QUEUE`, `PRINTER_DEVICE`, `PRINTER_ROLE`, `PRINT_AGENT_HOST`,
  `PRINT_AGENT_PORT`, `PRINT_WRITE_TIMEOUT_MS`** — these configure the print
  agent, which runs **on the till PC beside the printer**, not on the server.
  The server knows about printers from database rows set on the Printers
  screen. Putting them in cPanel does nothing.

## Pass these once at the command line, then forget them

Not stored anywhere — they are arguments to a one-time script:

```
SEED_ADMIN_PASSWORD='<choose one>' node scripts/db/seed-users.mjs
```

`SEED_ADMIN_USERNAME`, `SEED_ADMIN_EMAIL` and `SEED_ADMIN_FULL_NAME` are
optional overrides on that same command. The seeded admin is flagged to change
its password at first sign-in.

## Add these eight only when FBR registration completes

All eight are read, and all eight belong in `.env.production` — **never in the
database**:

```
FBR_ENABLED=true
FBR_MODE=sandbox          # production only after the sandbox test passes
FBR_BPOSID=<from FBR>
FBR_TOKEN=<from FBR>
FBR_SELLER_NTN=<business NTN>
FBR_SALE_TYPE=<from FBR>
FBR_HS_CODE=<from FBR>
FBR_UOM=<from FBR>
```

Until `FBR_ENABLED=true`, the retry worker exits immediately on startup and
nothing fiscal is attempted. The last three fill fields in the invoice payload
and default to empty strings if missing — which FBR will reject, so do not set
`FBR_ENABLED=true` before you have all eight.

## One consequence worth knowing

**The app has no live `NEXT_PUBLIC_*` variables.** Every one in `.env.local` is
either dead or migration-only. That matters because `deploy.sh` and the runbook
both justify building on the server by saying `NEXT_PUBLIC_*` values bake into
the client bundle. True in general, but there are none here — so building
locally and shipping the result is safe with no matching-values caveat at all.
On a box shared with ~150 tenants, where the build wants ~1 GB of RAM, that is
the easier path rather than a compromise.
