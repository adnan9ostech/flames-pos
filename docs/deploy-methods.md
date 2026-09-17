# Three ways onto the box — pick by access, not by preference

**16 Sep 2026.** `docs/deploy-cpanel.md` is the full first-time runbook and
assumes root. This file exists because that assumption may not hold: it lays
out the three real routes onto the shared cPanel server, what each asks of
whoever runs it, and the two things that block all three today.

Read `docs/deploy-preflight.md` alongside this — it records what was verified
here so the deploy is mechanical once access exists.

## State of the code

| | |
|---|---|
| Repo | `c1e6375` on `origin/main`, tree clean |
| Tests | 212 / 212 |
| Build | clean, Next 16.3.5 |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Migrations | all 52 apply to an empty database → 66 tables |

## What blocks every method

1. **The subdomain does not exist.** `pos.flamesbytheindus.com` returns
   **NXDOMAIN**. The parent domain is live — `flamesbytheindus.com` resolves to
   `208.109.39.68` — so only the POS host is missing. Nothing can be tested,
   and AutoSSL cannot issue a certificate, until DNS answers.
2. **There is no shell access to the box** from this machine: no keys, no
   `~/.ssh/config` entry, no `known_hosts` record. The runbook's own command
   reads `ssh ostech@server` — a placeholder that was never filled in.
   **Method 2 is the one route that needs no SSH at all.**

## Which method fits your access

The choice turns on one question: **can you, or your host, get root on the
server?** Root is needed exactly twice in Method 1 — to confirm three Apache
modules are loaded, and to install the per-vhost proxy file. If the answer is
no, Method 2 is the way in. Method 3 is not a way to run the app; it is a way
to ship code to it.

| | 1 — SSH + PM2 + Apache | 2 — cPanel Node.js App | 3 — Git Version Control |
|---|---|---|---|
| Needs root | Twice, briefly | No | No |
| Needs SSH | Yes | No (cPanel UI or its Terminal) | No |
| Who writes the proxy | You, one vhost include | cPanel writes it | Neither — not its job |
| Runs the FBR retry worker | Yes, PM2 runs both processes | One process only; worker needs its own app | Neither |
| Survives a reboot | `pm2 startup` (root, once) | cPanel handles it | n/a |
| Code changes needed | None | A `server.js` the repo lacks | A `.cpanel.yml` the repo lacks |
| Verified here | Documented, dry-run against an empty database | No — untested on this box | No — untested on this box |
| **Verdict** | **Recommended** | Use if root is off the table | Optional, on top of 1 or 2 |

---

## Method 1 — SSH, PM2, and one Apache vhost include

*Recommended.* This is the path `docs/deploy-cpanel.md` documents in full and
the one whose every step has been dry-run here against an empty database. Its
governing rule: **nothing global changes**, because ~150 other sites share this
machine. Per-vhost or per-user only.

### Phase 0 — Recon, read-only, as root

Four facts to confirm before touching anything. The port check matters most:
3017 was picked from an inventory taken in August.

```
# must print NOTHING — if it prints, pick another port
ss -ltnp | grep 3017

# the proxy needs all three
httpd -M | grep -E 'proxy_module|proxy_http_module|headers_module'

# want ~1 GB free for the build; MySQL must be 8.0.16+
free -m
ls -l /var/lib/mysql/mysql.sock
mysql -V
```

If a module is missing, enable mod_proxy, mod_proxy_http and mod_headers
through **WHM → EasyApache 4**. This is the only global act in the whole
runbook, and it is safe because loading a module changes no site's behaviour
until a vhost references it.

### Phase 1 — Subdomain, then AutoSSL, in that order

Create `pos.flamesbytheindus.com` in cPanel and let AutoSSL issue the
certificate *before* the proxy exists. AutoSSL proves control by fetching a
file from the docroot; once the vhost forwards everything to Node, that check
has nowhere to land.

### Phase 2 — Database

In cPanel, create database and user `ostech_flamespos` with all privileges.
The connection is over the local socket, never TCP.

### Phase 3 — Node, app, PM2 — as `ostech`, never root

```
# Node 22, per-user via nvm — nothing global
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL && nvm install 22 && nvm alias default 22

# outside every docroot, so no misconfigured site can ever serve the source
git clone https://github.com/adnan9ostech/flames-pos.git ~/apps/flames-pos
cd ~/apps/flames-pos

# write .env.production (see below), then:
chmod 600 .env.production
npm ci && npm run build

# schema before processes, always
node scripts/db/migrate.mjs
SEED_ADMIN_PASSWORD='<choose one>' node scripts/db/seed-users.mjs

pm2 start ecosystem.config.js && pm2 save
```

### Phase 4 — Apache: a per-vhost include, never `.htaccess`

As root, create the proxy at
`/etc/apache2/conf.d/userdata/ssl/2_4/ostech/pos.flamesbytheindus.com/nodeproxy.conf`
(the full file is in `docs/deploy-cpanel.md`, Phase 4.1). Three lines in it are
load-bearing and worth understanding before pasting:

- **`ProxyPreserveHost On`** — Next's server actions compare the Origin header
  against Host. Without this, Apache sends `Host: 127.0.0.1:3017` and *every*
  action fails.
- **`RequestHeader set X-Forwarded-Proto https`** — the app only ever sees
  loopback HTTP; this is how it knows to keep cookies Secure and redirects on
  https.
