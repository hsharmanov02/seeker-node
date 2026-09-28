"""X bridge — lets Scorpio read YOUR logged-in X feed for stock alerts.

What it does:
  1. Attaches to your already-running Chrome (started with
     --remote-debugging-port=9222) — no new login, uses your X session.
  2. Every 15 minutes it quietly opens background tabs: your Home timeline
     plus Latest searches for $NVDA, $MSFT and $AAPL, and copies out the
     recent posts mentioning those tickers.
  3. Saves them to x_posts.json and serves ONLY that file on port 8898,
     so Scorpio can fetch it over your Tailscale network.

What it does NOT do:
  - It never posts, likes, follows, or sends DMs. Read-only.
  - It never touches your passwords or DMs; it only reads public timeline text.
  - It opens at most 4 lightweight pages per cycle, then closes the tabs,
    to stay gentle on X's rate limits.

One-time setup:
  1. Right-click your Chrome shortcut -> Properties -> Target, and add
     --remote-debugging-port=9222 at the end (after chrome.exe").
     Example: "C:\\...\\chrome.exe" --remote-debugging-port=9222
  2. Restart Chrome with that shortcut and log in to X as normal.
  3. Double-click x_bridge.bat (installs the `playwright` package once,
     then starts this script). Leave the window open while you want
     Scorpio to see your feed.

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

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
OUT_FILE = os.path.join(BASE_DIR, "x_posts.json")
PORT = 8898
CDP_URL = "http://localhost:9222"
CYCLE_SECS = 15 * 60

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


def scrape_cycle(pw):
    """One gentle pass over home + the three ticker searches."""
    try:
        browser = pw.chromium.connect_over_cdp(CDP_URL)
    except Exception:
        log("Could not reach Chrome. Is it running with --remote-debugging-port=9222?")
        return None
    ctx = browser.contexts[0] if browser.contexts else None
    if ctx is None:
        log("No browser context found.")
        return None

    seen = {}
    try:
        for label, url in QUERIES:
            page = ctx.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(4000)
                if "Something went wrong" in page.title():
                    log(f"{label}: X showed an error page (rate limit?) — skipping")
                    continue
                # A couple of gentle scrolls to load more posts.
                for _ in range(2):
                    page.mouse.wheel(0, 2500)
                    page.wait_for_timeout(2500)
                posts = page.evaluate(SCRAPE_JS)
                for p in posts:
                    if not p["text"] or not TICKER_RE.search(p["text"]):
                        continue
                    key = (p["handle"], p["text"][:80])
                    if key not in seen:
                        seen[key] = {**p, "via": label}
                log(f"{label}: kept {len([p for p in posts if p['text'] and TICKER_RE.search(p['text'])])} ticker posts")
            except Exception as e:
                log(f"{label}: scrape hiccup ({type(e).__name__}); continuing")
            finally:
                page.close()
            time.sleep(3)  # breathe between pages — stay gentle on rate limits
    finally:
        browser.close()

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
