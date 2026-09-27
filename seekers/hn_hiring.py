"""Seeker: Hacker News monthly 'Who is hiring?' thread.

Uses only public, no-auth APIs:
  - Algolia HN search to find the latest hiring thread
  - Firebase HN API to read comments

Finds comments matching your keywords (e.g. security, python, junior,
contract, remote) — these are real people saying "I will pay someone".
"""

import json
import re
import urllib.parse
import urllib.request

from .base import Seeker
from telemetry import log

ALGOLIA = "https://hn.algolia.com/api/v1/search"
FIREBASE = "https://hacker-news.firebaseio.com/v0/item/{}.json"
TIMEOUT = 12


def _get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "seeker-node/1.0"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _strip_html(text):
    text = re.sub(r"<[^>]+>", " ", text or "")
    text = re.sub(r"\s+", " ", text).strip()
    return text


class HNHiringSeeker(Seeker):
    name = "hn_hiring"

    def find(self, config):
        try:
            return self._find(config)
        except Exception as e:  # never crash the node
            log(f"[{self.name}] failed: {e}")
            return []

    def _find(self, config):
        keywords = [k.lower() for k in config.get("keywords", [])]
        max_comments = int(config.get("max_comments_per_run", 40))

        # 1. Find the latest "Who is hiring" thread
        q = urllib.parse.urlencode({"tags": "story", "query": "who is hiring"})
        data = _get_json(f"{ALGOLIA}?{q}")
        thread_id = None
        for hit in data.get("hits", []):
            title = (hit.get("title") or "").lower()
            if "who is hiring" in title:
                thread_id = hit["objectID"]
                break
        if not thread_id:
            log(f"[{self.name}] no hiring thread found")
            return []

        # 2. Get comment ids
        thread = _get_json(FIREBASE.format(thread_id))
        kids = thread.get("kids", [])[:max_comments]

        # 3. Scan comments for keyword matches
        opps = []
        for kid in kids:
            try:
                item = _get_json(FIREBASE.format(kid))
            except Exception:
                continue
            text = _strip_html(item.get("text", ""))
            low = text.lower()
            if not text or not any(k in low for k in keywords):
                continue
            opps.append({
                "id": f"hn-{kid}",
                "source": self.name,
                "title": (text[:80] + "…") if len(text) > 80 else text,
                "url": f"https://news.ycombinator.com/item?id={kid}",
                "snippet": text[:300],
            })
        log(f"[{self.name}] scanned {len(kids)} comments, {len(opps)} matched")
        return opps
