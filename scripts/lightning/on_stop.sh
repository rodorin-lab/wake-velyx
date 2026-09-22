#!/bin/bash

# This script runs every time your Studio sleeps, from your home directory.

# Logs from previous runs can be found in ~/.lightning_studio/logs/

# ============================================================================
# Telegram webhook ARM (RODORIN LABS / 2026-09-22)
# ----------------------------------------------------------------------------
# When the Studio goes to sleep, point Telegram's webhook at the Cloudflare
# Worker so messages sent while sleeping trigger a wake + stay pending for
# native replay (the Hermes gateway calls deleteWebhook(drop_pending_updates=
# False) on startup, which releases pending updates to getUpdates).
#
# Worker: https://wake-velyx.<account>.workers.dev  (registered in Telegram
# via setWebhook below — the URL lives in TELEGRAM_WAKE_WORKER_URL in .env)
#
# Secrets are read from ~/.hermes/.env and never logged.
# All output goes to ~/.lightning_studio/logs/telegram-webhook-arm.log.
# ============================================================================

HERMES_ENV="/teamspace/studios/this_studio/.hermes/.env"
LOG_DIR="/teamspace/studios/this_studio/.lightning_studio/logs"

mkdir -p "$LOG_DIR"

{
    echo "=== telegram webhook arm started at $(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ) ==="

    # Read tokens from Hermes .env (values never logged).
    BOT_TOKEN=""
    WEBHOOK_SECRET=""
    WORKER_URL=""
    if [ -f "$HERMES_ENV" ]; then
        BOT_TOKEN=$(grep -E "^TELEGRAM_BOT_TOKEN=" "$HERMES_ENV" | head -1 | cut -d= -f2- | tr -d '\r')
        WEBHOOK_SECRET=$(grep -E "^TELEGRAM_WEBHOOK_SECRET=" "$HERMES_ENV" | head -1 | cut -d= -f2- | tr -d '\r')
        WORKER_URL=$(grep -E "^TELEGRAM_WAKE_WORKER_URL=" "$HERMES_ENV" | head -1 | cut -d= -f2- | tr -d '\r')
    fi

    if [ -z "$BOT_TOKEN" ] || [ -z "$WEBHOOK_SECRET" ] || [ -z "$WORKER_URL" ]; then
        echo "ERROR: TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET / TELEGRAM_WAKE_WORKER_URL not all present in .env — skipping arm."
        exit 0
    fi

    # Stop the gateway BEFORE arming.  While polling is active, setWebhook
    # terminates the gateway's getUpdates session on Telegram's side (409
    # "terminated by setWebhook request"), and Hermes' conflict recovery
    # would fight the webhook for the session.  on_start.sh restarts the
    # gateway on resume, so stopping here is safe.
    if /usr/bin/sudo -n /usr/bin/systemctl is-active --quiet hermes-gateway.service; then
        echo "Stopping hermes-gateway before arming (on_start.sh restarts it on resume)."
        /usr/bin/sudo -n /usr/bin/systemctl stop hermes-gateway.service
        sleep 2
    else
        echo "hermes-gateway not active — nothing to stop before arming."
    fi

    # Arm the webhook. Telegram's setWebhook replaces any previous webhook
    # URL, so re-running on every sleep is idempotent.
    HTTP_CODE=$(curl -s -o /tmp/.twarm_result -w "%{http_code}" \
        --max-time 15 \
        -X POST "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
        -H "Content-Type: application/json" \
        -d "{\"url\": \"${WORKER_URL}\", \"secret_token\": \"${WEBHOOK_SECRET}\", \"drop_pending_updates\": false, \"allowed_updates\": [\"message\", \"edited_message\"]}")

    if [ "$HTTP_CODE" = "200" ]; then
        echo "Webhook armed OK (HTTP ${HTTP_CODE})."
    else
        echo "Webhook arm FAILED (HTTP ${HTTP_CODE}):"
        # Result body may contain a description; print it but the body never
        # contains the token itself (we sent it in the URL path, response is
        # just {"ok":false,"description":"..."}).
        /bin/cat /tmp/.twarm_result
    fi
    /bin/rm -f /tmp/.twarm_result

    echo "=== telegram webhook arm finished ==="
} >> "$LOG_DIR/telegram-webhook-arm.log" 2>&1