"""Seeker node supervisor — process manager + Scorpio's remote command channel.

Run this INSTEAD of node.py / serve.py directly (one terminal only):
    python supervisor.py
Stop: Ctrl+C (children are stopped cleanly too)

What it does:
  1. Launches node.py and serve.py as child processes and keeps them alive
     (restarts them if they crash, with backoff so a broken build can't spin).
  2. Every POLL_SECONDS it fetches commands.json from the GitHub repo.
     When Scorpio pushes a command, the supervisor runs it — updates deploy
     themselves, no clicks needed on your end.

Valid commands (whitelist — anything else is rejected and logged):
  none     no-op (used for the initial file)
  ping     no-op that proves the poller is alive; recorded in supervisor.json
  update   git pull origin main, then restart node.py + serve.py
  restart  restart node.py + serve.py without pulling

Safety:
  - Commands older than 24h are ignored (no stale surprises after downtime).
  - Each command carries a nonce; a nonce is never executed twice.
  - Only code from this repo's main branch is ever pulled — Scorpio's
    upgrades, nothing else.

The supervisor writes supervisor.json (served by serve.py alongside the
other telemetry) so Scorpio can verify every command executed.

Env overrides (mainly for testing):
  SEEKER_COMMAND_URL   custom commands.json URL (default: the repo's raw file)
  SEEKER_POLL_S        poll interval in seconds (default: 60)
"""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from telemetry import log  # noqa: E402  (writes into node.log, which serve.py exposes)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
REPO = "hsharmanov02/seeker-node"
COMMAND_URL = os.environ.get(
    "SEEKER_COMMAND_URL",
    f"https://raw.githubusercontent.com/{REPO}/main/commands.json",
)
POLL_SECONDS = int(os.environ.get("SEEKER_POLL_S", "60"))
NONCE_FILE = os.path.join(BASE_DIR, "last_nonce.txt")
SUPERVISOR_JSON = os.path.join(BASE_DIR, "supervisor.json")
MAX_COMMAND_AGE = timedelta(hours=24)
CHILDREN = ("node.py", "serve.py")

VALID_COMMANDS = {"none", "ping", "update", "restart"}

stop_requested = False
children = {}        # name -> subprocess.Popen
child_state = {}     # name -> {"started_at": float, "quick_deaths": int, "retry_at": float}
last_command_info = {"cmd": None, "nonce": None, "executed_at": None, "result": None}


def _request_stop(signum, frame):
    global stop_requested
    stop_requested = True


signal.signal(signal.SIGINT, _request_stop)
if hasattr(signal, "SIGTERM"):
    signal.signal(signal.SIGTERM, _request_stop)


# ---------- child process management ----------

def start_child(name):
    proc = subprocess.Popen([sys.executable, name], cwd=BASE_DIR)
    children[name] = proc
    child_state[name] = {
        "started_at": time.time(),
        "quick_deaths": 0,
        "retry_at": 0,
    }
    log(f"supervisor: started {name} (pid {proc.pid})")


def stop_child(name, timeout=10):
    proc = children.pop(name, None)
    if proc is None:
        return
    if proc.poll() is not None:
        return  # already dead
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
        log(f"supervisor: stopped {name}")
    except subprocess.TimeoutExpired:
        proc.kill()
        log(f"supervisor: killed {name} (did not stop gracefully)")


def restart_children():
    for name in CHILDREN:
        stop_child(name)
    for name in CHILDREN:
        start_child(name)


def supervise():
    """Restart dead children, with exponential backoff on rapid crashes."""
    now = time.time()
    for name in CHILDREN:
        proc = children.get(name)
        if proc is not None and proc.poll() is None:
            continue  # alive and well
        state = child_state.get(name, {"started_at": now, "quick_deaths": 0, "retry_at": 0})
        if proc is not None:  # it died — account for it
            children.pop(name, None)
            lived = now - state["started_at"]
            if lived < 60:
                state["quick_deaths"] += 1
            else:
                state["quick_deaths"] = 0
            delay = min(300, 5 * (2 ** state["quick_deaths"]))
            state["retry_at"] = now + delay
            child_state[name] = state
            log(f"supervisor: {name} died after {lived:.0f}s "
                f"(quick deaths: {state['quick_deaths']}, retry in {delay:.0f}s)")
        if now >= state["retry_at"]:
            start_child(name)


