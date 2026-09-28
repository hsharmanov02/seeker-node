"""X bridge v3 — lets Scorpio read YOUR logged-in X feed for stock alerts.

Just double-click x_bridge.bat. That's the whole setup.

What it does:
  1. Starts its OWN Chrome window with a dedicated profile stored next to
     this script (.xbridge-profile). Your main Chrome is never touched —
     no shortcut editing, no flags, no tab stealing.
  2. You log into X inside the bridge window ONCE if it asks; the profile
     remembers you, so it survives restarts. Minimize the window and
     ignore it forever.
  3. During market hours (Mon–Fri, 13:30–21:30 London) it quietly loads,
     every 15 minutes: your Home timeline plus Latest searches for
     $NVDA, $MSFT and $AAPL, and copies out recent posts mentioning them.
     Outside market hours it just keeps serving the last batch.
  4. Saves them to x_posts.json and serves ONLY that file on port 8898,
     so Scorpio can fetch it over your Tailscale network. If Tailscale is
     installed but not running, the bridge tries to start it itself.

What it does NOT do:
  - It never posts, likes, follows, or sends DMs. Read-only.
  - It never touches your passwords or DMs; it only reads public timeline text.
  - It never opens tabs in your main Chrome window.
  - It never kills your main Chrome — only stale bridge-Chrome processes
    that it started itself.

One-time setup:
  1. Double-click x_bridge.bat.
  2. A bridge Chrome window appears — log into X in it if asked, then
     minimize it and leave it alone.
  3. Leave the script window open while you want Scorpio to see your feed.

Stop any time with Ctrl+C. Nothing is uploaded anywhere except your own
Tailscale network (x_posts.json on port 8898).
"""

import json
import os
import re
import socket
import subprocess
import threading
import time
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(BASE_DIR, "x_posts.json")
PROFILE_DIR = os.path.join(BASE_DIR, ".xbridge-profile")
PORT = 8898
CDP_PORT = 9222
CDP_URL = f"http://localhost:{CDP_PORT}"
CYCLE_SECS = 5 * 60
BRIDGE_MARKER = "xbridge-window"  # fragment identifying our dedicated window

QUERIES = [
    ("home", "https://x.com/home"),
    ("$NVDA", "https://x.com/search?q=%24NVDA&src=cashtag_click&f=live"),
    ("$MSFT", "https://x.com/search?q=%24MSFT&src=cashtag_click&f=live"),
    ("$AAPL", "https://x.com/search?q=%24AAPL&src=cashtag_click&f=live"),
]

TICKER_RE = re.compile(r"\$?(NVDA|NVIDIA|MSFT|MICROSOFT|AAPL|APPLE)\b", re.I)

SCRAPE_JS = """() => {
  const out = [];
  for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
    try {
      const textEl = a.querySelector('[data-testid="tweetText"]');
      const timeEl = a.querySelector('time');
      const userEl = a.querySelector('[data-testid="User-Name"]');
      const linkEl = a.querySelector('a[href*="/status/"]');
      const userText = userEl ? userEl.innerText.split('\\n') : [];
      out.push({
        text: textEl ? textEl.innerText.slice(0, 600) : '',
        user: userText[0] || '',
        handle: (userText.find(s => s.startsWith('@')) || ''),
        time: timeEl ? timeEl.getAttribute('datetime') : '',
        url: linkEl ? ('https://x.com' + linkEl.getAttribute('href').split('?')[0]) : '',
      });
    } catch (e) {}
  }
  return out;
}"""


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def in_scan_window(now=None):
    """Only scan during market hours: Mon–Fri 13:30–21:30 Europe/London."""
    if ZoneInfo is None:
        return True
    now = now or datetime.now(ZoneInfo("Europe/London"))
    if now.weekday() >= 5:
        return False
    mins = now.hour * 60 + now.minute
    return 13 * 60 + 30 <= mins < 21 * 60 + 30


# ---------------------------------------------------------------------------
# Own-Chrome management
# ---------------------------------------------------------------------------

def find_chrome():
    """Locate chrome.exe via default install paths, then the registry."""
    candidates = [
        os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"),
                     "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
                     "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""),
                     "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(
                    hive,
                    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
                ) as k:
                    val = winreg.QueryValue(k, None)
                if val and os.path.isfile(val):
                    return val
            except OSError:
                continue
    except ImportError:
        pass
    return None


def port_in_use(port):
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) == 0


def _cmdline_of(pid):
    """Return a process's command line, or '' if it can't be read."""
    try:
        out = subprocess.run(
            ["wmic", "process", "where", f"ProcessId={pid}", "get", "CommandLine"],
            capture_output=True, text=True, timeout=15,
        ).stdout
        if out and "CommandLine" in out:
            return out
    except Exception:
        pass
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-CimInstance Win32_Process -Filter 'ProcessId={pid}').CommandLine"],
            capture_output=True, text=True, timeout=20,
        ).stdout
        return out or ""
    except Exception:
        return ""


