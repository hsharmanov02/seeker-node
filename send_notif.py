#!/usr/bin/env python3
"""Send a PC notification to Haste via the seeker-node repo.

The x_bridge on his PC polls notifications.json on GitHub every 60s and
pops a Windows toast. Used ONLY for trade-approval requests.

Usage:
    send_notif.py --ticket T20260928-001 \
        --title "Trade approval needed" \
        --body "BUY NVDA - GBP 12 @ market, stop $228, target $235, expires 16:20"
"""

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
NOTIF_FILE = os.path.join(BASE_DIR, "notifications.json")
PUSH_PY = os.path.expanduser("~/workspace/skills/github/bin/push.py")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--type", default="trade_approval")
    ap.add_argument("--ticket", default="")
    ap.add_argument("--title", required=True)
    ap.add_argument("--body", required=True)
    args = ap.parse_args()

    try:
        with open(NOTIF_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        data = {}
    notifs = data.get("notifications", []) if isinstance(data, dict) else []

    now = time.time()
    # prune entries older than 24h so the file stays small
    notifs = [n for n in notifs
              if isinstance(n, dict) and now - n.get("ts_epoch", now) < 24 * 3600]

    entry = {
        "id": f"n{int(now)}-{uuid.uuid4().hex[:6]}",
        "ts": datetime.now(timezone.utc).isoformat(),
        "ts_epoch": now,
        "type": args.type,
        "ticket_id": args.ticket,
        "title": args.title[:120],
        "body": args.body[:300],
    }
    notifs.append(entry)
    tmp = NOTIF_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"notifications": notifs}, f, indent=1)
    os.replace(tmp, NOTIF_FILE)

    msg = f"notify: {args.type} {args.ticket}".strip()
    r = subprocess.run(
        [sys.executable, PUSH_PY, "--dir", BASE_DIR,
         "--owner", "hsharmanov02", "--repo", "seeker-node",
         "--branch", "main", "--message", msg],
        capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        print("PUSH FAILED: " + (r.stderr or r.stdout)[-800:], file=sys.stderr)
        sys.exit(1)
    print("notification pushed: " + entry["id"])

    # Fast path: push straight to the bridge over the Tailscale tunnel so the
    # toast appears in seconds instead of waiting for the GitHub poll.
    # Best-effort — the poll is the backup if this fails.
    try:
        import urllib.request
        proxy = os.environ.get("HTTPS_PROXY", "") or os.environ.get("https_proxy", "")
        # Tunnel proxy lives on port 3130 of the same proxy host (keep any
        # credentials in the URL — strip only the trailing :port).
        tunnel = proxy.rsplit(":", 1)[0] + ":3130" if proxy else None
        if tunnel:
            payload = json.dumps(entry).encode("utf-8")
            req = urllib.request.Request(
                "http://100.109.69.66:8898/notify", data=payload,
                headers={"Content-Type": "application/json"}, method="POST")
            opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({"http": tunnel}))
            with opener.open(req, timeout=15) as r:
                r.read()
            print("direct push delivered")
        else:
            print("direct push skipped (no tunnel proxy available)")
    except Exception as e:
        print(f"direct push failed ({type(e).__name__}: {e}) — poll will pick it up")


if __name__ == "__main__":
    main()
