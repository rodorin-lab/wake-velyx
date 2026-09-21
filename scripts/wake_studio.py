#!/usr/bin/env python3
"""Idempotent Lightning Studio wake script.

Runs inside GitHub Actions (or anywhere with LIGHTNING_USER_ID/LIGHTNING_API_KEY).
Never interferes with a running studio: start() is only issued when the studio
is fully stopped; every other state is a safe no-op or a benign skip.

Exit codes:
  0 — studio running, or successfully started, or transient state (retry next cycle)
  1 — permanent/config error (bad credentials, studio missing, capacity exhausted)
"""

from __future__ import annotations

import os
import sys

from lightning_sdk import Studio
from lightning_sdk.status import Status

STUDIO_NAME = os.environ.get("WAKE_STUDIO_NAME", "velyx-hermes")
TEAMSPACE = os.environ.get("WAKE_TEAMSPACE", "general")
ORG = os.environ.get("WAKE_ORG", "rodorin-labs")
MACHINE = os.environ.get("WAKE_MACHINE", "CPU")  # Free plan: cpu-4


def main() -> int:
    if not os.environ.get("LIGHTNING_API_KEY") or not os.environ.get("LIGHTNING_USER_ID"):
        print("FATAL: LIGHTNING_API_KEY / LIGHTNING_USER_ID not set", flush=True)
        return 1

    try:
        studio = Studio(name=STUDIO_NAME, teamspace=TEAMSPACE, org=ORG)
    except Exception as exc:  # auth failure, missing studio, etc.
        print(f"FATAL: cannot resolve studio {ORG}/{TEAMSPACE}/{STUDIO_NAME}: {exc}", flush=True)
        return 1

    status = studio.status
    print(f"Studio {STUDIO_NAME}: status={status}", flush=True)

    if status == Status.Running:
        print("Already running — no-op. (on_start.sh already handled gateway setup)", flush=True)
        return 0

    if status == Status.Stopped:
        print(f"Stopped — issuing start(machine={MACHINE})", flush=True)
        try:
            studio.start(machine=MACHINE)
        except Exception as exc:
            print(f"ERROR: start failed: {exc}", flush=True)
            return 1
        print(f"Started. Status now: {studio.status}", flush=True)
        return 0

    # Pending / Stopping / transitional states: do not touch.
    # The platform will settle into Running or Stopped on its own; the next
    # scheduled run handles whichever way it goes. Exiting 0 avoids
    # failure-notification spam for self-healing transient states.
    print(f"Transient state ({status}) — leaving to settle, retry next cycle.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())