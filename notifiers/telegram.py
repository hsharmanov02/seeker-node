"""Telegram alerts: the node pings YOUR phone when it finds new leads.

Setup (2 minutes, free):
  1. On Telegram, message @BotFather -> /newbot -> pick a name -> get a token
  2. Message your new bot anything (e.g. "hi")
  3. Visit https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
     and find your numeric "chat" -> "id"
  4. Put both in config.json under "telegram"

No token configured? The notifier silently skips — the node works fine
without it.
"""

import urllib.parse
import urllib.request

from telemetry import log

TIMEOUT = 12


def send(config, text):
    """Send a Telegram message. Returns True on success, False otherwise."""
    tg = config.get("telegram", {}) or {}
    token = tg.get("bot_token", "")
    chat_id = tg.get("chat_id", "")
    if not token or not chat_id:
        return False  # not configured — silent skip
    try:
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        data = urllib.parse.urlencode(
            {"chat_id": chat_id, "text": text}
        ).encode()
        req = urllib.request.Request(url, data=data)
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            ok = resp.status == 200
            if not ok:
                log(f"[telegram] HTTP {resp.status}")
            return ok
    except Exception as e:
        log(f"[telegram] failed: {e}")
        return False


def notify_new_opportunities(config, new_opps):
    """Ping the user with the newest leads. Never raises."""
    try:
        if not new_opps:
            return
        lines = [f"Seeker node: {len(new_opps)} new lead(s)"]
        for o in new_opps[:5]:
            lines.append(f"- {o.get('title', '?')}\n  {o.get('url', '')}")
        if len(new_opps) > 5:
            lines.append(
                f"...and {len(new_opps) - 5} more. "
                "Run monitor.py --report for the full list."
            )
        if send(config, "\n".join(lines)):
            log(f"[telegram] alert sent ({len(new_opps)} leads)")
    except Exception as e:
        log(f"[telegram] notify failed: {e}")