- **Exclude `/.well-known/`** from the proxy, or future AutoSSL renewals fail
  silently.

Then a plain-HTTP vhost redirecting everything to https, and:

```
/scripts/ensure_vhost_includes --user=ostech
apachectl configtest && /scripts/restartsrv_httpd --graceful

# reboot survival, root, once
pm2 startup   # then run the line it prints, as ostech
```

**The port lives in exactly two places** — `ecosystem.config.js` and the two
`ProxyPass` lines in that include. Change them together or Apache serves 503s.

---

## Method 2 — cPanel's "Setup Node.js App"

*No root needed. Untested on this box.*

If root is not available to you, this is the way in. cPanel's Node.js selector
runs the app under Passenger and **writes the reverse proxy and the
boot/restart handling for you** — precisely the part of Method 1 that needs
root. You point it at an app folder, a Node version and a startup file:

- **Application root:** `apps/flames-pos`
- **Application URL:** the `pos` subdomain
- **Node version:** 22
- **Startup file:** `server.js`

Phases 1, 2 and the environment file below are still needed; only Phase 4 and
PM2 fall away.

### What it costs — three honest caveats

- **The repo has no `server.js`.** Passenger insists on controlling the
  listening socket, so `next start` cannot be the entry point — it needs a
  small custom server instead. That file does not exist yet; it needs writing
  and testing before this method is real.
- **Passenger runs one process.** PM2 runs two: the app and the FBR retry
  worker. Under Passenger the worker needs its own Node app or a cron entry.
- **Environment variables come from the cPanel UI**, not from
  `.env.production` — though the worker still reads that file itself.

**Why the worker is a non-issue today:** `scripts/fbr-worker.mjs` checks
`FBR_ENABLED` and exits immediately unless it is `true`. The POS is not
registered with FBR yet, so it does nothing either way. This only becomes a
real decision the day fiscal invoicing goes on.

---

## Method 3 — cPanel Git Version Control

*An add-on, not a host.*

Worth being precise about what this is, because its name oversells it. cPanel
can clone the repo and, on each push, run the tasks listed in a `.cpanel.yml`
file. That is **code delivery only** — it replaces the `git pull` line inside
`deploy.sh`. It does not host, proxy or supervise anything, so it still needs
Method 1 or Method 2 underneath it.

Take it if you want "push to GitHub, and it is live." Be aware that cPanel's
deploy runner is a poor place for a Next build (see below), and that the
`.cpanel.yml` it needs does not exist in the repo yet either.

---

## Two things that bite regardless of method

### The build is the hungriest thing this app will ever ask of the box

`npm run build` wants roughly a gigabyte of RAM, on a machine shared with ~150
tenants whose per-user memory ceiling you do not control. If it is killed, it
is killed mid-build. Two ways through, in order of preference:

1. **Run it off-peak.**
2. **Build here and ship the result** — one line, `output: 'standalone'`, in
   `next.config.mjs` plus an rsync.

The runbook's reason for building on the server is that `NEXT_PUBLIC_*` values
bake into the client bundle. That is true in general but **does not apply to
this app: it has no live `NEXT_PUBLIC_*` variables at all** (checked 17 Sep —
every one left in `.env.local` is dead or migration-only). So building locally
carries no matching-values caveat whatsoever. **Do not add swap or raise
limits** — both are global.

### The production hostname is compiled into the app

`next.config.mjs` pins `serverActions.allowedOrigins` to
`pos.flamesbytheindus.com`. Deploy on any other hostname — a staging
subdomain, a temporary address while DNS propagates — and that line must change
too, or every save, settle and print in the app fails. **This is the single
most likely cause of a deploy that loads but will not work.**

## The environment file

Mode `600`, outside every docroot, at `~/apps/flames-pos/.env.production`:

```
DB_NAME=ostech_flamespos
DB_USER=ostech_flamespos
DB_PASSWORD=<the cPanel MySQL user's password>
DB_SOCKET=/var/lib/mysql/mysql.sock
SESSION_SECRET=<paste: openssl rand -hex 32>
NODE_ENV=production
UPLOAD_DIR=/home/ostech/apps/flames-pos/uploads
```

**Generate the session secret on the box** — `openssl rand -hex 32` — and let
the value exist only in that file. Not the development one: the code checks
only its *length*, not its randomness, and two installs sharing a secret would
accept each other's login cookies. An earlier draft of the pre-flight notes
shipped a pre-generated secret in the repo, which was a mistake; it has been
removed, and that value must not be used.

Leave the five FBR keys out until the POS is registered, and add them to this
file only — never to the database.

## The moment it answers, check these four

1. **`/api/health` returns `{"status":"healthy"}`** — proves the app, the proxy
   and the database socket all agree.
2. **Signing in as the seeded admin forces a password change.** If it does not,
   the seed did not run and the install has a known password.
3. **Ring one real bill, settle it in cash, then open `/accounts/health`.** It
   must report no unposted sale. This is the end-to-end test that matters:
   menu, till, tax, ledger.
4. **The till's tax rate matches Settings → Tax.** Then set the brand name, or
   the app and its phone icon will read "POS" until somebody does.

## After the first time

Every update on Method 1 is one command: `~/apps/flames-pos/deploy.sh`. It
pulls, installs, builds, migrates, reloads, and then *insists on a healthy
answer* or fails loudly.
