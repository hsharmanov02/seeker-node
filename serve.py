"""Serve ONLY the node's telemetry over the local network / tailnet.

Run:  python3 serve.py        (serves on port 8899)
Stop: Ctrl+C

Exposes exactly three files, nothing else:
  - status.json
  - opportunities.jsonl
  - node.log

Everything else returns 404 — notably config.json is NEVER served,
because it may hold your Telegram bot token one day.

Point Scorpio at:  http://<this-machine's-tailscale-ip>:8899/status.json
"""

import os
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ALLOWED = {"status.json", "opportunities.jsonl", "node.log"}
PORT = 8899


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        name = self.path.lstrip("/").split("?")[0].split("#")[0]
        if name not in ALLOWED:
            self.send_response(404)
            self.end_headers()
            return
        path = os.path.join(BASE_DIR, name)
        if not os.path.isfile(path):
            self.send_response(404)
            self.end_headers()
            return
        with open(path, "rb") as f:
            body = f.read()
        ctype = "application/json" if name.endswith(".json") else "text/plain; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass  # keep the terminal clean


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"telemetry server on port {PORT} — serving: {', '.join(sorted(ALLOWED))}")
    print("stop with Ctrl+C")
    server.serve_forever()
