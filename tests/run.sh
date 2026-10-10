#!/bin/bash
# Runs the whole regression suite against a throwaway Postgres and a local copy
# of the app, then cleans up. Needs: postgresql (initdb/pg_ctl), node, and
# Playwright with a Chromium (PLAYWRIGHT_PATH / CHROMIUM_PATH if not standard).
#   bash tests/run.sh
set -u
cd "$(dirname "$0")/.."
PGBIN=${PGBIN:-/usr/lib/postgresql/16/bin}
DATA=/var/tmp/ct-test-pg
export PLAYWRIGHT_PATH=${PLAYWRIGHT_PATH:-/opt/node-tools/node_modules/playwright}
export CHROMIUM_PATH=${CHROMIUM_PATH:-/opt/pw-browsers/chromium}
export TEST_OUTBOX=/var/tmp/ct-test-outbox.jsonl
export DATABASE_URL="postgres://postgres@/ct?host=/tmp&port=5544"
export PADDLE_API_KEY=pdl_sdbx_fake PADDLE_WEBHOOK_SECRET=whsec_test PADDLE_CLIENT_TOKEN=test_fake PADDLE_PRICE_ID=pri_std PADDLE_PRICE_ID_HIPAA=pri_hip PADDLE_ENV=sandbox SESSION_SECRET=test-secret PORT=3100
export GHL_OAUTH_CLIENT_ID=x GHL_OAUTH_CLIENT_SECRET=y GHL_OAUTH_REDIRECT_URI=http://localhost:3100/api/admin/oauth/callback
cleanup() { [ -n "${APP_PID:-}" ] && kill "$APP_PID" 2>/dev/null; su postgres -c "$PGBIN/pg_ctl -D $DATA stop -m immediate" >/dev/null 2>&1; rm -rf "$DATA" "$TEST_OUTBOX" /tmp/.s.PGSQL.5544*; }
trap cleanup EXIT
cleanup
mkdir -p "$DATA" && chown postgres "$DATA"
su postgres -c "$PGBIN/initdb -D $DATA -A trust >/dev/null && $PGBIN/pg_ctl -D $DATA -o '-p 5544 -k /tmp' -l $DATA.log start" >/dev/null 2>&1
sleep 3
psql -h /tmp -p 5544 -U postgres -qc "create database ct" || exit 2
echo "migrating twice (the second run must be harmless)..."
node src/db/migrate.js && node src/db/migrate.js || exit 2
node -r ./tests/stub-email.js src/server.js > /var/tmp/ct-test-app.log 2>&1 &
APP_PID=$!
sleep 4
curl -sf localhost:3100/health >/dev/null || { echo "app did not start"; tail -20 /var/tmp/ct-test-app.log; exit 2; }
node tests/regression.js
