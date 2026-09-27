"""Monitor for the seeker node — run on your computer.

Usage: python3 monitor.py
Shows: last cycle status, total opportunities, newest finds with links.
"""

import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def print_report():
    """Compact paste-friendly report: copy the whole output and send it to Scorpio."""
    status = _read_json(os.path.join(BASE_DIR, "status.json")) or {}
    print("=== SEEKER NODE REPORT (paste this to Scorpio) ===")
    print(json.dumps({"status": status}, indent=1))
    try:
        with open(os.path.join(BASE_DIR, "opportunities.jsonl"), encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        lines = []
    print(f"--- opportunities: {len(lines)} total, showing last 5 ---")
    for line in lines[-5:]:
        o = json.loads(line)
        print(f"- [{o.get('source')}] {o.get('title')} | {o.get('url')}")
    try:
        with open(os.path.join(BASE_DIR, "node.log"), encoding="utf-8") as f:
            log_lines = f.readlines()
    except FileNotFoundError:
        log_lines = []
    print(f"--- log tail ({len(log_lines)} lines total) ---")
    for line in log_lines[-8:]:
        print(line.rstrip())
    print("=== END REPORT ===")


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def main():
    import sys
    if "--report" in sys.argv:
        print_report()
        return
    status = _read_json(os.path.join(BASE_DIR, "status.json"))
    print("=" * 50)
    print("SEEKER NODE MONITOR")
    print("=" * 50)
    if not status:
        print("No status yet — run the node first: python3 node.py --once")
        return
    print(f"Last update:        {status.get('updated_at', '?')}")
    print(f"Total found:        {status.get('total_opportunities', 0)}")
    print(f"New last cycle:     {status.get('new_this_cycle', 0)}")
    print(f"Per seeker:         {status.get('seekers', {})}")
    print()
    print("--- newest opportunities ---")
    try:
        with open(os.path.join(BASE_DIR, "opportunities.jsonl"), encoding="utf-8") as f:
            lines = f.readlines()
    except FileNotFoundError:
        lines = []
    for line in lines[-10:]:
        o = json.loads(line)
        print(f"\n[{o.get('source')}] {o.get('title')}")
        print(f"  {o.get('url')}")
        print(f"  {o.get('snippet', '')[:160]}")
    print("=" * 50)
    print("These are leads, not income. You still apply/reply —")
    print("the node hunts, you close.")


if __name__ == "__main__":
    main()
