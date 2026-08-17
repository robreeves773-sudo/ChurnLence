"""Verify your Webot/Pionex API keys work before enabling live trading.

Usage:  python check_setup.py
Reads PIONEX_API_KEY / PIONEX_API_SECRET (and optional PIONEX_BASE_URL)
from the environment or a .env file, then fetches your account balances.
This is a read-only call — it places no orders.
"""

import os
import sys

from dotenv import load_dotenv

from pionex import PionexClient, PionexError

load_dotenv()

key = os.environ.get("PIONEX_API_KEY")
secret = os.environ.get("PIONEX_API_SECRET")
if not key or not secret:
    sys.exit("Set PIONEX_API_KEY and PIONEX_API_SECRET first (see .env.example).")

client = PionexClient(key, secret, base_url=os.environ.get("PIONEX_BASE_URL", "https://api.pionex.com"))
try:
    balances = client.get_balances()
except PionexError as exc:
    sys.exit(f"FAILED — auth or connectivity problem:\n  {exc}\n"
             "Check the key/secret, and confirm the base URL matches where the key was created.")

print("SUCCESS — API keys work. Free balances:")
for coin, amount in sorted(balances.items()):
    if amount:
        print(f"  {coin}: {amount}")
if not any(balances.values()):
    print("  (all zero)")
