"""Create (or rotate) user_data/config-private.json.

This file holds the machine-local secrets for the Freqtrade API server
(dashboard login, JWT signing key, websocket token). It is generated fresh
on each machine and is gitignored — secrets never enter git history.

Usage:
    python scripts/make_private_config.py           # create if missing
    python scripts/make_private_config.py --rotate  # force new secrets
"""
import json
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "user_data" / "config-private.json"


def fresh_config():
    return {
        "api_server": {
            "username": "rob",
            "password": "SwingTrader-" + secrets.token_hex(8),
            "jwt_secret_key": secrets.token_hex(32),
            "ws_token": secrets.token_hex(16),
        }
    }


def main():
    rotate = "--rotate" in sys.argv
    if TARGET.exists() and not rotate:
        print(f"OK: {TARGET.name} already exists (run with --rotate for new secrets).")
        return
    cfg = fresh_config()
    TARGET.write_text(json.dumps(cfg, indent=4) + "\n", encoding="utf-8")
    verb = "Rotated" if rotate else "Created"
    print(f"{verb} {TARGET}")
    print("Dashboard login -> user: rob")
    print("            password: " + cfg["api_server"]["password"])
    print("(Also stored in that file if you forget it.)")


if __name__ == "__main__":
    main()
