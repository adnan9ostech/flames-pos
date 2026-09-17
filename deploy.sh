#!/usr/bin/env bash
#
# Deploy on the cPanel box. Run as ostech (never root):
#
#   ssh ostech@server '~/apps/flames-pos/deploy.sh'
#
# The build happens ON the server for convenience, not necessity. The original
# reason given here was that NEXT_PUBLIC_* values bake into the client bundle —
# true in general, but this app has no live NEXT_PUBLIC_* variables (checked
# 17 Sep 2026), so a bundle built elsewhere is fine. If the box's memory limit
# kills `npm run build`, build locally and ship it; see docs/deploy-env.md.
# First-time setup is docs/deploy-cpanel.md; this script is only the
# repeatable update path.
set -euo pipefail

cd ~/apps/flames-pos

git pull --ff-only
npm ci
npm run build

# Schema before processes: the new code may depend on a column the old code
# ignores, never the other way around (migrations are additive).
node scripts/db/migrate.mjs

pm2 reload ecosystem.config.js

# reload returns before Next listens; give it a beat, then insist on a
# healthy answer or fail the deploy loudly.
sleep 2
curl -fsS --retry 5 --retry-delay 2 http://127.0.0.1:3017/api/health
