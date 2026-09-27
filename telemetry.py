"""Telemetry for the seeker node: logging, dedupe store, status file.

Everything the node finds lands here. When you share status.json /
opportunities.jsonl with me, I can analyse them and upgrade the seekers.
"""

import json
import os
import datetime

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOG_FILE = os.path.join(BASE_DIR, "node.log")
OPP_FILE = os.path.join(BASE_DIR, "opportunities.jsonl")
SEEN_FILE = os.path.join(BASE_DIR, "seen.json")
STATUS_FILE = os.path.join(BASE_DIR, "status.json")


def _ts():
    return datetime.datetime.now().isoformat(timespec="seconds")


def log(msg):
    line = f"[{_ts()}] {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def _load_seen():
    try:
        with open(SEEN_FILE, encoding="utf-8") as f:
            data = json.load(f)
            return set(data) if isinstance(data, list) else set()
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def _save_seen(seen):
    with open(SEEN_FILE, "w", encoding="utf-8") as f:
        json.dump(sorted(seen), f)


def record_opportunities(opps):
    """Append only genuinely new opportunities. Returns the list of new ones."""
    seen = _load_seen()
    new = [o for o in opps if o.get("id") not in seen]
    if new:
        with open(OPP_FILE, "a", encoding="utf-8") as f:
            for o in new:
                o = dict(o)
                o["found_at"] = _ts()
                f.write(json.dumps(o, ensure_ascii=False) + "\n")
        seen.update(o["id"] for o in new)
        _save_seen(seen)
    return new


def write_status(state):
    state = dict(state)
    state["updated_at"] = _ts()
    with open(STATUS_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)


def count_opportunities():
    try:
        with open(OPP_FILE, encoding="utf-8") as f:
            return sum(1 for _ in f)
    except FileNotFoundError:
        return 0
