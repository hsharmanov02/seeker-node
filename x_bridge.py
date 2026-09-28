"""X bridge — lets Scorpio read YOUR logged-in X feed for stock alerts.

What it does:
  1. Attaches to your already-running Chrome (started with
     --remote-debugging-port=9222) — no new login, uses your X session.
  2. Opens ONE dedicated bridge window (a separate Chrome window, not a tab
     in your main window). Minimize it once and ignore it forever — all
     scanning happens in there, so your main window is never touched.
  3. During market hours (Mon–Fri, 13:30–21:30 London) it quietly loads,
     every 15 minutes: your Home timeline plus Latest searches for
     $NVDA, $MSFT and $AAPL, and copies out recent posts mentioning them.
     Outside market hours it just keeps serving the last batch.
  4. Saves them to x_posts.json and serves ONLY that file on port 8898,
     so Scorpio can fetch it over your Tailscale network.

What it does NOT do:
  - It never posts, likes, follows, or sends DMs. Read-only.
  - It never touches your passwords or DMs; it only reads public timeline text.
  - It never opens tabs in your main Chrome window.

One-time setup:
  1. Right-click your Chrome shortcut -> Properties -> Target, and add
     --remote-debugging-port=9222 at the end (after chrome.exe").
     Example: "C:\\...\\chrome.exe" --remote-debugging-port=9222
  2. Restart Chrome with that shortcut and log in to X as normal.
  3. Double-click x_bridge.bat (installs the `playwright` package once,
     then starts this script). A small extra Chrome window appears —
     minimize it and leave it alone. Leave the script window open while
     you want Scorpio to see your feed.

Stop any time with Ctrl+C. Nothing is uploaded anywhere except your own
Tailscale network (x_posts.json on port 8898).
"""

import json
import os
import re
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
PORT = 8898
CDP_URL = "http://localhost:9222"
CYCLE_SECS = 15 * 60
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


def get_bridge_page(pw):
    """Return (browser, page) for our dedicated minimized window, creating it if needed.

    The window is a real separate Chrome window in the same profile, so it
    shares your X login — but it is NOT your main window, so scanning never
    steals your tabs. Minimize it once and ignore it.
    """
    try:
        browser = pw.chromium.connect_over_cdp(CDP_URL)
    except Exception:
        log("Could not reach Chrome. Is it running with --remote-debugging-port=9222?")
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
            log("bridge window opened — minimize it once and ignore it from now on")
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
    try:
        for label, url in QUERIES:
            try:
                if page.is_closed():
                    log(f"{label}: bridge window was closed; recreating next cycle")
                    break
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(4000)
                title = page.evaluate("document.title") or ""
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
            browser.close()  # disconnects only; his Chrome and bridge window stay open
        except Exception:
            pass

    return list(seen.values())


def write_posts(posts):
    payload = {
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "source": "x_bridge (Haste's logged-in X)",
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


def serve():
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    log(f"serving x_posts.json on port {PORT} (Tailscale only, hopefully)")
    server.serve_forever()


def main():
    from playwright.sync_api import sync_playwright

    threading.Thread(target=serve, daemon=True).start()
    log("x_bridge started — Ctrl+C to stop")
    with sync_playwright() as pw:
        while True:
            if not in_scan_window():
                log("outside market hours — feed paused, serving last batch")
                time.sleep(5 * 60)
                continue
            try:
                posts = scrape_cycle(pw)
                if posts is not None:
                    write_posts(posts)
                    log(f"cycle done: {len(posts)} ticker posts saved")
                else:
                    log("cycle skipped (Chrome not reachable); retrying in 15 min")
            except Exception:
                log("cycle error:\n" + traceback.format_exc(limit=3))
            time.sleep(CYCLE_SECS)


if __name__ == "__main__":
    main()
