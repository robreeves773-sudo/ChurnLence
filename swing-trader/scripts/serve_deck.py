"""Serve the Swing Deck dashboard, relaying /api/* to the local Freqtrade bot.

Because the page and the API share one address, this works identically on
the PC and on a phone — no CORS, no per-device setup. Auth still happens
against the bot (username/password from config-private.json).

Usage:
    python scripts/serve_deck.py          # this PC only (127.0.0.1:8082)
    python scripts/serve_deck.py --lan    # also phones/tablets on home Wi-Fi
"""
import socket
import sys
import urllib.error
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

DASH = Path(__file__).resolve().parent.parent / "dashboard"
BOT = "http://127.0.0.1:8080"
PORT = 8082


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DASH), **kwargs)

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._proxy("GET")
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._proxy("POST")
        else:
            self.send_error(404)

    def _proxy(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(BOT + self.path, data=body, method=method)
        for h in ("Authorization", "Content-Type"):
            if self.headers.get(h):
                req.add_header(h, self.headers[h])
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read()
                self._reply(r.status, r.headers.get("Content-Type"), data)
        except urllib.error.HTTPError as e:
            self._reply(e.code, e.headers.get("Content-Type"), e.read())
        except Exception:
            self._reply(502, "application/json",
                        b'{"detail": "Bot not reachable - is 4-start-dryrun.bat running?"}')

    def _reply(self, code, ctype, data):
        try:
            self.send_response(code)
            self.send_header("Content-Type", ctype or "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, *args):
        pass


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no traffic sent; just picks the LAN interface
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    lan = "--lan" in sys.argv
    bind = "0.0.0.0" if lan else "127.0.0.1"
    print("=" * 56)
    print("  Swing Deck is running.")
    print("  On this PC:    http://127.0.0.1:%d" % PORT)
    if lan:
        ip = lan_ip()
        if ip:
            print("  On your PHONE: http://%s:%d" % (ip, PORT))
            print("  (Phone must be on the same Wi-Fi as this PC.)")
            print("  If Windows asks about the firewall, click Allow")
            print("  for PRIVATE networks.")
        else:
            print("  Could not detect a Wi-Fi/LAN address - is this PC online?")
    print("  Leave this window open. Ctrl+C stops it.")
    print("=" * 56)
    ThreadingHTTPServer((bind, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
