"""Seeker: RemoteOK public job API (no auth).

RemoteOK publishes a public JSON feed of remote jobs. We filter it by
your keywords and surface matching posts as opportunities.
"""

import json
import urllib.request

from .base import Seeker
from telemetry import log

API = "https://remoteok.com/api"
TIMEOUT = 12


class RemoteOKSeeker(Seeker):
    name = "remoteok"

    def find(self, config):
        try:
            return self._find(config)
        except Exception as e:  # never crash the node
            log(f"[{self.name}] failed: {e}")
            return []

    def _find(self, config):
        keywords = [k.lower() for k in config.get("keywords", [])]

        req = urllib.request.Request(
            API,
            headers={"User-Agent": "seeker-node/1.0 (job discovery)"},
        )
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))

        opps = []
        for job in data:
            if not isinstance(job, dict) or "id" not in job:
                continue  # first element is metadata
            hay = " ".join([
                str(job.get("position", "")),
                str(job.get("company", "")),
                " ".join(job.get("tags", []) or []),
                str(job.get("description", ""))[:500],
            ]).lower()
            if not any(k in hay for k in keywords):
                continue
            opps.append({
                "id": f"rok-{job['id']}",
                "source": self.name,
                "title": f"{job.get('position', '?')} @ {job.get('company', '?')}",
                "url": job.get("url", "https://remoteok.com"),
                "snippet": " ".join(job.get("tags", []) or [])[:300],
            })
        log(f"[{self.name}] scanned feed, {len(opps)} matched")
        return opps
