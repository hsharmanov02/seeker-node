"""Seeker node — main loop.

Runs on YOUR computer. Every interval it asks each enabled seeker to
check its source of demand, records new opportunities, and updates
status.json. Fully autonomous once started: `python3 node.py`

Test a single run without the loop: `python3 node.py --once`
Stop: Ctrl+C
"""

import json
import os
import sys
import time

from telemetry import log, record_opportunities, write_status, count_opportunities
from notifiers.telegram import notify_new_opportunities

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(BASE_DIR, "config.json")

SEEKERS = {}


def _load_seekers():
    from seekers.hn_hiring import HNHiringSeeker
    from seekers.remoteok import RemoteOKSeeker
    for cls in (HNHiringSeeker, RemoteOKSeeker):
        SEEKERS[cls.name] = cls()


def load_config():
    with open(CONFIG_FILE, encoding="utf-8") as f:
        return json.load(f)


def run_cycle(config):
    all_opps = []
    per_seeker = {}
    for name in config.get("seekers", []):
        seeker = SEEKERS.get(name)
        if not seeker:
            log(f"unknown seeker '{name}' — skipping")
            continue
        opps = seeker.find(config)
        per_seeker[name] = len(opps)
        all_opps.extend(opps)
    new_opps = record_opportunities(all_opps)
    new_count = len(new_opps)
    total = count_opportunities()
    write_status({
        "seekers": per_seeker,
        "new_this_cycle": new_count,
        "total_opportunities": total,
    })
    log(f"cycle done: {len(all_opps)} found, {new_count} new, {total} total")
    notify_new_opportunities(config, new_opps)
    return new_count


def main():
    _load_seekers()
    config = load_config()
    interval = int(config.get("interval_minutes", 60)) * 60
    log(f"seeker node started. seekers={list(SEEKERS)} interval={interval // 60}min")
    log("share status.json + opportunities.jsonl with Scorpio for monitoring/upgrades")

    if "--once" in sys.argv:
        run_cycle(config)
        return

    cycle = 0
    try:
        while True:
            cycle += 1
            log(f"--- cycle {cycle} ---")
            run_cycle(config)
            time.sleep(interval)
    except KeyboardInterrupt:
        log("node stopped by user")


if __name__ == "__main__":
    main()
