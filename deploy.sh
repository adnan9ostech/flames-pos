#!/usr/bin/env bash
#
# Deploy on the cPanel box. Run as ostech (never root):
#
#   ssh ostech@server '~/apps/flames-pos/deploy.sh'
#
# The build happens ON the server on purpose: NEXT_PUBLIC_* values bake into
# the client bundle at build time, so a bundle built elsewhere carries the
# wrong ones. First-time setup is docs/deploy-cpanel.md; this script is only
# the repeatable update path.
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
