# Deploying to the cPanel box — pos.flamesbytheindus.com

The production home is a **shared cPanel/WHM server with ~150 tenant sites**
under `/home/ostech/public_html`. That fact shapes every step in this runbook:

> **Nothing global may change.** No global Apache config, no global Node, no
> `.htaccess` sprawl, no firewall edits, no MySQL server settings. Every step
> is per-vhost (userdata includes) or per-user (nvm, PM2 as `ostech`). The one
> deliberate exception is flagged in Phase 0: enabling an Apache module through
> EasyApache, which is additive — it loads a module, it changes no site's
> behavior. If a step in front of you seems to need anything else global,
> stop; the step is wrong, not the rule.

Target state:

| What | Where |
|---|---|
| App | `/home/ostech/apps/flames-pos` — **outside every docroot** |
| Node | 22 via nvm, per-user as `ostech` |
| Process manager | PM2 (`ecosystem.config.js` in the repo root) |
| App port | `127.0.0.1:3017` — loopback only, confirmed free in Phase 0 |
| Web tier | Apache per-vhost userdata includes → reverse proxy |
| MySQL | cPanel's shared instance via socket `/var/lib/mysql/mysql.sock`, db/user `ostech_flamespos` |
| Repo | `https://github.com/adnan9ostech/flames-pos.git` |

Routine updates after first setup are one command: `~/apps/flames-pos/deploy.sh`
(as `ostech`). Everything below is the first-time path.

---

## Phase 0 — Recon (read-only; root SSH)

Nothing in this phase changes the box. Do not skip it — every assumption the
later phases rely on is checked here.

### 0.1 Port inventory

The app, the Apache proxy conf, and `deploy.sh` all assume port **3017**. It
was free at planning time; confirm it still is, on a box with 150 tenants
someone else may have taken it:

```
ss -ltnp | sort -k4
ss -ltnp | grep 3017
```

The second command must print **nothing**. If it doesn't, pick another free
high port and change it in the **two** places that carry it —
`ecosystem.config.js` and the `nodeproxy.conf` in Phase 4 — plus the health
URL in `deploy.sh`.

### 0.2 Apache modules

The proxy needs `proxy_module`, `proxy_http_module`, and `headers_module`
(for `RequestHeader`):

```
httpd -M | grep -E 'proxy_module|proxy_http_module|headers_module'
```

If any is missing, enable it via **WHM → EasyApache 4** (mod_proxy,
mod_proxy_http, mod_headers). **This is the ONLY global act in this runbook**,
and it is safe precisely because loading a module is additive: no existing
vhost's behavior changes until a vhost references it. Everything else stays
per-vhost.

### 0.3 Outbound reachability for the build

`next/font` downloads Geist from Google Fonts **at build time**, and the build
happens on this server (Phase 3 explains why). If the box's firewall blocks
outbound HTTPS to it, `npm run build` fails with a fetch error:

```
curl -sSI https://fonts.googleapis.com >/dev/null && echo fonts reachable
```

### 0.4 Headroom

Next's build is the hungriest thing this app will ever ask of the box:

```
free -m
df -h /home
```

Want roughly 1 GB free RAM for the build and a few GB of disk. If RAM is
tight, run the build off-peak; do not add swap or touch limits (global).

### 0.5 MySQL socket

```
ls -l /var/lib/mysql/mysql.sock
mysql -V
```

The socket must exist and MySQL must be **8.0.16+** (the migrator refuses
older — CHECK constraints must be enforced).

---

## Phase 1 — Subdomain and AutoSSL (AutoSSL FIRST)

Order matters here: **AutoSSL must succeed BEFORE the proxy include lands.**
AutoSSL's domain-control validation (DCV) serves a challenge file from the
subdomain's docroot; once `ProxyPass /` is live, Apache would forward the
challenge to the Node app instead. The include in Phase 4 does carry
`ProxyPass /.well-known/ !` as a permanent escape hatch for renewals, but do
not lean on it for the first issuance — get the cert while the docroot is
still plainly served.

1. cPanel (account `ostech`) → **Domains → Create a New Domain** →
   `pos.flamesbytheindus.com`. Let cPanel give it its own document root under
   `public_html` (e.g. `public_html/pos.flamesbytheindus.com`). The docroot
   will only ever serve DCV challenges — the app never lives in it.
2. Confirm DNS resolves to this server (`dig +short pos.flamesbytheindus.com`).
3. WHM → **SSL/TLS → AutoSSL** → run for the `ostech` account, or wait for the
   scheduled run.