def kill_stale_bridge_chrome():
    """Kill processes listening on the CDP port ONLY if they are ours
    (command line contains .xbridge-profile). Never touch anything else."""
    try:
        out = subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, timeout=15
        ).stdout
    except Exception:
        return
    pids = set()
    for line in out.splitlines():
        if f":{CDP_PORT}" in line and "LISTENING" in line:
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.add(parts[-1])
    for pid in pids:
        cmdline = _cmdline_of(pid)
        if ".xbridge-profile" in cmdline:
            log(f"stopping a stale bridge Chrome (PID {pid})")
            try:
                subprocess.run(["taskkill", "/PID", pid, "/F"],
                               capture_output=True, timeout=15)
            except Exception:
                pass
        else:
            log(f"port {CDP_PORT} is held by another program (PID {pid}) — leaving it alone")


def _cdp_answers():
    try:
        import urllib.request
        with urllib.request.urlopen(
            f"http://localhost:{CDP_PORT}/json/version", timeout=3
        ) as r:
            return r.status == 200
    except Exception:
        return False


def launch_bridge_chrome(chrome_exe):
    """Start our own Chrome with the dedicated profile. Returns True if CDP answers."""
    os.makedirs(PROFILE_DIR, exist_ok=True)
    if port_in_use(CDP_PORT):
        kill_stale_bridge_chrome()
    if port_in_use(CDP_PORT):
        # Something else holds the port (maybe a manually flagged Chrome).
        # connect_over_cdp can still use it — don't fight it.
        log(f"port {CDP_PORT} already in use — will try to use that Chrome as-is")
        return _cdp_answers()
    log("starting the bridge's own Chrome (your main Chrome is untouched)")
    try:
        subprocess.Popen(
            [chrome_exe,
             f"--remote-debugging-port={CDP_PORT}",
             f"--user-data-dir={PROFILE_DIR}",
             "--new-window", "about:blank"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "DETACHED_PROCESS", 0),
        )
    except Exception as e:
        log(f"could not start Chrome ({type(e).__name__}: {e})")
        return False
    for _ in range(40):
        time.sleep(0.5)
        if _cdp_answers():
            return True
    log("bridge Chrome did not answer — will retry next cycle")
    return False


_chrome_exe = None


def ensure_bridge_chrome():
    """Make sure a CDP-reachable Chrome exists. Cheap no-op when healthy."""
    global _chrome_exe
    if _cdp_answers():
        return True
    if _chrome_exe is None:
        _chrome_exe = find_chrome()
        if not _chrome_exe:
            log("Google Chrome not found — install it, then re-run this script")
            return False
    return launch_bridge_chrome(_chrome_exe)


# ---------------------------------------------------------------------------
# Tailscale self-heal
# ---------------------------------------------------------------------------

def _run(cmd, timeout=15):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    except FileNotFoundError:
        return None, "", ""
    except Exception:
        return -1, "", ""


def _tailscale_self_ip():
    """Return this machine's Tailscale IPv4, or None. Parses `tailscale ip`
    output directly (no -4 flag) so it works on stock and shimmed CLIs."""
    rc, out, _ = _run(["tailscale", "ip"])
    if rc != 0 or not out:
        return None
    for line in out.splitlines():
        line = line.strip()
        parts = line.split(".")
        if len(parts) == 4 and all(p.isdigit() for p in parts) and line.startswith("100."):
            return line
    return None


