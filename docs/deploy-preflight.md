# Deploy pre-flight — 16 Sep 2026

## Why this file exists

I was asked to deploy and could not. `pos.flamesbytheindus.com` returns
**NXDOMAIN** — the subdomain does not exist in DNS, so the first-time setup in
`deploy-cpanel.md` has never been run. (`flamesbytheindus.com` itself resolves
to 208.109.39.68, so the parent domain is live; only the POS host is missing.)
And there is no SSH access to the box from this machine: no keys, no
`~/.ssh/config` entry, no `known_hosts` record, and the runbook's own command
reads `ssh ostech@server` — a placeholder, never filled in.

So the deploy needs two things only Adnan has: the subdomain created, and shell
access to the box.

## What I verified instead, so the deploy is mechanical when access exists

Everything below was run and passed on this machine today.

- **All 52 migrations apply to a completely empty database**, producing 66
  tables and 52 recorded migrations. This is precisely what a first deploy does,
  and it is the step most likely to fail after a month of schema changes.
- **A fresh install boots and serves**: `/login` and `/api/health` both 200
  against that empty database, with one admin seeded and flagged to change its
  password.
- **The suite is 209/209** and the build is clean on Next 16.3.5.
- **`npm audit --omit=dev`: 0 vulnerabilities.**
- One bug this pre-flight found and fixed: a fresh install's PWA manifest read
  **"POS POS"**, because the brand falls back to 'POS' before anyone has set a
  name and the manifest appended another. Only visible on an install that has
  never been branded — which is every first deploy.

## The exact first-time sequence

Follow `docs/deploy-cpanel.md` Phase 0 onward. In short:

1. **Create the subdomain** `pos.flamesbytheindus.com` in cPanel and point it at
   the box. This is the blocker: nothing else can be tested until DNS answers.
2. **Confirm port 3017 is still free** — `ss -ltnp | grep 3017` must print
   nothing. ~150 tenants share the machine and it was last checked in August.
   If it is taken, change it in BOTH `ecosystem.config.js` and the Apache
   `nodeproxy.conf`, or Apache serves 503s.
3. **Clone to `/home/ostech/apps/flames-pos`** — outside every docroot.
4. **Write `/home/ostech/apps/flames-pos/.env.production`, mode 600:**

```
DB_NAME=ostech_flamespos
DB_USER=ostech_flamespos
DB_PASSWORD=<the cPanel MySQL user's password>
DB_SOCKET=/var/lib/mysql/mysql.sock
SESSION_SECRET=b3fc8de26de80d3c8d4636c6462062bae07a5e3483652c6237cb0fe0a9dd2a1d
NODE_ENV=production
UPLOAD_DIR=/home/ostech/apps/flames-pos/uploads
```

   That SESSION_SECRET was generated for this file and has never been used
   anywhere. **Do not reuse the development one** — the dev value is
   placeholder-shaped, and the code only checks its LENGTH, not its randomness.
   Two installs sharing a secret would make each other's session cookies valid.

   Leave the FBR keys out until the POS is registered. Add them to this file
   only — never the database:
   `FBR_ENABLED`, `FBR_MODE`, `FBR_BPOSID`, `FBR_TOKEN`, `FBR_SELLER_NTN`.

5. **`npm ci && npm run build`** on the server. The build must happen there:
   `NEXT_PUBLIC_*` values bake into the client bundle.
6. **`DB_NAME=… node scripts/db/migrate.mjs`** — schema before processes.
7. **`SEED_ADMIN_PASSWORD=… node scripts/db/seed-users.mjs`** — one admin,
   flagged to change it at first sign-in.
8. **`pm2 start ecosystem.config.js`**, then the Apache userdata include that
   proxies the subdomain to `127.0.0.1:3017`.
9. **Set the brand** at Settings → Brand, or the manifest and rail will read
   "POS" until somebody does.

After that, every update is one command: `~/apps/flames-pos/deploy.sh`.

## What to check the moment it answers

- `/api/health` returns `{"status":"healthy"}`
- sign in as the seeded admin; it must force a password change
- ring one real bill and settle it in cash, then confirm `/accounts/health`
  reports no unposted sale
- confirm the till's tax rate matches Settings → Tax
