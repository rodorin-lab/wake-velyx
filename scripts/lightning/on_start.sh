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

# ============================================================================
# Tailscale fail-safe (RODORIN LABS / 2026-09-22)
# ----------------------------------------------------------------------------
# Same pattern as the Hermes gateway fail-safe above, but fully independent:
# runs in its own subshell, never exits the script early, and never touches
# the Hermes block's state.
#
# Template: .lightning_studio/tailscaled.service.template
# Unit:     /etc/systemd/system/tailscaled.service
# State:    .lightning_studio/tailscale/state   (persistent home — survives
#           snapshots, so the node identity and login survive reboots)
#
# /dev/net/tun is recreated if the snapshot dropped it (kernel module is
# always present; only the device node can go missing).
# ============================================================================

TS_UNIT_SRC="/teamspace/studios/this_studio/.lightning_studio/tailscaled.service.template"
TS_UNIT_DST="/etc/systemd/system/tailscaled.service"
TS_BIN="/teamspace/studios/this_studio/.lightning_studio/tailscale/bin/tailscale"
TS_LOG_DIR="/teamspace/studios/this_studio/.lightning_studio/logs"

(
    echo "=== tailscale fail-safe started at $(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ) ==="

    if [ ! -f "$TS_UNIT_SRC" ] || [ ! -x "$TS_BIN" ]; then
        echo "WARN: tailscale template or binary missing — skipping Tailscale setup."
        echo "=== tailscale fail-safe finished (skipped) ==="
        exit 0
    fi

    # Ensure /dev/net/tun exists (harmless if present, fixes missing node).
    if [ ! -c /dev/net/tun ]; then
        echo "/dev/net/tun missing — recreating device node."
        /usr/bin/sudo -n /usr/bin/mkdir -p /dev/net
        /usr/bin/sudo -n /usr/bin/mknod /dev/net/tun c 10 200
        /usr/bin/sudo -n /usr/bin/chmod 666 /dev/net/tun
    fi

    # Re-install the unit only when missing or different from the template.
    if [ ! -f "$TS_UNIT_DST" ] || ! /usr/bin/cmp -s "$TS_UNIT_SRC" "$TS_UNIT_DST"; then
        echo "tailscaled unit missing or outdated — (re)installing from template."
        /usr/bin/sudo -n /usr/bin/install -m 644 -o root -g root \
            "$TS_UNIT_SRC" "$TS_UNIT_DST"
        /usr/bin/sudo -n /usr/bin/systemctl daemon-reload
        echo "tailscaled unit installed and daemon reloaded."
    else
        echo "tailscaled unit already installed and identical to template — skipping regeneration."
    fi

    # Enable (idempotent) and start (idempotent: no-op if already running).
    /usr/bin/sudo -n /usr/bin/systemctl enable tailscaled.service
    /usr/bin/sudo -n /usr/bin/systemctl start tailscaled.service

    /usr/bin/systemctl is-active tailscaled.service

    # Report login state. With persistent state dir the node auto-logins on
    # resume; "Logged out." here would mean the state was lost (should never
    # happen) and would need a one-time manual `tailscale up`.
    "$TS_BIN" status --peers=false 2>&1 | head -2 || true
    echo "=== tailscale fail-safe finished ==="
) >> "$TS_LOG_DIR/tailscale-fail-safe.log" 2>&1 || true

# ============================================================================
# SSH keys fail-safe (RODORIN LABS / 2026-09-22)
# ----------------------------------------------------------------------------
# ~/.ssh is listed in ~/.lightningignore, so keys placed there vanish on
# snapshot resume. The persistent copies in .lightning_studio/ssh/ are restored
# into ~/.ssh on every Studio start. chmod 600 enforced; idempotent.
# ============================================================================

SSH_KEY_SRC="/teamspace/studios/this_studio/.lightning_studio/ssh"
SSH_KEY_DST="/teamspace/studios/this_studio/.ssh"

(
    echo "=== ssh-keys fail-safe started at $(/usr/bin/date -u +%Y-%m-%dT%H:%M:%SZ) ==="
    if [ ! -d "$SSH_KEY_SRC" ]; then
        echo "WARN: $SSH_KEY_SRC missing — nothing to restore."
        exit 0
    fi
    /usr/bin/mkdir -p "$SSH_KEY_DST"
    /usr/bin/chmod 700 "$SSH_KEY_DST"
    for f in "$SSH_KEY_SRC"/*; do
        [ -f "$f" ] || continue
        base=$(/usr/bin/basename "$f")
        if [ ! -f "$SSH_KEY_DST/$base" ] || ! /usr/bin/cmp -s "$f" "$SSH_KEY_DST/$base"; then
            /usr/bin/cp "$f" "$SSH_KEY_DST/$base"
            case "$base" in
                *.pub) /usr/bin/chmod 644 "$SSH_KEY_DST/$base" ;;
                *)     /usr/bin/chmod 600 "$SSH_KEY_DST/$base" ;;
            esac
            echo "restored: $base"
        else
            echo "up-to-date: $base"
        fi
    done
    echo "=== ssh-keys fail-safe finished ==="
) >> "/teamspace/studios/this_studio/.lightning_studio/logs/ssh-keys-fail-safe.log" 2>&1 || true