# ---------- command channel ----------

def fetch_command():
    url = COMMAND_URL
    if url.startswith("http"):
        url += ("&" if "?" in url else "?") + f"t={int(time.time())}"  # bust CDN cache
    try:
        with urllib.request.urlopen(url, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        log(f"supervisor: command fetch failed: {e}")
        return None


def read_nonce():
    try:
        with open(NONCE_FILE, encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def write_nonce(nonce):
    with open(NONCE_FILE, "w", encoding="utf-8") as f:
        f.write(nonce)


def is_stale(cmd_obj):
    try:
        issued = datetime.fromisoformat(str(cmd_obj["issued_at"]))
        if issued.tzinfo is None:
            issued = issued.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) - issued > MAX_COMMAND_AGE
    except Exception:
        return True  # unparseable timestamp -> do not run


def do_update():
    try:
        r = subprocess.run(
            ["git", "pull", "origin", "main"],
            cwd=BASE_DIR, capture_output=True, text=True, timeout=180,
        )
        out = (r.stdout + r.stderr).strip()
    except FileNotFoundError:
        return "FAILED: git not found on PATH"
    except subprocess.TimeoutExpired:
        return "FAILED: git pull timed out after 180s"
    changed = r.returncode == 0 and "Already up to date" not in out
    restart_children()
    tail = out[-400:] if len(out) > 400 else out
    return (f"git pull exit={r.returncode}, changed={changed}; "
            f"restarted {' + '.join(CHILDREN)}. pull output: {tail}")


def execute_command(cmd_obj):
    cmd = cmd_obj.get("cmd")
    if cmd not in VALID_COMMANDS:
        return f"REJECTED: unknown command '{cmd}' (whitelist: {sorted(VALID_COMMANDS)})"
    if cmd in ("none", "ping"):
        return "ok (no-op)"
    if cmd == "restart":
        restart_children()
        return f"ok: restarted {' + '.join(CHILDREN)}"
    if cmd == "update":
        return do_update()
    return "REJECTED: unreachable"  # pragma: no cover


def write_supervisor_json():
    payload = {
        "alive_at": datetime.now(timezone.utc).isoformat(),
        "poll_seconds": POLL_SECONDS,
        "command_url": COMMAND_URL,
        "children": {
            name: ("running" if (p := children.get(name)) is not None and p.poll() is None
                   else "down")
            for name in CHILDREN
        },
        "last_command": last_command_info,
    }
    tmp = SUPERVISOR_JSON + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.replace(tmp, SUPERVISOR_JSON)


# ---------- main loop ----------

def main():
    log("supervisor started — managing node.py + serve.py, "
        f"polling commands every {POLL_SECONDS}s")
    for name in CHILDREN:
        start_child(name)
    write_supervisor_json()

    while not stop_requested:
        cmd_obj = fetch_command()
        if isinstance(cmd_obj, dict):
            nonce = str(cmd_obj.get("nonce", ""))
            if nonce and nonce != read_nonce():
                if is_stale(cmd_obj):
                    log(f"supervisor: ignoring stale/unparseable command "
                        f"'{cmd_obj.get('cmd')}' nonce={nonce}")
                else:
                    result = execute_command(cmd_obj)
                    last_command_info.update({
                        "cmd": cmd_obj.get("cmd"),
                        "nonce": nonce,
                        "executed_at": datetime.now(timezone.utc).isoformat(),
                        "result": result,
                    })
                    log(f"supervisor: executed '{cmd_obj.get('cmd')}' "
                        f"nonce={nonce}: {result}")
                write_nonce(nonce)  # never execute the same nonce twice
        supervise()
        write_supervisor_json()
        for _ in range(POLL_SECONDS):
            if stop_requested:
                break
            time.sleep(1)

    log("supervisor shutting down — stopping children")
    for name in CHILDREN:
        stop_child(name)
    log("supervisor stopped")


if __name__ == "__main__":
    main()
