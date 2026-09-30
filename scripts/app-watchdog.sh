#!/bin/bash
# External health watchdog for CallTrove -- runs on its own systemd timer
# (see deploy/app-watchdog.timer), completely outside the main Node
# process. That's deliberate: a process that has crashed, deadlocked, or
# lost its database connection can't report its own death from inside
# itself, so src/alerting.js's in-process failure tracking (used by the
# background jobs) can't cover this failure mode -- its state lives in
# the very process that might be the thing that's down. This script
# alerts by calling Resend's HTTP API directly with curl, not through the
# app at all, so it still works even if the app's own code is broken.
#
# State (consecutive failure count, last alert time) persists in
# STATE_FILE between runs, since each run of this script is a fresh
# process with no memory of the last one.

set -euo pipefail

HEALTH_URL="http://localhost:3000/healthz"
STATE_FILE="/opt/app/.watchdog-state"
FAILURE_THRESHOLD=3
COOLDOWN_SECONDS=3600

# Same credentials the app itself already uses -- .env is the one place
# they're configured, so this script reads it too rather than needing its
# own separate copy that could drift out of sync.
if [ -f /opt/app/.env ]; then
  set -a
  # shellcheck disable=SC1091
  source /opt/app/.env
  set +a
fi

send_alert_email() {
  local subject="$1"
  local body="$2"
  if [ -z "${RESEND_API_KEY:-}" ] || [ -z "${ALERT_EMAIL_TO:-}" ] || [ -z "${EMAIL_FROM_ADDRESS:-}" ]; then
    echo "[app-watchdog] would send \"$subject\" but RESEND_API_KEY/EMAIL_FROM_ADDRESS/ALERT_EMAIL_TO isn't fully configured" >&2
    return
  fi
  # Values passed as argv, not interpolated into a string -- node's own
  # JSON.stringify handles escaping, so this is safe regardless of what
  # characters end up in the subject/body/addresses.
  local payload
  payload=$(node -e '
    const [from, to, subject, text] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ from, to: [to], subject, text }));
  ' "$EMAIL_FROM_ADDRESS" "$ALERT_EMAIL_TO" "$subject" "$body")
  curl -sf -X POST https://api.resend.com/emails \
    -H "Authorization: Bearer $RESEND_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload" > /dev/null || echo "[app-watchdog] alert email send failed" >&2
}

count=0
last_alert=0
if [ -f "$STATE_FILE" ]; then
  read -r count last_alert < "$STATE_FILE" || true
fi
now=$(date +%s)

if curl -sf -o /dev/null --max-time 10 "$HEALTH_URL"; then
  if [ "$count" -ge "$FAILURE_THRESHOLD" ]; then
    send_alert_email "CallTrove: app is back up" "The app stopped responding to health checks and has now recovered."
  fi
  echo "0 0" > "$STATE_FILE"
  exit 0
fi

count=$((count + 1))
if [ "$count" -ge "$FAILURE_THRESHOLD" ] && [ $((now - last_alert)) -ge "$COOLDOWN_SECONDS" ]; then
  send_alert_email "CallTrove alert: app is unreachable" "The app has failed $count consecutive health checks (checked every few minutes). You'll get one more email like this if it's still down an hour from now, and one when it recovers."
  last_alert=$now
fi
echo "$count $last_alert" > "$STATE_FILE"
