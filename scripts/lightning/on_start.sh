#!/bin/bash

# This script runs every time your Studio starts, from your home directory.
#
# Logs from previous runs can be found in ~/.lightning_studio/logs/
#
# List files under fast_load that need to load quickly on start (e.g. model checkpoints).
#
# ! fast_load
# <your file here>

# Add your startup commands below.
#
# Example: streamlit run my_app.py
# Example: gradio my_app.py

# ============================================================================
# Hermes Gateway systemd fail-safe (RODORIN LABS / 2026-09-21)
# ----------------------------------------------------------------------------
# The Lightning Studio snapshot does not persist /etc/systemd/system/, so the
# hermes-gateway.service unit is re-installed from a template stored in this
# persistent home directory on every Studio start.
#
# Template: .lightning_studio/hermes-gateway.service.template
# Unit:     /etc/systemd/system/hermes-gateway.service
#
# Idempotent: reuses the existing unit when it is identical to the template.
# The unit contains no secrets. No Hermes config or SOUL.md is modified.
# ============================================================================

HERMES_UNIT_SRC="/teamspace/studios/this_studio/.lightning_studio/hermes-gateway.service.template"
HERMES_UNIT_DST="/etc/systemd/system/hermes-gateway.service"
HERMES_LOG_DIR="/teamspace/studios/this_studio/.lightning_studio/logs"

mkdir -p "$HERMES_LOG_DIR"

{
    echo "=== hermes-gateway fail-safe started at $(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ) ==="

    if [ ! -f "$HERMES_UNIT_SRC" ]; then
        echo "ERROR: unit template not found: $HERMES_UNIT_SRC"
        exit 1
    fi

    # Re-install the unit only when missing or different from the template.
    if [ ! -f "$HERMES_UNIT_DST" ] || ! /usr/bin/cmp -s "$HERMES_UNIT_SRC" "$HERMES_UNIT_DST"; then
        echo "Unit missing or outdated — (re)installing from template."
        /usr/bin/sudo -n /usr/bin/install -m 644 -o root -g root \
            "$HERMES_UNIT_SRC" "$HERMES_UNIT_DST"
        /usr/bin/sudo -n /usr/bin/systemctl daemon-reload
        echo "Unit installed and daemon reloaded."
    else
        echo "Unit already installed and identical to template — skipping regeneration."
    fi

    # Enable (idempotent) and start (idempotent: no-op if already running).
    /usr/bin/sudo -n /usr/bin/systemctl enable hermes-gateway.service
    /usr/bin/sudo -n /usr/bin/systemctl start hermes-gateway.service

    /usr/bin/systemctl is-active hermes-gateway.service
    echo "=== hermes-gateway fail-safe finished ==="
} >> "$HERMES_LOG_DIR/hermes-fail-safe.log" 2>&1