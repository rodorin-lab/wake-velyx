#!/bin/bash
# ============================================================================
# One-shot ARM TEST (RODORIN LABS / 2026-09-22)
# ----------------------------------------------------------------------------
# Verifies the on_stop.sh Telegram webhook arm end-to-end WITHOUT a real
# studio sleep:
#   0. Worker liveness + bad-secret rejection (expect 403)
#   1. Stop gateway
#   2. Arm via on_stop.sh (the real production path)
#   3. Verify via getWebhookInfo (url only — Telegram never returns secret_token)
#   4. Disarm (deleteWebhook, pending updates KEPT)
#   5. Restart gateway and show telegram connect journal lines
#
# Scheduled with a delay so the triggering chat reply can be delivered first:
#   sudo systemd-run --unit=hermes-arm-test --on-active=90 \
#       /bin/bash /teamspace/studios/this_studio/.lightning_studio/arm-test.sh
#
# Log: ~/.lightning_studio/logs/arm-test.log
# NOTE: no tokens or secrets are ever printed.
# ============================================================================

ENV_FILE="/teamspace/studios/this_studio/.hermes/.env"
LOG_DIR="/teamspace/studios/this_studio/.lightning_studio/logs"
ON_STOP="/teamspace/studios/this_studio/.lightning_studio/on_stop.sh"

BOT_TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r')
WORKER_URL=$(grep -E "^TELEGRAM_WAKE_WORKER_URL=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r')

{
echo "=== arm test started at $(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# --- 0. Worker sanity gate (liveness + secret enforcement) ---
# ABORTS (without touching the gateway) unless the REAL wake-worker.js is
# deployed: the Cloudflare "Hello World" template answers 200 to everything
# and would silently consume slept-time messages.
LIVE=$(curl -sS -m 15 "${WORKER_URL%/}/" 2>/dev/null || true)
echo "--- [0] worker liveness body: ${LIVE}"
case "$LIVE" in
    *wake-velyx*) : ;;
    *) echo "SANITY GATE FAILED: liveness body is not 'wake-velyx worker alive' —"
       echo "the Hello World template is probably still deployed. Aborting;"
       echo "nothing armed, gateway untouched."
       echo "=== arm test aborted at $(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ) ==="
       exit 1 ;;
esac

echo "--- [0] worker bad-secret POST (expect HTTP 403) ---"
BAD=$(curl -s -m 15 -o /dev/null -w "%{http_code}" -X POST "${WORKER_URL%/}/" \
    -H "x-telegram-bot-api-secret-token: definitely-wrong" \
    -H "Content-Type: application/json" -d '{}')
echo "bad-secret POST → HTTP ${BAD}"
if [ "${BAD}" != "403" ]; then
    echo "SANITY GATE FAILED: expected HTTP 403 on a bad secret, got ${BAD}."
    echo "Deploy worker/wake-worker.js from https://github.com/rodorin-lab/wake-velyx"
    echo "first. Aborting; nothing armed, gateway untouched."
    echo "=== arm test aborted at $(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    exit 1
fi

# --- 1. Stop the gateway ---
echo "--- [1] stopping hermes-gateway ---"
/usr/bin/sudo -n /usr/bin/systemctl stop hermes-gateway.service
sleep 2
echo "gateway state: $(/usr/bin/systemctl is-active hermes-gateway.service || true)"

# --- 2. Arm via on_stop.sh (production path; gateway already stopped → no-op stop) ---
echo "--- [2] running on_stop.sh (arm) ---"
/bin/bash "$ON_STOP"

# --- 3. Verify the webhook registration (getWebhookInfo: no secret in response) ---
echo "--- [3] getWebhookInfo after arm ---"
curl -sS -m 15 "https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo"
echo

# --- 4. Disarm so polling resumes cleanly (keep pending updates) ---
echo "--- [4] disarming (deleteWebhook, drop_pending_updates=false) ---"
HTTP=$(curl -s -o /tmp/.twdisarm -w "%{http_code}" --max-time 15 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook")
echo "deleteWebhook → HTTP ${HTTP}"
/bin/rm -f /tmp/.twdisarm

# --- 5. Restart gateway ---
echo "--- [5] restarting hermes-gateway ---"
/usr/bin/sudo -n /usr/bin/systemctl start hermes-gateway.service
sleep 25
echo "gateway state: $(/usr/bin/systemctl is-active hermes-gateway.service || true)"
echo "--- last telegram/polling journal lines ---"
/usr/bin/journalctl -u hermes-gateway -n 60 --no-pager \
    | /usr/bin/grep -Ei "telegram|polling|connect" | /usr/bin/tail -12 || true

echo "=== arm test finished at $(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ) ==="
} >> "$LOG_DIR/arm-test.log" 2>&1