4. Verify before moving on:

   ```
   curl -sI https://pos.flamesbytheindus.com | head -1
   ```

   A valid certificate (any HTTP status is fine) means DCV worked. Do not
   start Phase 4 until it has.

---

## Phase 2 — Database

### 2.1 Create db and user (cPanel, account `ostech`)

cPanel → **MySQL Databases**:

- Database: `ostech_flamespos`
- User: `ostech_flamespos` with a generated password (goes into
  `.env.production` in Phase 3)
- Add user to database with **ALL PRIVILEGES**

No MySQL server settings change — this is the shared instance, reached only
through the local socket.

### 2.2 Schema, data import, users — in this order

Run these after Phase 3's clone + `.env.production` exist (the scripts read
env from there). Listed here because the order is a data-integrity contract:

```
cd ~/apps/flames-pos
node scripts/db/migrate.mjs              # 1. schema: mysql/migrations/*.sql
node scripts/migrate-to-mysql/01-*.mjs   # 2. data from Supabase, in file order
node scripts/migrate-to-mysql/02-*.mjs
node scripts/migrate-to-mysql/03-*.mjs
node scripts/migrate-to-mysql/04-*.mjs
node scripts/migrate-to-mysql/05-*.mjs
node scripts/db/seed-users.mjs           # 3. login users + PINs, last
```

Schema first, the numbered import scripts strictly `01 → 05` (later files
assume the rows of earlier ones), users last. `migrate.mjs --status` shows
applied vs pending if you need to check where things stand.

---

## Phase 3 — Node, app, PM2 (as `ostech`)

### 3.1 Node 22 via nvm — per-user, nothing global

```
ssh ostech@server
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL
nvm install 22
nvm alias default 22
node -v    # v22.x
```

### 3.2 Clone — outside every docroot

```
mkdir -p ~/apps
git clone https://github.com/adnan9ostech/flames-pos.git ~/apps/flames-pos
cd ~/apps/flames-pos
```

`/home/ostech/apps` is not served by Apache, which is the point: no tenant
site, misconfiguration, or directory listing can ever expose the app's source
or its env file.

### 3.3 `.env.production`

```
cd ~/apps/flames-pos
touch .env.production
chmod 600 .env.production
```

Template — fill every value:

```ini
# MySQL — cPanel's shared instance over the local socket (no TCP)
DB_SOCKET=/var/lib/mysql/mysql.sock
DB_NAME=ostech_flamespos
DB_USER=ostech_flamespos
DB_PASSWORD=<from Phase 2.1>

# Sessions — 32+ random bytes; generate, don't invent:
#   openssl rand -hex 32
SESSION_SECRET=<openssl rand -hex 32>

# Public origin (bakes into the client bundle at build time)
NEXT_PUBLIC_SITE_URL=https://pos.flamesbytheindus.com

# FBR fiscal invoicing
FBR_ENABLED=true
FBR_MODE=sandbox          # flip to production only after the sandbox test in Phase 5
FBR_BPOSID=<from FBR>
FBR_TOKEN=<from FBR>
FBR_SELLER_NTN=<business NTN>
FBR_SALE_TYPE=<from FBR>
FBR_HS_CODE=<from FBR>
FBR_UOM=<from FBR>
```

Rules that are not optional:

- **mode 600**, owner `ostech` — it holds the DB password and session secret.
- **Never in a docroot.** It lives in `~/apps/flames-pos` and nowhere else.
- **`NEXT_PUBLIC_*` values bake into the client bundle at `npm run build`.**
  That is why the build runs on this server, after this file exists — a
  bundle built anywhere else carries the wrong origin.

### 3.4 Install, migrate + import, build, start

```
cd ~/apps/flames-pos
npm ci
```

Now run the Phase 2.2 sequence (migrate → import 01–05 → seed users), then:

```
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 status        # flames-pos and fbr-worker both 'online'
curl -fsS http://127.0.0.1:3017/api/health
```

### 3.5 Survive a reboot (one command as root)

PM2 must come back when the box does. As **root**:

```
pm2 startup systemd -u ostech --hp /home/ostech
```

This installs a per-user systemd unit for `ostech` only — no other tenant is
touched. `pm2 save` (already run) recorded the process list it resurrects.

### 3.6 Log rotation

PM2 logs grow forever by default. Per-user module, as `ostech`:

```
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retention 14
```

---

## Phase 4 — Apache: per-vhost userdata includes (never `.htaccess`)