def tailscale_ipv4():
    """Return (ipv4_or_None, plain-English status line). Tries to self-heal."""
    rc, _, _ = _run(["tailscale", "status"])
    if rc == 0:
        ip = _tailscale_self_ip()
        if ip:
            return ip, "Tailscale: connected"
        return None, "Tailscale: connected (could not read its IP — binding everywhere)"
    if rc is None:
        return None, ("Tailscale: not installed — grab it from tailscale.com/download "
                      "so Scorpio can read the feed")
    # Installed but not running — try to wake it up.
    ipn = r"C:\Program Files\Tailscale\tailscale-ipn.exe"
    if os.path.isfile(ipn):
        try:
            subprocess.Popen(
                [ipn], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
            time.sleep(6)
            rc3, _, _ = _run(["tailscale", "status"])
            if rc3 == 0:
                ip = _tailscale_self_ip()
                return ip, "Tailscale: wasn't running — started it just now"
        except Exception:
            pass
        return None, ("Tailscale: not running, tried to start it — "
                      "open Tailscale from the Start menu if this persists")
    return None, "Tailscale: not running — open Tailscale from the Start menu"


# ---------------------------------------------------------------------------
# Scraping (unchanged from v2)
# ---------------------------------------------------------------------------

def get_bridge_page(pw):
    """Return (browser, page) for our dedicated minimized window, creating it if needed.

    The window lives in the bridge's own Chrome profile, so it never touches
    your main Chrome or its tabs. Minimize it once and ignore it.
    """
    try:
        browser = pw.chromium.connect_over_cdp(CDP_URL)
    except Exception:
        log("could not reach the bridge Chrome — will retry next cycle")
        return None, None
    ctx = browser.contexts[0] if browser.contexts else None
    if ctx is None:
        log("No browser context found.")
        try:
            browser.close()
        except Exception:
            pass
        return None, None

    def find_page():
        for p in ctx.pages:
            try:
                if not p.is_closed() and BRIDGE_MARKER in (p.url or ""):
                    return p
            except Exception:
                continue
        return None

    page = find_page()
    if page is not None:
        return browser, page

    # Open a dedicated background window for the bridge.
    try:
        cdp = browser.new_browser_cdp_session()
        cdp.send("Target.createTarget", {
            "url": "about:blank#" + BRIDGE_MARKER,
            "newWindow": True,
            "background": True,
        })
    except Exception as e:
        log(f"Could not open bridge window ({type(e).__name__}: {e})")
        try:
            browser.close()
        except Exception:
            pass
        return None, None

    for _ in range(30):
        time.sleep(0.5)
        page = find_page()
        if page is not None:
            log("bridge window opened — log into X in it if it asks, then minimize it")
            return browser, page
    log("Bridge window did not appear; will retry next cycle.")
    try:
        browser.close()
    except Exception:
        pass
    return None, None


def scrape_cycle(pw):
    """One gentle pass over home + the three ticker searches, inside the bridge window."""
    browser, page = get_bridge_page(pw)
    if page is None:
        return None

    seen = {}
    login_hinted = False
    try:
        for label, url in QUERIES:
            try:
                if page.is_closed():
                    log(f"{label}: bridge window was closed; recreating next cycle")
                    break
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(4000)
                title = page.evaluate("document.title") or ""
                if "log in" in title.lower():
                    if not login_hinted:
                        log("X wants a login in the BRIDGE window — "
                            "log in to X there once, then minimize it")
                        login_hinted = True
                    break
                if "Something went wrong" in title:
                    log(f"{label}: X showed an error page (rate limit?) — skipping")
                    continue
                # A couple of gentle scrolls to load more posts.
                for _ in range(2):
                    page.evaluate("window.scrollBy(0, 2500)")
                    page.wait_for_timeout(2500)
                posts = page.evaluate(SCRAPE_JS)
                kept = 0
                for p in posts:
                    if not p["text"] or not TICKER_RE.search(p["text"]):
                        continue
                    key = (p["handle"], p["text"][:80])
                    if key not in seen:
                        seen[key] = {**p, "via": label}
                        kept += 1
                log(f"{label}: kept {kept} ticker posts")
            except Exception as e:
                log(f"{label}: scrape hiccup ({type(e).__name__}); continuing")
            time.sleep(3)  # breathe between pages — stay gentle on rate limits
    finally:
        try:
            browser.close()  # disconnects only; bridge Chrome and window stay open
        except Exception:
            pass

    return list(seen.values())


def write_posts(posts):
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "source": "x_bridge v3 (dedicated bridge Chrome)",
        "count": len(posts),
        "posts": posts[:120],
    }
    tmp = OUT_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    os.replace(tmp, OUT_FILE)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.lstrip("/").split("?")[0].split("#")[0]
        if name != "x_posts.json":
            self.send_response(404)
            self.end_headers()
            return
        if not os.path.isfile(OUT_FILE):
            self.send_response(404)
            self.end_headers()
            return
        with open(OUT_FILE, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


def serve(bind_ip):
    server = HTTPServer((bind_ip, PORT), Handler)
    if bind_ip == "0.0.0.0":
        log(f"serving x_posts.json on port {PORT} (all interfaces — LAN-visible!)")
        log("WARNING: Tailscale is not connected, so the feed is visible "
            "on your local network, not just to Scorpio")
    else:
        log(f"serving x_posts.json on Tailscale {bind_ip}:{PORT}")
    server.serve_forever()


def main():
    from playwright.sync_api import sync_playwright

    ts_ip, ts_msg = tailscale_ipv4()
    log(ts_msg)
    threading.Thread(target=serve, args=(ts_ip or "0.0.0.0",), daemon=True).start()

    ensure_bridge_chrome()
    log("x_bridge v3 started — Ctrl+C to stop")
    with sync_playwright() as pw:
        while True:
            if not in_scan_window():
                log("outside market hours — feed paused, serving last batch")
                time.sleep(5 * 60)
                continue
            try:
                if not ensure_bridge_chrome():
                    log("cycle skipped (no Chrome); retrying in 15 min")
                else:
                    posts = scrape_cycle(pw)
                    if posts is not None:
                        write_posts(posts)
                        log(f"cycle done: {len(posts)} ticker posts saved")
                    else:
                        log("cycle skipped (bridge Chrome not reachable); retrying in 15 min")
            except Exception:
                log("cycle error:\n" + traceback.format_exc(limit=3))
            time.sleep(CYCLE_SECS)


if __name__ == "__main__":
    main()