cPanel's supported mechanism for custom vhost config is **userdata include
files** — they survive EasyApache rebuilds and `httpd.conf` regenerations,
and they scope to exactly one domain of one account. `.htaccess` cannot carry
`ProxyPass` at all.

### 4.1 SSL vhost — the proxy

Create (as root) `/etc/apache2/conf.d/userdata/ssl/2_4/ostech/pos.flamesbytheindus.com/nodeproxy.conf`:

```apache
# Reverse proxy for the Flames POS Node app (PM2: flames-pos).
# The port (3017) also lives in ecosystem.config.js — change both together.

# Next.js Server Actions compare Host against Origin; without this Apache
# would send "Host: 127.0.0.1:3017" and every action would 403/500.
ProxyPreserveHost On

# Next dev is snappy but a cold prod route or a heavy report can take a beat.
ProxyTimeout 60

# AutoSSL renewals do DCV from the docroot — never forward the challenge.
ProxyPass /.well-known/ !

ProxyPass        / http://127.0.0.1:3017/ retry=0
ProxyPassReverse / http://127.0.0.1:3017/

# The app only ever sees loopback HTTP; tell it the real scheme so cookies
# stay Secure and redirects stay https.
RequestHeader set X-Forwarded-Proto https
```

`retry=0`: when PM2 restarts the app, Apache would otherwise remember the
backend as dead for 60 s and 503 the till mid-service; with 0 it retries
immediately.

### 4.2 Plain-HTTP vhost — redirect to https

Create `/etc/apache2/conf.d/userdata/std/2_4/ostech/pos.flamesbytheindus.com/redirect.conf`:

```apache
# Everything on port 80 goes to https — the POS sets Secure cookies and must
# never be used over plain HTTP. DCV is the one exception.
RewriteEngine On
RewriteCond %{REQUEST_URI} !^/\.well-known/
RewriteRule ^ https://pos.flamesbytheindus.com%{REQUEST_URI} [R=301,L]
```

### 4.3 Wire in, check, reload

```
/scripts/ensure_vhost_includes --domain=pos.flamesbytheindus.com
httpd -t
apachectl graceful
```

`httpd -t` **must** say `Syntax OK` before the graceful reload — a syntax
error here would take down all ~150 sites, which is exactly the kind of
global blast radius this runbook exists to avoid. `graceful` finishes
in-flight requests on every tenant site rather than dropping them.

Then from outside:

```
curl -sI https://pos.flamesbytheindus.com/api/health | head -1   # HTTP/1.1 200
curl -sI http://pos.flamesbytheindus.com | head -1               # 301 → https
```

---

## Phase 5 — Verification, then cutover

### 5.1 Verification checklist

Work through all of it — each line covers a distinct failure mode:

- [ ] `curl -fsS https://pos.flamesbytheindus.com/api/health` returns healthy
- [ ] Log in as an **admin** PIN and as a **staff** PIN — both land where
      their role should
- [ ] `/customer` loads **logged out** (public menu needs no session)
- [ ] Ring an order on `/pos` → settle it → receipt prints; with
      `FBR_MODE=sandbox` the invoice reaches the FBR sandbox (check the
      fbr-worker logs: `pm2 logs fbr-worker`)
- [ ] `/kds` on a second screen shows the order and bump moves it
- [ ] Void an order as admin; confirm a staff session **cannot** void
- [ ] Toggle an item sold-out in settings; it greys out on the till
- [ ] Kill the app (`pm2 stop flames-pos`): the till shows the offline banner
      within **8 seconds**; `pm2 start flames-pos` recovers it
- [ ] `pm2 status` shows both processes online with sane memory after all of
      the above

### 5.2 Cutover

Only after every box above is ticked:

1. **Kiosk shortcut** on each till machine: swap the URL in the Chrome
   shortcut target to `https://pos.flamesbytheindus.com/pos`. The
   `--user-data-dir` profile is keyed to the directory, not the URL, so the
   primed silent-print settings survive the swap unchanged
   (see `docs/kiosk-printing.md`).
2. **PWA**: if the till had the old origin installed as a PWA, uninstall and
   reinstall from the new origin — installs are per-origin and do not follow.
3. **Archive Supabase order history**: export the orders/order_items tables
   to CSV from the Supabase dashboard and file them — this is the audit trail
   for everything rung up before the cutover.
4. **Pause the Vercel project** so the old origin stops serving a live till.
5. **Revoke the Supabase anon key** — the old client bundle carries it, and
   the pause in step 4 does not un-publish cached copies.
